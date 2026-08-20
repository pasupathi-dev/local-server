// src/models/Partner.js
const { db } = require('../config/db')

const TABLE = 'partners'
// Per-work price table. Table name is historical; its key column is now
// `work_name` (renamed from `category_name` in taxonomy v2).
const PWP   = 'partner_category_prices'

const EDITABLE = [
  'primary_category','primary_work','languages','experience_years',
  'availability_days','availability_hours',
  'emergency_service','service_radius_km',
  'is_verified','top_rated','aadhaar_verified','phone_verified','background_checked',
  'own_tools','materials_extra','zone','lat','lng','about',
]

const normalize = (row) => {
  if (!row) return row
  const parse = (v) => {
    if (v === null || v === undefined) return []
    if (Array.isArray(v)) return v
    try { return JSON.parse(v) } catch { return [] }
  }
  return { ...row, languages: parse(row.languages) }
}

const Partner = {

  findByUid: async (user_id) => {
    const row = await db(TABLE).where({ user_id }).first()
    if (!row) return null
    const prices = await db(PWP).where({ partner_id: user_id })
    return { ...normalize(row), work_prices: prices }
  },

  upsert: async (user_id, patch = {}) => {
    const payload = { user_id }
    for (const key of EDITABLE) {
      if (patch[key] === undefined) continue
      payload[key] = (key === 'languages')
        ? JSON.stringify(patch[key] || [])
        : patch[key]
    }
    await db(TABLE)
      .insert(payload)
      .onConflict('user_id')
      .merge({ ...payload, updated_at: db.fn.now() })
    return Partner.findByUid(user_id)
  },

  setOnline: async (user_id, online) => {
    await db(TABLE).where({ user_id }).update({
      is_online:    !!online,
      online_since: online ? db.fn.now() : null,
    })
  },

  // Total count of partners currently AVAILABLE — i.e. is_online = true AND
  // not busy with a live request or an active job. A partner sitting on a
  // pending request is not considered online for dashboard / count purposes;
  // they flip back to "online" automatically once the request is rejected,
  // expired, or cancelled.
  countOnline: async () => {
    const row = await db(TABLE)
      .where({ is_online: true })
      .whereNotExists(function () {
        this.select(db.raw('1')).from('requests as r')
          .whereRaw('r.partner_id COLLATE utf8mb4_unicode_ci = ' + TABLE + '.user_id COLLATE utf8mb4_unicode_ci')
          .andWhere('r.status', 'live')
      })
      .whereNotExists(function () {
        this.select(db.raw('1')).from('jobs as j')
          .whereRaw('j.partner_id COLLATE utf8mb4_unicode_ci = ' + TABLE + '.user_id COLLATE utf8mb4_unicode_ci')
          .whereNotIn('j.state', ['paid', 'cancelled', 'completed'])
          .andWhereRaw('j.updated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)')
      })
      .count({ n: '*' }).first()
    return Number(row?.n || 0)
  },

  // IDs of partners currently AVAILABLE (online AND not busy with a live
  // request or an active job). Shared by the per-work and per-category count
  // helpers so the customer-facing "N online" badges flip in real time.
  _availableOnlineIds: async () =>
    db(TABLE)
      .where({ is_online: true })
      .whereNotExists(function () {
        this.select(db.raw('1')).from('requests as r')
          .whereRaw('r.partner_id COLLATE utf8mb4_unicode_ci = ' + TABLE + '.user_id COLLATE utf8mb4_unicode_ci')
          .andWhere('r.status', 'live')
      })
      .whereNotExists(function () {
        this.select(db.raw('1')).from('jobs as j')
          .whereRaw('j.partner_id COLLATE utf8mb4_unicode_ci = ' + TABLE + '.user_id COLLATE utf8mb4_unicode_ci')
          .whereNotIn('j.state', ['paid', 'cancelled', 'completed'])
          .andWhereRaw('j.updated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)')
      })
      .pluck('user_id'),

  // Online partner count per WORK. A partner counts toward every work they've
  // opted into — primary_work AND anything in partner_category_prices.work_name.
  // Returns a plain object: { [workName]: count }.
  onlineCountsByWork: async () => {
    const onlineIds = await Partner._availableOnlineIds()
    if (!onlineIds.length) return {}

    const [primaryRows, pwpRows] = await Promise.all([
      db(TABLE)
        .whereIn('user_id', onlineIds)
        .whereNotNull('primary_work')
        .select('primary_work as work_name', 'user_id'),
      db(PWP)
        .whereIn('partner_id', onlineIds)
        .select('work_name', 'partner_id as user_id'),
    ])

    const perWork = new Map()           // work → Set<partner_id>
    const add = (work, uid) => {
      if (!work || !uid) return
      if (!perWork.has(work)) perWork.set(work, new Set())
      perWork.get(work).add(uid)
    }
    primaryRows.forEach((r) => add(r.work_name, r.user_id))
    pwpRows.forEach((r) => add(r.work_name, r.user_id))

    const out = {}
    for (const [work, set] of perWork) out[work] = set.size
    return out
  },

  // work name → parent category name, read from the works table. Used to roll
  // per-work counts up to the parent.
  _workParentMap: async () => {
    const rows = await db('works').select('name', 'category_name').catch(() => [])
    const m = {}
    for (const r of rows) m[r.name] = r.category_name
    return m
  },

  // Online partner count rolled up per PARENT category. A partner counts once
  // per parent even if they serve several works under it. Returns
  // { [categoryName]: count }. Pass the work→parent map to avoid a query; when
  // omitted it's read from the works table.
  onlineCountsByCategory: async (workParent = null) => {
    const onlineIds = await Partner._availableOnlineIds()
    if (!onlineIds.length) return {}
    const parentMap = workParent || await Partner._workParentMap()

    const [primaryRows, pwpRows] = await Promise.all([
      db(TABLE)
        .whereIn('user_id', onlineIds)
        .whereNotNull('primary_work')
        .select('primary_work as work_name', 'user_id'),
      db(PWP)
        .whereIn('partner_id', onlineIds)
        .select('work_name', 'partner_id as user_id'),
    ])

    const perCat = new Map()            // parent category → Set<partner_id>
    const add = (work, uid) => {
      const cat = parentMap[work]
      if (!cat || !uid) return
      if (!perCat.has(cat)) perCat.set(cat, new Set())
      perCat.get(cat).add(uid)
    }
    primaryRows.forEach((r) => add(r.work_name, r.user_id))
    pwpRows.forEach((r) => add(r.work_name, r.user_id))

    const out = {}
    for (const [cat, set] of perCat) out[cat] = set.size
    return out
  },

  setLocation: async (user_id, { lat, lng, address = null, city = null }) => {
    await db(TABLE).where({ user_id }).update({
      lat, lng,
      location_address:    address,
      location_city:       city,
      location_updated_at: db.fn.now(),
    })
  },

  incrementJobs: async (user_id) => {
    await db(TABLE).where({ user_id }).increment('jobs_completed', 1)
  },

  // Firm per-work price set by the partner. Returns null when the partner has
  // no row for that work — the caller decides what to fall back to (e.g. the
  // request body's price for broadcast requests).
  priceFor: async (partner_id, work_name) => {
    if (!partner_id || !work_name) return null
    const row = await db(PWP).where({ partner_id, work_name }).first()
    const n = Number(row?.base_price)
    return Number.isFinite(n) && n > 0 ? n : null
  },

  // Replace the partner's per-work price list. Accepts rows shaped either
  // { work_name, base_price } (preferred) or the legacy { category_name }.
  setWorkPrices: async (partner_id, prices = []) => {
    await db(PWP).where({ partner_id }).del()
    if (!prices.length) return []
    const rows = prices
      .map((p) => ({
        partner_id,
        work_name:  p.work_name || p.category_name,
        base_price: Number(p.base_price) || 0,
      }))
      .filter((r) => r.work_name)
    if (!rows.length) return []
    await db(PWP).insert(rows)
    return rows
  },

  // Map / list queries -------------------------------------------------
  // Returns { rows, total } so clients can paginate.
  findNearby: async ({
    work, category, lat, lng, radiusKm = 10, onlineOnly = true,
    sortBy = 'distance', limit = 10, offset = 0,
    excludeUserIds = [],
    // H18 filter chips — all optional, all combine with AND
    minRating = 0,
    verifiedOnly = false,
    emergencyOnly = false,
  } = {}) => {
    // Matching happens at the WORK level. `category` is accepted as a legacy
    // alias for callers not yet migrated.
    const matchWork = work || category
    // Haversine via SQL. lat/lng in degrees; distance_km as derived column.
    // Force matching collation on the JOIN — `partners.user_id` and
    // `users.user_id` were created with different defaults, and MySQL
    // refuses to compare them directly ("Illegal mix of collations").
    const baseJoin = (q) => {
      q.from({ p: TABLE })
        .leftJoin({ u: 'users' }, function () {
          this.on(db.raw('p.user_id COLLATE utf8mb4_unicode_ci = u.user_id COLLATE utf8mb4_unicode_ci'))
        })
      // Work-specific price lives in partner_category_prices (keyed by
      // work_name). Joining it only when we have a work keeps the query cheap
      // and lets the client show "₹500 base price" per card and sort by price.
      if (matchWork) {
        q.leftJoin({ pcp: PWP }, function () {
          this.on(db.raw('pcp.partner_id COLLATE utf8mb4_unicode_ci = p.user_id COLLATE utf8mb4_unicode_ci'))
              .andOn('pcp.work_name', db.raw('?', [matchWork]))
        })
      }
      return q
    }

    const applyFilters = (q) => {
      if (onlineOnly) q.where('p.is_online', true)
      // H18 — verified-only / emergency-only / min rating chips.
      if (verifiedOnly)  q.where('p.is_verified', true)
      if (emergencyOnly) q.where('p.emergency_service', true)
      if (Number(minRating) > 0) q.where('p.rating_avg', '>=', Number(minRating))
      // Auto-match retry uses this to skip partners who already declined
      // (or were already offered) the same request.
      if (excludeUserIds && excludeUserIds.length) {
        q.whereNotIn('p.user_id', excludeUserIds)
      }
      // A partner is discoverable for a work if either:
      //  - it's their primary_work, OR
      //  - they have a row in partner_category_prices for it
      // (the LEFT JOIN above already filters pcp rows to the target work).
      if (matchWork) {
        q.where(function () {
          this.where('p.primary_work', matchWork)
              .orWhereNotNull('pcp.work_name')
        })
      }
      // Hide partners who are currently busy.
      //
      // A partner is "busy" ONLY when they've accepted a job that's still
      // in flight. We deliberately do NOT hide them when they merely have
      // a pending (live) request — multiple customers should be able to
      // see and request the same partner in parallel. The partner picks
      // whichever they like; the moment they accept ONE, the accept
      // handler (in requestController) auto-expires the other live
      // requests pointing at them so those customers can find someone
      // else, and `Partner.setOnline(partner_id, false)` flips them out
      // of the online pool entirely.
      //
      // The 24h freshness guard on the jobs filter prevents an abandoned
      // job (e.g. 'completed' the customer never paid for, or a stuck
      // 'accepted' that the partner forgot) from making the partner
      // permanently invisible after they come back online.
      q.whereNotExists(function () {
        this.select(db.raw('1')).from('jobs')
          .whereRaw('jobs.partner_id COLLATE utf8mb4_unicode_ci = p.user_id COLLATE utf8mb4_unicode_ci')
          // 'completed' = work done, waiting on customer payment. The partner
          // is free to take new work from that point on — payment is a
          // separate workflow and shouldn't pin them as busy.
          .whereNotIn('jobs.state', ['paid', 'cancelled', 'completed'])
          .andWhereRaw('jobs.updated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)')
      })
      return q
    }

    const hasCoords = typeof lat === 'number' && typeof lng === 'number'

    const q = applyFilters(baseJoin(db.queryBuilder()))
      .select(
        'p.user_id',
        'u.full_name',
        'u.avatar_class',
        'u.city',
        'u.phone',
        'p.primary_category',
        'p.primary_work',
        'p.rating_avg',
        'p.rating_count',
        'p.jobs_completed',
        'p.completion_rate',
        'p.is_online',
        'p.is_verified',
        'p.top_rated',
        'p.lat',
        'p.lng',
        'p.location_address',
        'p.location_city',
        'p.service_radius_km',
        // L63 — denormalised social-proof quote (most-recent 4★/5★ review's
        // first sentence, capped at 120 chars). Refreshed on every review
        // create in reviewController.
        'p.top_review_quote',
      )
    if (matchWork) q.select({ base_price: 'pcp.base_price' })

    if (hasCoords) {
      q.select(db.raw(
        '(6371 * acos(cos(radians(?)) * cos(radians(p.lat)) * cos(radians(p.lng) - radians(?)) + sin(radians(?)) * sin(radians(p.lat)))) AS distance_km',
        [lat, lng, lat],
      ))
      // Keep partners with NULL lat/lng — they have no known distance, but
      // they're still online and counted by `onlineCountsByCategory`. Without
      // this clause MySQL evaluates `NULL <= radiusKm` as UNKNOWN and drops
      // them, so the home page would show "2 online" while the list returns 0.
      if (radiusKm) q.havingRaw('(distance_km IS NULL OR distance_km <= ?)', [radiusKm])
    }

    // Sort: distance needs coords; price needs a category join.
    switch (sortBy) {
      case 'rating':
        q.orderBy('p.rating_avg', 'desc')
        break
      case 'priceAsc':
      case 'priceDesc':
        if (matchWork) {
          q.orderBy('pcp.base_price', sortBy === 'priceAsc' ? 'asc' : 'desc')
        } else if (hasCoords) {
          q.orderBy('distance_km', 'asc')
        } else {
          q.orderBy('p.rating_avg', 'desc')
        }
        break
      case 'distance':
      default:
        if (hasCoords) q.orderBy('distance_km', 'asc')
        else           q.orderBy('p.rating_avg', 'desc')
    }

    // Total count — reruns the same filters (incl. radius) without select/order/limit.
    // Simpler to wrap the filtered rows in a subquery than to duplicate the having.
    const totalQuery = applyFilters(baseJoin(db.queryBuilder()))
      .select('p.user_id')
      .modify((qb) => {
        if (hasCoords) {
          qb.select(db.raw(
            '(6371 * acos(cos(radians(?)) * cos(radians(p.lat)) * cos(radians(p.lng) - radians(?)) + sin(radians(?)) * sin(radians(p.lat)))) AS distance_km',
            [lat, lng, lat],
          ))
          // Mirror the rows query: keep no-location partners in the count too.
          if (radiusKm) qb.havingRaw('(distance_km IS NULL OR distance_km <= ?)', [radiusKm])
        }
      })
    const countRow = await db.from(totalQuery.as('t')).count({ n: '*' }).first()
    const total = Number(countRow?.n || 0)

    const safeLimit  = Math.max(1, Math.min(100, Number(limit)  || 10))
    const safeOffset = Math.max(0, Number(offset) || 0)
    q.limit(safeLimit).offset(safeOffset)

    const rows = await q
    return { rows: rows.map(normalize), total }
  },

  getFullProfile: async (user_id) => {
    const partner = await Partner.findByUid(user_id)
    if (!partner) return null
    const u = await db('users').where({ user_id }).first()
    return { ...u, ...partner }
  },
}

module.exports = Partner
