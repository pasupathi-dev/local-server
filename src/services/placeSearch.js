// Place search — typeahead used by the "Change location" modal on the
// customer / partner home.
//
// Strategy:
//   1. Google Places Autocomplete (+ Details for lat/lng) — when
//      GOOGLE_MAPS_API_KEY is set. Autocomplete is built for "user is
//      still typing" queries and handles natural-language inputs with
//      multiple location qualifiers ("nagercoil kotter sivaram school")
//      far better than OSM-based engines.
//   2. Photon (komoot) — free, fuzzy. We fan out across multiple query
//      VARIANTS (full + tail substrings + capitalised) and merge the
//      unique hits. This catches the common case where the full string
//      misses but the trailing "sivaram school" lands the right place.
//   3. Nominatim — strict OSM matcher, same fan-out, last resort.
//
// All three normalise to:
//   { place_id, display_name, city, lat, lng, type?, importance? }

// Identifying User-Agent for upstream APIs that require one (Nominatim
// usage policy especially). Override via UPSTREAM_UA env when forking
// this app — Nominatim will block the default if too many installs
// hammer it with the same string.
const UA = process.env.UPSTREAM_UA
  // || 'ServiceLink/1.0 (https://senang.io; product@senang.io)'

// External provider endpoints. Override only if you're mirroring the
// upstream (e.g. self-hosted Nominatim / Photon for higher quotas).
const PHOTON_ENDPOINT    = process.env.PHOTON_ENDPOINT    || 'https://photon.komoot.io/api/'
const NOMINATIM_ENDPOINT = process.env.NOMINATIM_ENDPOINT || 'https://nominatim.openstreetmap.org/search'
const GOOGLE_AC_ENDPOINT = 'https://maps.googleapis.com/maps/api/place/autocomplete/json'
const GOOGLE_DETAILS_ENDPOINT = 'https://maps.googleapis.com/maps/api/place/details/json'

// Country code passed to OSM-backed providers for default biasing. Set
// COUNTRY_CODE=us / au / etc for non-India deployments.
const COUNTRY_CODE = process.env.COUNTRY_CODE || 'in'
// Bounding-box bias for fuzzy search (Photon). Format: "minLon,minLat,maxLon,maxLat".
// Default covers India; override for other regions.
const COUNTRY_BBOX = process.env.COUNTRY_BBOX || '68,7,98,38'

// ── Caching ────────────────────────────────────────────────────────────
// In-memory LRU-ish cache. Tune via env if you want longer/shorter TTLs
// (e.g. lower the TTL during testing to see fresh results faster).
const cache = new Map()
const CACHE_TTL_MS = Number(process.env.PLACE_SEARCH_CACHE_TTL_MS) || (5 * 60 * 1000)
const CACHE_MAX    = Number(process.env.PLACE_SEARCH_CACHE_MAX)    || 200

function cacheGet (key) {
  const hit = cache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null }
  return hit.value
}
function cacheSet (key, value) {
  cache.set(key, { value, at: Date.now() })
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
}

// ── Query normalisation + variants ────────────────────────────────────
// Title-case each token. Place engines weight queries with proper case
// higher than all-lowercase ones; converting "kotter" → "Kotter" alone
// can flip a no-match into a hit.
function titleCase (s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
}

// Build a small set of query variants to try in parallel. We always
// include the original (in case the engine prefers the user's casing),
// the title-cased version, and progressive tail substrings. Landmark
// names tend to sit at the *end* of natural-language place queries like
// "nagercoil kotter sivaram school" — the tail "sivaram school" is the
// right needle to match.
function queryVariants (raw) {
  const cleaned = String(raw || '').trim().replace(/\s+/g, ' ')
  if (!cleaned) return []
  const tokens = cleaned.split(' ')
  const variants = new Set()
  variants.add(cleaned)
  variants.add(titleCase(cleaned))
  if (tokens.length >= 3) variants.add(tokens.slice(-3).join(' '))
  if (tokens.length >= 2) variants.add(tokens.slice(-2).join(' '))
  if (tokens.length >= 4) variants.add(tokens.slice(0, 2).join(' '))
  return [...variants]
}

// Merge result arrays from multiple variants, keeping the highest-ranked
// unique place. Earlier variants count as higher rank.
function mergeResults (lists) {
  const seen = new Map()
  lists.forEach((rows, listIdx) => {
    if (!Array.isArray(rows)) return
    rows.forEach((r, rowIdx) => {
      if (!r?.place_id) return
      const score = (1000 - listIdx * 50) - rowIdx
      const existing = seen.get(r.place_id)
      if (!existing || score > existing.score) {
        seen.set(r.place_id, { ...r, score })
      }
    })
  })
  return [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ score, ...rest }) => rest)
}

// ── Google Places Autocomplete + Details ──────────────────────────────
// Why Autocomplete instead of Text Search: autocomplete is built for
// "user is still typing" queries — handles natural language, multiple
// qualifiers, partial words. Text Search behaves more like a Yelp lookup.
// Autocomplete returns predictions only; we follow up with parallel
// Place Details calls to resolve lat/lng + components.
async function searchGoogleAutocomplete (q, { limit }) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) return null
  const acUrl = `${GOOGLE_AC_ENDPOINT}`
    + `?input=${encodeURIComponent(q)}`
    + `&components=country:${COUNTRY_CODE}`
    + `&types=geocode|establishment`
    + `&key=${apiKey}`
  let acJson
  try {
    const res = await fetch(acUrl)
    if (!res.ok) return null
    acJson = await res.json()
  } catch (err) {
    console.warn('[placeSearch] Google AC fetch failed:', err.message)
    return null
  }
  if (acJson.status !== 'OK' && acJson.status !== 'ZERO_RESULTS') {
    console.warn('[placeSearch] Google AC status:', acJson.status, acJson.error_message)
    return null
  }
  const predictions = (acJson.predictions || []).slice(0, limit)
  if (!predictions.length) return []

  // Resolve lat/lng for each prediction in parallel.
  const detailFields = 'place_id,name,formatted_address,geometry,address_components,types'
  const detailUrl = (pid) =>
    `${GOOGLE_DETAILS_ENDPOINT}`
      + `?place_id=${encodeURIComponent(pid)}`
      + `&fields=${detailFields}`
      + `&key=${apiKey}`
  const details = await Promise.all(predictions.map(async (p) => {
    try {
      const res = await fetch(detailUrl(p.place_id))
      if (!res.ok) return null
      const j = await res.json()
      if (j.status !== 'OK' || !j.result) return null
      const r = j.result
      const lat = Number(r.geometry?.location?.lat)
      const lng = Number(r.geometry?.location?.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null

      const comps = r.address_components || []
      const compByType = (type) =>
        comps.find((c) => (c.types || []).includes(type))?.long_name || null
      const city = compByType('locality')
        || compByType('administrative_area_level_3')
        || compByType('administrative_area_level_2')
        || compByType('administrative_area_level_1')
        || null

      return {
        place_id:     `g:${r.place_id}`,
        display_name: r.formatted_address || r.name,
        city:         city || (p.structured_formatting?.main_text || null),
        lat, lng,
        type:         r.types?.[0] || null,
        importance:   0,
      }
    } catch { return null }
  }))
  return details.filter(Boolean)
}

// ── Photon (komoot) — fuzzy autocomplete on OSM ───────────────────────
async function searchPhoton (q, { limit }) {
  const params = new URLSearchParams({
    q, lang: 'en', limit: String(limit),
    bbox: COUNTRY_BBOX,
  })
  const url = `${PHOTON_ENDPOINT}?${params.toString()}`
  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': UA },
    })
  } catch (err) {
    console.warn('[placeSearch] Photon fetch failed:', err.message)
    return null
  }
  if (!res.ok) return null
  let json
  try { json = await res.json() } catch { return null }
  const features = Array.isArray(json?.features) ? json.features : []
  return features.map((f) => {
    const [lng, lat] = f.geometry?.coordinates || []
    const p = f.properties || {}
    const city = p.city || p.town || p.village || p.county || p.state || p.name
    const segments = [p.name, p.city || p.town || p.village, p.state, p.country]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
    return {
      place_id:     `p:${p.osm_type || ''}${p.osm_id || ''}`,
      display_name: segments.join(', '),
      city,
      lat: Number(lat),
      lng: Number(lng),
      type:       p.type || p.osm_value || null,
      importance: 0,
    }
  }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))
}

// ── Nominatim — strict OSM search, last-resort fallback ────────────────
async function searchNominatim (q, { limit }) {
  const params = new URLSearchParams({
    q,
    format: 'json',
    addressdetails: '1',
    limit: String(limit),
    countrycodes: COUNTRY_CODE,
  })
  const url = `${NOMINATIM_ENDPOINT}?${params.toString()}`
  let res
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Accept-Language': 'en',
      },
    })
  } catch (err) {
    console.warn('[placeSearch] Nominatim fetch failed:', err.message)
    return null
  }
  if (!res.ok) return null
  let raw
  try { raw = await res.json() } catch { return null }
  if (!Array.isArray(raw)) return null
  return raw.map((r) => {
    const a = r.address || {}
    const city = a.city || a.town || a.village || a.municipality
      || a.county || a.state_district || a.state || null
    return {
      place_id:     `n:${r.place_id}`,
      display_name: r.display_name,
      city,
      lat: Number(r.lat),
      lng: Number(r.lon),
      type: r.type || null,
      importance: Number(r.importance) || 0,
    }
  }).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng))
}

// ── Public entry point ────────────────────────────────────────────────
// 1) Google Autocomplete with the original query — handles natural language.
// 2) Photon with multiple variants (full + tail subs + capitalised) merged.
// 3) Nominatim with the same fan-out as last resort.
async function searchPlaces (q, { limit = 6 } = {}) {
  const query = String(q || '').trim().replace(/\s+/g, ' ')
  if (query.length < 2) return []

  const cacheKey = `${query.toLowerCase()}::${limit}`
  const cached = cacheGet(cacheKey)
  if (cached) return cached

  // 1) Google Autocomplete — best at natural-language queries.
  try {
    const g = await searchGoogleAutocomplete(query, { limit })
    if (g && g.length) {
      cacheSet(cacheKey, g)
      return g
    }
  } catch (err) {
    console.warn('[placeSearch] Google branch threw:', err.message)
  }

  const variants = queryVariants(query)

  // 2) Photon fan-out across variants.
  try {
    const lists = await Promise.all(variants.map((v) => searchPhoton(v, { limit })))
    const merged = mergeResults(lists)
    if (merged.length) {
      const trimmed = merged.slice(0, limit)
      cacheSet(cacheKey, trimmed)
      return trimmed
    }
  } catch (err) {
    console.warn('[placeSearch] Photon branch threw:', err.message)
  }

  // 3) Nominatim fan-out — same merging logic.
  try {
    const lists = await Promise.all(variants.map((v) => searchNominatim(v, { limit })))
    const merged = mergeResults(lists)
    if (merged.length) {
      const trimmed = merged.slice(0, limit)
      cacheSet(cacheKey, trimmed)
      return trimmed
    }
  } catch (err) {
    console.warn('[placeSearch] Nominatim branch threw:', err.message)
  }

  cacheSet(cacheKey, [])
  return []
}

module.exports = { searchPlaces, queryVariants, titleCase }
