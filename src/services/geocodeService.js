// Reverse-geocoding with MySQL cache.
//
// Provider order:
//   1. Google Maps Geocoding API   — when GOOGLE_MAPS_API_KEY is set AND
//                                    the key has the Geocoding API enabled
//   2. Photon (komoot)              — free, OSM-based, no key
//
// Cache keyed on lat/lng rounded to 3 decimals (~110m precision).
// TTL = 30 days — addresses don't change often.

const { db } = require('../config/db')

const TABLE = 'geocode_cache'
const ROUND = 3                     // decimal places — ~110m precision
// Cache TTL — defaults to 30 days. Override via GEOCODE_CACHE_TTL_DAYS for
// faster turnover during dev / testing of address-formatting changes.
const TTL_DAYS = Number(process.env.GEOCODE_CACHE_TTL_DAYS) || 30
const TTL_MS   = TTL_DAYS * 24 * 60 * 60_000
// External endpoints. Override only for self-hosted mirrors. The Photon
// reverse endpoint differs from the search one (/reverse vs /api/) — they
// are separate env vars so a self-hosted Photon can map both.
const GOOGLE_ENDPOINT = process.env.GOOGLE_GEOCODE_ENDPOINT
  || 'https://maps.googleapis.com/maps/api/geocode/json'
const PHOTON_ENDPOINT = process.env.PHOTON_REVERSE_ENDPOINT
  || 'https://photon.komoot.io/reverse'
const UA = process.env.UPSTREAM_UA
  // || 'ServiceLink/1.0 (https://senang.io; product@senang.io)'

const round = (n) => Number(n.toFixed(ROUND))

// Pull components out of Google's nested array — we only care about a few
const pickComponents = (results) => {
  const c = { city: null, state: null, country: null, pincode: null }
  if (!results?.length) return c
  const components = results[0].address_components || []
  for (const comp of components) {
    if (comp.types.includes('locality') ||
        comp.types.includes('postal_town') ||
        comp.types.includes('administrative_area_level_3')) {
      c.city = c.city || comp.long_name
    }
    if (comp.types.includes('administrative_area_level_1')) c.state   = comp.long_name
    if (comp.types.includes('country'))                     c.country = comp.long_name
    if (comp.types.includes('postal_code'))                 c.pincode = comp.long_name
  }
  return c
}

// ── Google ───────────────────────────────────────────────────────────
async function reverseGoogle (lat, lng) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY
  if (!apiKey) return null
  const url = `${GOOGLE_ENDPOINT}?latlng=${lat},${lng}&key=${apiKey}&language=en`
  let json
  try {
    const res = await fetch(url, { method: 'GET' })
    json = await res.json()
  } catch (err) {
    console.warn('[geocode] Google fetch failed:', err.message)
    return null
  }
  if (json.status !== 'OK' || !json.results?.length) {
    if (json.status && json.status !== 'OK') {
      console.warn(`[geocode] Google ${json.status}: ${json.error_message || 'no results'}`)
    }
    return null
  }
  const formatted = json.results[0].formatted_address || null
  const c = pickComponents(json.results)
  return {
    address: formatted,
    city:    c.city,
    state:   c.state,
    country: c.country,
    pincode: c.pincode,
    components: json.results[0].address_components || [],
    source: 'google',
  }
}

// ── Photon (free, OSM-based) fallback ────────────────────────────────
// Photon's /reverse endpoint takes lon=&lat= and returns GeoJSON.
async function reversePhoton (lat, lng) {
  const url = `${PHOTON_ENDPOINT}?lon=${lng}&lat=${lat}&lang=en`
  let json
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': UA },
    })
    if (!res.ok) return null
    json = await res.json()
  } catch (err) {
    console.warn('[geocode] Photon fetch failed:', err.message)
    return null
  }
  const f = json?.features?.[0]
  if (!f) return null
  const p = f.properties || {}
  const city    = p.city || p.town || p.village || p.county || p.state || null
  const state   = p.state || null
  const country = p.country || null
  const pincode = p.postcode || null
  // Compose a readable address — Photon doesn't ship a pre-formatted one
  // like Google does. We deliberately drop consecutive duplicates (e.g.
  // a POI whose street and city are the same string).
  const parts = [
    [p.housenumber, p.street].filter(Boolean).join(' '),
    p.suburb || p.district,
    p.city || p.town || p.village,
    p.state,
    p.postcode,
    p.country,
  ].filter(Boolean)
  const deduped = parts.filter((v, i, a) => i === 0 || a[i - 1] !== v)
  const address = deduped.join(', ') || p.name || null
  return {
    address,
    city,
    state,
    country,
    pincode,
    components: null,
    source: 'photon',
  }
}

async function reverseGeocode (lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw Object.assign(new Error('Invalid coordinates'), { statusCode: 400 })
  }

  const lat_round = round(lat)
  const lng_round = round(lng)

  // Cache hit?
  const cached = await db(TABLE).where({ lat_round, lng_round }).first()
  if (cached && (Date.now() - new Date(cached.fetched_at).getTime() < TTL_MS)) {
    return {
      address:    cached.address,
      city:       cached.city,
      state:      cached.state,
      country:    cached.country,
      pincode:    cached.pincode,
      cached:     true,
    }
  }

  // First non-null wins.
  let result = await reverseGoogle(lat, lng)
  if (!result) result = await reversePhoton(lat, lng)

  if (!result) {
    // Both providers failed — return raw coords so the UI has something.
    return {
      address: `${lat.toFixed(4)},${lng.toFixed(4)}`,
      city: null, state: null, country: null, pincode: null,
      cached: false,
    }
  }

  const row = {
    lat_round,
    lng_round,
    address: result.address,
    city:    result.city,
    state:   result.state,
    country: result.country,
    pincode: result.pincode,
    components: result.components ? JSON.stringify(result.components) : null,
    fetched_at: new Date(),
  }
  await db(TABLE)
    .insert(row)
    .onConflict(['lat_round', 'lng_round'])
    .merge({ ...row, fetched_at: db.fn.now() })

  return {
    address: result.address,
    city:    result.city,
    state:   result.state,
    country: result.country,
    pincode: result.pincode,
    cached:  false,
    source:  result.source,
  }
}

module.exports = { reverseGeocode }
