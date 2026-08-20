// Instant-request flow: customer creates → partners in category receive
// realtime toast → one accepts → creates Job → everyone else stops seeing it.

const Request = require('../models/Request')
const Job     = require('../models/Job')
const User    = require('../models/User')
const Partner = require('../models/Partner')
const Work    = require('../models/Work')
const Message = require('../models/Message')
const Notification = require('../models/Notification')
const ActivityLog  = require('../models/ActivityLog')
const { success }  = require('../utils/response')
const { requestId, jobId, initials } = require('../utils/ids')
const { REQUEST_TIMER_SECONDS } = require('../config/constants')
const { emitToUser, emitToWork, emitToJob, emitGlobal } = require('../realtime/io')
const { broadcastCounts } = require('../utils/counts')
const { db } = require('../config/db')
const push = require('../services/pushService')
const { getConfigRaw, getConfigNumber } = require('../utils/appConfig')

// Pull every partner_id that should receive a fan-out push for a broadcast
// request — online + not busy + opted into the WORK (primary_work or a
// partner_category_prices.work_name row).
const partnersForWorkPush = async (work) => {
  const onlineIds = await db('partners')
    .where({ is_online: true })
    .whereNotExists(function () {
      this.select(db.raw('1')).from('requests as r')
        .whereRaw('r.partner_id COLLATE utf8mb4_unicode_ci = partners.user_id COLLATE utf8mb4_unicode_ci')
        .andWhere('r.status', 'live')
    })
    .whereNotExists(function () {
      this.select(db.raw('1')).from('jobs as j')
        .whereRaw('j.partner_id COLLATE utf8mb4_unicode_ci = partners.user_id COLLATE utf8mb4_unicode_ci')
        .whereNotIn('j.state', ['paid', 'cancelled'])
        .andWhereRaw('j.updated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)')
    })
    .pluck('user_id')
  if (!onlineIds.length) return []
  const [primary, pwp] = await Promise.all([
    db('partners').whereIn('user_id', onlineIds)
      .andWhere('primary_work', work).pluck('user_id'),
    db('partner_category_prices').whereIn('partner_id', onlineIds)
      .andWhere('work_name', work).pluck('partner_id'),
  ])
  return [...new Set([...primary, ...pwp])]
}

// Resolve the canonical taxonomy fields for a request payload. The client
// sends `work_name` (the bookable leaf); we look up its parent category, the
// display label and icon. `category_name` is accepted as a legacy alias for
// `work_name`. Returns null when neither is present.
const deriveTaxonomy = async (body = {}) => {
  const work = body.work_name || body.category_name || null
  if (!work) return null
  const w = await Work.findOne(work).catch(() => null)
  return {
    work_name:     work,
    category_name: (w && w.category_name) || body.category_name || work,
    service:       body.service || (w && (w.display_name || w.name)) || work,
    service_icon:  body.service_icon || (w && w.icon) || null,
  }
}

const buildCustomerSnapshot = (user) => ({
  customer_name:     user.full_name || 'Customer',
  customer_initials: initials(user.full_name),
  customer_av_class: user.avatar_class || 'pav-a',
  customer_phone:    user.phone || null,
  customer_address:  user.address || null,
})

const buildPartnerSnapshot = (user, partner) => ({
  partner_name:     user?.full_name || 'Partner',
  partner_initials: initials(user?.full_name),
  partner_av_class: user?.avatar_class || 'pav-a',
  partner_city:     user?.city || null,
})

// Pick the next-best online partner for an auto-match retry. Excludes
// any partner already tried for this request. Returns the same row shape
// `Partner.findNearby` produces, or null if the pool is exhausted.
const pickNextAutoPartner = async (request, triedIds) => {
  const { rows } = await Partner.findNearby({
    work:           request.work_name || request.category_name,
    lat:            Number(request.lat),
    lng:            Number(request.lng),
    radiusKm:       Number(request.auto_radius_km) || 10,
    onlineOnly:     true,
    sortBy:         'distance',
    limit:          1,
    offset:         0,
    excludeUserIds: triedIds,
  })
  return rows[0] || null
}

// Haversine distance in km between two WGS84 coordinates.
const haversineKm = (lat1, lng1, lat2, lng2) => {
  const toRad = (d) => d * Math.PI / 180
  const R = 6371
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
          * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.asin(Math.sqrt(a))
}

// Triggered when a partner toggles online. Looks for any pending auto-match
// request (live, is_auto, partner_id IS NULL) in a category they serve and
// within their auto_radius_km, picks the CLOSEST one, and atomically claims
// it. Emits the same socket events as a fresh auto-match so the partner sees
// the incoming-request toast and the customer's WaitingPage swaps from
// "searching" to "matched". No-op if the partner has no location, no served
// categories, or already has a live request / active job.
const dispatchPendingForPartner = async (partner_id) => {
  try {
    const partner = await Partner.findByUid(partner_id)
    if (!partner) return null
    if (partner.lat == null || partner.lng == null) return null

    // Skip if the partner is already on the hook for something — avoids
    // double-booking by claiming a pending request when they're committed
    // elsewhere. Mirrors the busy filter in Partner.findNearby.
    const busy = await db('requests')
      .where('partner_id', partner_id)
      .andWhere('status', 'live')
      .first()
    if (busy) return null
    // Blocking check — a 'completed' (waiting-for-payment) job should
    // NOT prevent the partner from picking up a new request.
    const activeJob = await Job.findBlockingForPartner(partner_id)
    if (activeJob) return null

    const served = new Set()
    if (partner.primary_work) served.add(partner.primary_work)
    for (const cp of (partner.work_prices || [])) {
      if (cp.work_name) served.add(cp.work_name)
    }
    if (!served.size) return null

    const candidates = await Request.findPendingAutoForWorks([...served])
    if (!candidates.length) return null

    // Compute Haversine to each candidate and keep only those within the
    // request's auto_radius_km. Skip any request that already tried this
    // partner (decline/expiry handler may have rolled them off).
    const eligible = []
    for (const r of candidates) {
      const tried = Request.triedPartnerIds(r)
      if (tried.includes(partner_id)) continue
      if (r.lat == null || r.lng == null) continue
      const km = haversineKm(Number(partner.lat), Number(partner.lng), Number(r.lat), Number(r.lng))
      const limit = Number(r.auto_radius_km) || 10
      if (km > limit) continue
      eligible.push({ r, km })
    }
    if (!eligible.length) return null

    eligible.sort((a, b) => a.km - b.km)

    // Try claims in order — atomic UPDATE protects against another partner
    // toggling online concurrently and racing for the same row. If the
    // closest is lost, fall through to the next-closest.
    for (const { r, km } of eligible) {
      const tried = Request.triedPartnerIds(r)
      tried.push(partner_id)
      const affected = await Request.claimPendingAtomic(r.id, partner_id, tried)
      if (!affected) continue

      // Apply firm per-work pricing now that we have a partner.
      const firm = await Partner.priceFor(partner_id, r.work_name || r.category_name)
      const finalPrice = firm != null ? firm : r.base_price
      await db('requests').where({ id: r.id }).update({
        base_price:  finalPrice,
        distance_km: km,
      })
      const fresh = await Request.findById(r.id)

      // Realtime to the partner — same payload shape as a fresh auto-match.
      emitToUser(partner_id, 'request:incoming', fresh)
      push.sendToUser(partner_id, {
        title: `New ${fresh.service} request`,
        body:  `${fresh.customer_name || 'Customer'} · ₹${fresh.base_price} · ${km.toFixed(1)} km`,
        data:  { type: 'request:incoming', requestId: fresh.id, route: '/partner/requests' },
        icon:  '/favicon.ico',
      }).catch(() => {})

      // Customer's WaitingPage already listens for `request:reassigned` —
      // reuse it so the "searching…" card flips to the matched partner
      // without any new client-side wiring.
      const pUser = await User.findByUid(partner_id)
      emitToUser(r.customer_id, 'request:reassigned', {
        requestId: r.id,
        partner: {
          user_id:        partner_id,
          full_name:      pUser?.full_name || 'Partner',
          avatar_class:   pUser?.avatar_class || 'pav-a',
          rating_avg:     partner.rating_avg,
          rating_count:   partner.rating_count,
          jobs_completed: partner.jobs_completed,
          distance_km:    km,
        },
      })

      // Partner is now busy with this request — refresh the global counts.
      await broadcastCounts()

      return fresh
    }
    return null
  } catch { return null }
}

module.exports = {
  dispatchPendingForPartner,

  // POST /api/requests/auto  — auto-match: server picks the closest available
  // partner in the category and creates a direct request to them. Replaces
  // the "browse → choose → request" flow when the customer just wants the
  // fastest match. Body:
  //   { category_name, service, base_price, lat, lng, notes?, radiusKm?, timer_seconds? }
  // Returns { request, partner } on 201 success, or 404 with a clear reason
  // when no partner can be matched (so the client can fall through to the
  // manual browse flow).
  autoCreate: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const {
        base_price,
        lat, lng, notes,
        radiusKm = 10,
        timer_seconds = REQUEST_TIMER_SECONDS,
      } = req.body || {}

      const tax = await deriveTaxonomy(req.body)
      if (!tax) {
        return res.status(400).json({ success: false, message: 'work_name is required' })
      }
      const parsedPrice = Number(base_price)
      if (!Number.isFinite(parsedPrice) || parsedPrice < 1) {
        return res.status(400).json({ success: false, message: 'base_price must be at least 1' })
      }
      const lat_n = Number(lat)
      const lng_n = Number(lng)
      if (!Number.isFinite(lat_n) || !Number.isFinite(lng_n)) {
        return res.status(400).json({ success: false, message: 'lat and lng required (numbers)' })
      }

      // Progressive radius search. The "Compare yourself" browse view lets
      // the customer slide the radius up to 100 km, but auto-match used to
      // hard-cap at the client's `radiusKm` (default 10 km) — so a partner
      // 11 km away would show up in browse but auto-match would return
      // "no_match". We now expand in standard rings until we find someone,
      // capped at 100 km, and remember the radius we landed on so the
      // auto-retry chain (decline → next partner) starts from there.
      // Radius rings are admin-tunable via auto_match_radius_rings
      // (JSON array of ascending km values). Default mirrors the original
      // [10, 25, 50, 100] sequence so behaviour is unchanged out of the box.
      const cfgRings = await getConfigRaw('auto_match_radius_rings')
      const RINGS_DEFAULT = Array.isArray(cfgRings) && cfgRings.every((n) => Number.isFinite(Number(n)))
        ? cfgRings.map(Number)
        : [10, 25, 50, 100]
      const startRadius = Number(radiusKm) || RINGS_DEFAULT[0] || 10
      const RADIUS_RINGS = RINGS_DEFAULT.filter((r) => r >= startRadius)
      // If the caller passed a radius bigger than any ring, just use that.
      if (!RADIUS_RINGS.length) RADIUS_RINGS.push(startRadius)

      let match = null
      let matchedRadius = startRadius
      for (const r of RADIUS_RINGS) {
        const { rows } = await Partner.findNearby({
          work: tax.work_name,
          lat: lat_n,
          lng: lng_n,
          radiusKm: r,
          onlineOnly: true,
          sortBy: 'distance',
          limit: 1,
          offset: 0,
        })
        if (rows[0]) {
          match = rows[0]
          matchedRadius = r
          break
        }
      }

      const user = await User.findByUid(customer_id)
      const rawTimer = Number(timer_seconds)
      const safeTimer = Number.isFinite(rawTimer)
        ? Math.max(30, Math.min(3600, rawTimer))
        : REQUEST_TIMER_SECONDS

      const id = requestId()
      const expires_at = new Date(Date.now() + safeTimer * 1000)

      // Pending-pool branch: nobody online right now. Keep the request "live"
      // with no partner assigned. The partner-online toggle handler will
      // claim it the moment a matching partner comes online, so the customer
      // doesn't have to retry. The request still expires after `safeTimer`.
      if (!match) {
        const payload = {
          id,
          customer_id,
          partner_id: null,
          ...tax,
          base_price:   parsedPrice,
          lat: lat_n,
          lng: lng_n,
          distance_km: null,
          notes: notes || null,
          timer_seconds: safeTimer,
          expires_at,
          status: 'live',
          is_auto: true,
          // Persist the widest radius we tried so the retry chain doesn't
          // collapse back to 10 km after a partner declines.
          auto_radius_km: RADIUS_RINGS[RADIUS_RINGS.length - 1],
          tried_partner_ids: JSON.stringify([]),
          ...buildCustomerSnapshot(user),
        }
        const request = await Request.create(payload)
        return res.status(201).json(success('Auto-pending', {
          request,
          partner: null,
          pending: true,
        }))
      }

      // From here on it's the same flow as `create` with the partner pre-locked.
      const distance_km = match.distance_km != null ? Number(match.distance_km) : null

      // Firm price: when the request is locked to a specific partner (always
      // true for auto-match), the partner's per-work price wins over whatever
      // the client passed. The client value is only a hint.
      const firmPrice = await Partner.priceFor(match.user_id, tax.work_name)
      const finalPrice = firmPrice != null ? firmPrice : parsedPrice

      const payload = {
        id,
        customer_id,
        partner_id: match.user_id,
        ...tax,
        base_price:   finalPrice,
        lat: lat_n,
        lng: lng_n,
        distance_km,
        notes: notes || null,
        timer_seconds: safeTimer,
        expires_at,
        status: 'live',
        // Auto-match retry context: if this partner declines, the decline
        // handler replays Partner.findNearby with the same radius and the
        // tried list so we don't re-offer to anyone who's already passed.
        // We use the widest radius we landed in (not the initial 10 km
        // the client may have sent) so the retry chain can still find
        // partners further out.
        is_auto: true,
        auto_radius_km: Math.max(matchedRadius, RADIUS_RINGS[RADIUS_RINGS.length - 1]),
        tried_partner_ids: JSON.stringify([match.user_id]),
        ...buildCustomerSnapshot(user),
      }
      const request = await Request.create(payload)

      // Realtime + push to the matched partner. Same payload shape as
      // `create` so the partner UI/handlers don't need to special-case auto.
      emitToUser(match.user_id, 'request:incoming', request)
      push.sendToUser(match.user_id, {
        title: `New ${tax.service} request`,
        body:  `${request.customer_name || 'Customer'} · ₹${request.base_price}${distance_km != null ? ` · ${distance_km.toFixed(1)} km` : ''}`,
        data:  { type: 'request:incoming', requestId: request.id, route: '/partner/requests' },
        icon:  '/favicon.ico',
      }).catch(() => {})

      // Direct request takes that partner out of the available pool — refresh
      // the global category counts so customer-facing badges update.
      await broadcastCounts()

      res.status(201).json(success('Auto-matched', {
        request,
        partner: {
          user_id:          match.user_id,
          full_name:        match.full_name,
          primary_category: match.primary_category,
          primary_work:     match.primary_work,
          rating_avg:       match.rating_avg,
          rating_count:     match.rating_count,
          jobs_completed:   match.jobs_completed,
          distance_km,
        },
      }))
    } catch (err) { next(err) }
  },

  // GET /api/requests/active — the customer's current in-flight search, i.e.
  // their most-recent live request (status='live'), or null. The DB row is the
  // single source of truth, so this survives refreshes and lets us show a
  // global "still searching" indicator anywhere in the app — no localStorage.
  activeForCustomer: async (req, res, next) => {
    try {
      const rows = await Request.listLiveForCustomer(req.user.uid)
      const top = rows && rows.length ? rows[0] : null
      const active = top ? await Request.findById(top.id) : null
      res.json(success('Active request', { request: active }))
    } catch (err) { next(err) }
  },

  // GET /api/requests/:id — read a single request. Visible only to the
  // customer who created it OR the assigned partner. Used by WaitingPage to
  // refresh state on reload (the original request data can be lost when the
  // user pastes the URL into a new tab).
  detail: async (req, res, next) => {
    try {
      const r = await Request.findById(req.params.id)
      if (!r) return res.status(404).json({ success: false, message: 'Not found' })
      const uid = req.user.uid
      if (r.customer_id !== uid && r.partner_id !== uid) {
        return res.status(403).json({ success: false, message: 'Not your request' })
      }
      res.json(success('Request', { request: r }))
    } catch (err) { next(err) }
  },

  // POST /api/requests  — customer creates
  create: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const user = await User.findByUid(customer_id)
      const {
        base_price,
        lat, lng, distance_km, notes, timer_seconds = REQUEST_TIMER_SECONDS,
        partner_id,   // optional — direct request to one partner
        // H26 — customer can override the address (e.g. booking for a friend
        // without overwriting their profile). The override only affects this
        // request's customer_address snapshot.
        customer_address: overrideAddress,
        // H25 — optional photo URLs (up to 3, already uploaded via /uploads).
        photos: photosFromClient,
      } = req.body || {}

      const tax = await deriveTaxonomy(req.body)
      if (!tax) {
        return res.status(400).json({ success: false, message: 'work_name is required' })
      }
      // Bug #31: require a positive base_price
      const parsedPrice = Number(base_price)
      if (!Number.isFinite(parsedPrice) || parsedPrice < 1) {
        return res.status(400).json({ success: false, message: 'base_price must be at least 1' })
      }
      // Bug #32: clamp timer_seconds to a safe range so partners can't be
      // shown a 1-second timer or a 24-hour one by a manipulated client.
      const rawTimer = Number(timer_seconds)
      const safeTimer = Number.isFinite(rawTimer)
        ? Math.max(30, Math.min(3600, rawTimer))
        : REQUEST_TIMER_SECONDS

      const id = requestId()
      const expires_at = new Date(Date.now() + safeTimer * 1000)

      // Firm price: when the request is locked to a specific partner, the
      // partner's per-category price wins over the client-provided value.
      // For broadcast requests (no partner_id) we trust the client value
      // since we don't yet know which partner will accept.
      let finalPrice = parsedPrice
      let resolvedPartner = null
      if (partner_id) {
        resolvedPartner = await Partner.findByUid(partner_id)
        if (!resolvedPartner) {
          return res.status(404).json({ success: false, code: 'partner_not_found', message: 'Partner not found' })
        }
        // Don't let a customer fire a live request at an offline partner — they
        // can't receive/accept it. (Accepting a job also flips a partner
        // offline, so this also covers "busy on another job".) For a future
        // booking the customer should use the schedule flow instead.
        if (!resolvedPartner.is_online) {
          return res.status(409).json({
            success: false,
            code: 'partner_offline',
            message: 'This partner is offline right now. Pick another pro or schedule for later.',
          })
        }
        const firmPrice = await Partner.priceFor(partner_id, tax.work_name)
        if (firmPrice != null) finalPrice = firmPrice
      }

      // Distance fallback: direct requests should always carry a distance so
      // the partner's incoming toast can render "📍 X km". Compute it server-
      // side from the partner's stored lat/lng when the client didn't pass one.
      let resolvedDistance = distance_km != null ? Number(distance_km) : null
      if (
        resolvedDistance == null && resolvedPartner
        && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
        && resolvedPartner.lat != null && resolvedPartner.lng != null
      ) {
        resolvedDistance = haversineKm(
          Number(resolvedPartner.lat), Number(resolvedPartner.lng),
          Number(lat), Number(lng),
        )
      }

      const snap = buildCustomerSnapshot(user)
      // H26 — when the caller passed an override address, use it for the
      // request's snapshot. Falls back to the user's profile.address.
      const finalAddress = (typeof overrideAddress === 'string' && overrideAddress.trim())
        ? overrideAddress.trim().slice(0, 500)
        : snap.customer_address
      // H25 — sanitise the optional photos array. We accept up to 3 string
      // URLs; anything else is dropped silently.
      const safePhotos = Array.isArray(photosFromClient)
        ? photosFromClient.filter((p) => typeof p === 'string' && p.length < 500).slice(0, 3)
        : []
      const payload = {
        id,
        customer_id,
        partner_id: partner_id || null,
        ...tax,
        base_price:   finalPrice,
        lat:          lat ?? null,
        lng:          lng ?? null,
        distance_km:  resolvedDistance,
        notes:        notes || null,
        timer_seconds: safeTimer,
        expires_at,
        status:       'live',
        ...snap,
        customer_address: finalAddress,
        // The `photos` column is added by ensureRequestsPhotosColumn().
        photos: safePhotos.length ? JSON.stringify(safePhotos) : null,
      }
      const request = await Request.create(payload)

      // Broadcast to matching partners (or single partner)
      if (partner_id) emitToUser(partner_id, 'request:incoming', request)
      else emitToWork(tax.work_name, 'request:incoming', request)

      // Push notification — wakes the partner's app even if it's backgrounded.
      // Sockets only reach foregrounded clients; FCM is what makes lock-screen
      // alerts work.
      const pushPayload = {
        title: `New ${tax.service} request`,
        body:  `${request.customer_name || 'Customer'} · ₹${request.base_price}`
             + (resolvedDistance != null ? ` · ${resolvedDistance.toFixed(1)} km` : ''),
        data:  { type: 'request:incoming', requestId: request.id, route: '/partner/requests' },
        icon:  '/favicon.ico',
      }
      if (partner_id) {
        push.sendToUser(partner_id, pushPayload).catch(() => {})
      } else {
        partnersForWorkPush(tax.work_name)
          .then((ids) => push.sendToUsers(ids, pushPayload))
          .catch(() => {})
      }

      // A direct request makes that partner "busy" — every customer who is
      // browsing the partner list / category should see them disappear in
      // real time. Re-broadcast online counts so any open list re-fetches.
      if (partner_id) {
        await broadcastCounts()
      }

      res.status(201).json(success('Request created', { request }))
    } catch (err) { next(err) }
  },

  // GET /api/requests/live  (partner lens — direct + broadcast in any served category)
  // Crucially: must return ALL live requests this partner can act on, not just
  // their primary category, so a refresh / re-navigate during the response
  // window doesn't drop the request out of their queue.
  listLive: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const partner = await Partner.findByUid(uid)
      if (!partner) return res.json(success('Live', { requests: [] }))
      // Offline partners can't act on requests — and broadcast/pending
      // auto-match requests (partner_id IS NULL) would otherwise surface here
      // for any work they serve. Return nothing so an offline partner never
      // sees an incoming request (this was the leak behind "offline partner
      // still gets a request").
      if (!partner.is_online) return res.json(success('Live', { requests: [] }))
      const served = new Set()
      if (partner.primary_work) served.add(partner.primary_work)
      for (const cp of (partner.work_prices || [])) {
        if (cp.work_name) served.add(cp.work_name)
      }
      const requests = await Request.listLiveForPartnerView(uid, [...served])
      res.json(success('Live', { requests }))
    } catch (err) { next(err) }
  },

  // POST /api/requests/:id/accept  (partner accepts)
  // Body (optional): { eta_min: integer } — M35 partner-picked ETA chip.
  accept: async (req, res, next) => {
    try {
      const partner_id = req.user.uid
      const request = await Request.findById(req.params.id)
      if (!request || request.status !== 'live') {
        return res.status(409).json({ success: false, message: 'Request is no longer live' })
      }
      // M35 — sanitise the optional ETA. Clamp to a sane band so a bogus
      // client can't pin "1440 minutes" on the customer's header.
      const rawEta = Number(req.body?.eta_min)
      const eta_min = Number.isFinite(rawEta) && rawEta > 0 && rawEta <= 240
        ? Math.round(rawEta)
        : null

      // Enforce single-active-job per partner. Uses the BLOCKING variant
      // so a 'completed' (waiting-for-payment) job doesn't gate them.
      const active = await Job.findBlockingForPartner(partner_id)
      if (active) return res.status(409).json({ success: false, message: 'Finish your active job first' })

      // Bug #1/#2/#5: atomically claim the request to prevent double-accept.
      // If another partner accepted it between our read and now, affected=0.
      const affected = await Request.acceptAtomic(request.id, partner_id)
      if (!affected) {
        return res.status(409).json({ success: false, message: 'Request was just accepted by another partner' })
      }
      // From here on, if anything throws we MUST revert the request status to
      // 'live' — otherwise the request is stuck in 'accepted' with no job
      // attached and the customer's waiting page is dead.
      const rollback = async (err) => {
        try {
          await db('requests')
            .where({ id: request.id, status: 'accepted' })
            .update({ status: 'live', partner_id: request.partner_id || null, resolved_at: null })
        } catch { /* best-effort */ }
        throw err
      }

      const pUser    = await User.findByUid(partner_id).catch(rollback)
      const partner  = await Partner.findByUid(partner_id).catch(rollback)
      const customer = await User.findByUid(request.customer_id).catch(rollback)

      // Distance: if the request already stored one, use it; otherwise
      // compute fresh from the partner's current lat/lng to the customer's
      // request coordinates so the active-job screen always has a value.
      let distanceKm = request.distance_km
      if ((distanceKm == null) && request.lat && request.lng && partner?.lat && partner?.lng) {
        distanceKm = haversineKm(partner.lat, partner.lng, request.lat, request.lng)
      }

      const id = jobId()
      const job = {
        id,
        request_id:    request.id,
        customer_id:   request.customer_id,
        partner_id,
        category_name: request.category_name,
        work_name:     request.work_name,
        service:       request.service,
        service_icon:  request.service_icon,
        base_price:    request.base_price,
        agreed_price:  request.base_price,
        distance_km:   distanceKm,
        notes:         request.notes,
        // H25 — bring the photos forward so the partner can still see them
        // after they've accepted (e.g. on /partner/work and /chat).
        // Stringify because knex+mysql2 won't auto-serialize a raw JS array
        // into a JSON column; passing `[]` directly bombs the insert.
        photos: Array.isArray(request.photos) && request.photos.length
          ? JSON.stringify(request.photos)
          : null,
        // M35 — partner-picked ETA, pinned on the customer's active job
        // header until they arrive.
        eta_min,
        // Open in `accepted` so the partner discusses scope with the
        // customer (call/chat) and may revise the agreed_price via
        // proposePrice before the customer confirms. Customer hitting
        // "Confirm Price" flips state to priceConfirmed; only then can
        // the partner start travelling.
        state:         'accepted',
        customer_name:     request.customer_name,
        customer_initials: request.customer_initials,
        customer_av_class: request.customer_av_class,
        customer_phone:    request.customer_phone,
        customer_address:  request.customer_address,
        customer_email:    customer?.email || null,
        customer_lat:      request.lat,
        customer_lng:      request.lng,
        ...buildPartnerSnapshot(pUser, partner),
      }
      const created = await Job.create(job).catch(rollback)

      // Seed chat with a discussion opener — partner is expected to call
      // or chat to clarify scope before the customer confirms the price.
      // If scope changes, partner uses proposePrice (which seeds its own
      // price-update message attachment); otherwise the original price
      // stands and the customer just hits "Confirm Price".
      await Message.create({
        job_id: id, sender_id: partner_id, sender_role: 'partner',
        sender_initials: job.partner_initials,
        body: `Hi ${job.customer_name || 'there'}! I've accepted your ${job.service} request. Let's discuss the details before confirming the price (current: ₹${job.agreed_price}).`,
      })

      // Taking a live job auto-pauses the partner so they stop receiving
      // new incoming requests while they're committed to this one.
      await Partner.setOnline(partner_id, false)

      // Realtime: customer gets accept + partner's own ack
      emitToUser(request.customer_id, 'request:accepted', { requestId: request.id, job: created })
      emitToUser(partner_id, 'request:accepted-ack', { requestId: request.id, job: created })
      emitToUser(partner_id, 'partner:online-ack', { online: false })
      emitToWork(request.work_name || request.category_name, 'request:resolved', { requestId: request.id })

      // Partner just took a job — broadcast so any customer browsing this
      // partner's detail page (or browse list) can disable their CTA with
      // "Partner is on another job" without waiting for a refetch.
      emitGlobal('partner:busy', { partner_id })

      // Multi-request fan-out resolution.
      // Until this moment the partner was visible to every customer (we
      // deliberately don't hide them when they have a live request — only
      // when they've taken a job). So other customers may have ALSO sent
      // them direct requests in parallel. We auto-resolve those now so
      // those customers don't keep waiting on a partner who's already
      // committed elsewhere. Each one gets a `request:resolved` (with the
      // partner_busy reason + partner_id) so their WaitingPage can show
      // "partner became busy — try another" instead of hanging until expiry.
      try {
        const others = await db('requests')
          .where({ partner_id, status: 'live' })
          .whereNot('id', request.id)
          .select('id', 'customer_id', 'category_name')
        if (others.length) {
          await db('requests')
            .whereIn('id', others.map((o) => o.id))
            .update({ status: 'expired', resolved_at: db.fn.now() })
          for (const o of others) {
            const payload = { requestId: o.id, reason: 'partner_busy', partner_id }
            emitToUser(o.customer_id, 'request:resolved', payload)
            emitToUser(o.customer_id, 'request:expired',  payload)
          }
          console.log(`[accept] auto-resolved ${others.length} parallel request(s) on partner ${partner_id}`)
        }
      } catch (err) {
        // Non-fatal — the accepted job is already created; the parallel
        // requests will eventually expire via the existing expiry cron.
        console.warn('[accept] parallel-request resolve failed:', err.message)
      }

      // Partner just flipped offline → every category they belonged to drops
      // by one. Rebroadcast the counts so every client's UI stays accurate.
      await broadcastCounts()

      await Notification.create({
        user_id: request.customer_id,
        type: 'request_accepted',
        title: 'Request accepted',
        body:  `${job.partner_name} accepted your ${job.service} request`,
        icon:  '✅', icon_bg: '#dcfce7',
        route: `/chat/${created.id}`,
      })
      push.sendToUser(request.customer_id, {
        title: 'Request accepted ✅',
        body:  `${job.partner_name} accepted your ${job.service} request`,
        data:  { type: 'request:accepted', jobId: created.id, route: `/chat/${created.id}` },
      }).catch(() => {})
      await ActivityLog.add({
        partner_id, type: 'request_accepted',
        title: 'Accepted request', sub: `${job.customer_name} · ${job.service}`,
        icon: '✅', color: '#059669',
        job_id: id, customer_name: job.customer_name, amount: job.base_price,
      })

      res.json(success('Request accepted', { job: created }))
    } catch (err) { next(err) }
  },

  // H34 — POST /api/requests/:id/snooze. Partner asks for 5 minutes to
  // decide. The request stays live, gets broadcast to the rest of the
  // category in parallel (if it wasn't already), and the snoozing partner
  // keeps the right to claim it within the window.
  //
  // Three cases the snoozer can land in:
  //   a) Direct request to them            → convert to broadcast (clear partner_id)
  //   b) Already a broadcast (partner_id null) → no DB change, just ack
  //   c) Direct request to someone ELSE    → 403 (shouldn't happen, they
  //                                          shouldn't even have the toast)
  // Case (b) is the one that USED to incorrectly return 403 — broadcast
  // toasts reach the category room, so any in-room partner can snooze.
  snooze: async (req, res, next) => {
    try {
      const snoozer_id = req.user.uid
      const r = await Request.findById(req.params.id)
      if (!r) return res.status(404).json({ success: false, message: 'Not found' })
      if (r.status !== 'live') {
        return res.status(409).json({ success: false, message: 'Request is no longer live' })
      }

      // Only block if the request is locked to a DIFFERENT partner. A null
      // partner_id (already broadcast) is fair game for anyone in the
      // category room — that's what the toast was already showing them.
      if (r.partner_id && r.partner_id !== snoozer_id) {
        return res.status(403).json({ success: false, message: 'Not your request to snooze' })
      }

      // Case (a) — direct request to the snoozer. Convert to broadcast.
      // Case (b) — already a broadcast. Skip the DB write, just re-emit so
      // any partners who joined the category room since the original
      // broadcast get a fresh copy.
      let fresh = r
      if (r.partner_id === snoozer_id) {
        const tried = Array.isArray(r.tried_partner_ids) ? r.tried_partner_ids : []
        await db('requests').where({ id: r.id }).update({
          partner_id: null,
          is_auto: true,
          auto_radius_km: r.auto_radius_km || 10,
          tried_partner_ids: JSON.stringify(tried),
        })
        fresh = await Request.findById(r.id)
        // Refresh category counts since the formerly-locked partner is
        // available again.
        await broadcastCounts()
      }

      // Always broadcast the (fresh) request to the category room so every
      // eligible partner sees it. The snoozing partner is still in that
      // room — that's intentional; they keep the option to accept until
      // somebody else claims it.
      emitToWork(fresh.work_name || fresh.category_name, 'request:incoming', fresh)

      // Acknowledge to the snoozer so the client can dismiss its toast for
      // the snooze window. Window admin-tunable (partner_snooze_min).
      const snoozeMin = await getConfigNumber('partner_snooze_min', 5)
      const snoozeSeconds = snoozeMin * 60
      emitToUser(snoozer_id, 'request:snoozed-ack', {
        requestId: r.id, snooze_seconds: snoozeSeconds,
      })

      res.json(success('Snoozed', { request: fresh, snooze_seconds: snoozeSeconds }))
    } catch (err) { next(err) }
  },

  // C23 — POST /api/requests/:id/fanout. Customer asks us to broadcast to
  // more nearby partners after the first partner has been silent for 60s.
  // Implementation: turn the locked direct request into a broadcast by
  // clearing `partner_id`, marking it auto-match, recording the original
  // partner in `tried_partner_ids`, then re-emitting `request:incoming` to
  // the whole category room. The original partner ALSO keeps the toast
  // (still on the tried list, but they can still accept until it expires).
  fanout: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const r = await Request.findById(req.params.id)
      if (!r) return res.status(404).json({ success: false, message: 'Not found' })
      if (r.customer_id !== customer_id) {
        return res.status(403).json({ success: false, message: 'Not your request' })
      }
      if (r.status !== 'live') {
        return res.status(409).json({ success: false, message: 'Request is no longer live' })
      }

      const tried = Array.isArray(r.tried_partner_ids) ? r.tried_partner_ids : []
      if (r.partner_id && !tried.includes(r.partner_id)) tried.push(r.partner_id)

      await db('requests').where({ id: r.id }).update({
        // Clear the lock so any partner in the category can claim it.
        partner_id: null,
        is_auto: true,
        auto_radius_km: r.auto_radius_km || 10,
        tried_partner_ids: JSON.stringify(tried),
      })

      const fresh = await Request.findById(r.id)
      // Broadcast to everyone in the category room.
      emitToWork(fresh.work_name || fresh.category_name, 'request:incoming', fresh)
      // Push notification to the broader pool (best-effort).
      partnersForWorkPush(fresh.work_name || fresh.category_name)
        .then((ids) => push.sendToUsers(ids.filter((uid) => !tried.includes(uid)), {
          title: `New ${fresh.service} request`,
          body:  `${fresh.customer_name || 'Customer'} · ₹${fresh.base_price}`,
          data:  { type: 'request:incoming', requestId: fresh.id, route: '/partner/requests' },
          icon:  '/favicon.ico',
        }))
        .catch(() => {})

      res.json(success('Fanned out', { request: fresh, tried_count: tried.length }))
    } catch (err) { next(err) }
  },

  // POST /api/requests/:id/cancel  — customer cancels their own live request.
  // Flips status to 'cancelled' and tells whichever partners are currently
  // showing the incoming-request toast to drop it. This keeps the partner's
  // UI in sync instantly instead of waiting for the 30-second timer.
  cancel: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const r = await Request.findById(req.params.id)
      if (!r) return res.status(404).json({ success: false, message: 'Not found' })
      if (r.customer_id !== customer_id) {
        return res.status(403).json({ success: false, message: 'Not your request' })
      }
      // Already resolved (accepted / declined / expired / cancelled) — treat
      // as a no-op so the client's optimistic "close overlay" flow doesn't
      // need a success-vs-error branch.
      if (r.status !== 'live') {
        return res.json(success('Already resolved', { request: r }))
      }

      await Request.updateStatus(r.id, 'cancelled')

      // Drop the toast on every partner that might be showing it:
      //   - Direct request  → the one assigned partner.
      //   - Broadcast       → everyone in the category room.
      // Both sides consume the same `request:resolved` event the accept /
      // decline flow already emits, so the existing useRealtime handler
      // removes it from Redux without any extra listener wiring.
      const payload = { requestId: r.id, reason: 'cancelled_by_customer' }
      if (r.partner_id) emitToUser(r.partner_id, 'request:resolved', payload)
      else emitToWork(r.work_name || r.category_name, 'request:resolved', payload)

      // Direct request was cancelled → that partner is no longer busy. Refresh
      // every customer's list so the partner reappears immediately.
      if (r.partner_id) {
        await broadcastCounts()
      }

      res.json(success('Cancelled', { request: await Request.findById(r.id) }))
    } catch (err) { next(err) }
  },

  // Called by the startup cron: expire overdue requests and notify all affected
  // parties via socket so their waiting overlays flip immediately (Bug #8/#10/#36).
  //
  // Auto-match note: ignored auto-match requests SHOULD also fall through to
  // the next-best partner before declaring expired — same logic as decline.
  // We do that BEFORE the bulk expiry sweep so qualifying rows are reassigned
  // (and their expires_at extended) instead of being expired.
  expireOverdueAndNotify: async () => {
    try {
      // Auto-match pre-pass: find rows that are about to expire AND have an
      // unexpired auto-retry path. Reassign rather than expire.
      // Pass a JS Date instead of db.fn.now() so the comparison value travels
      // through the same mysql2 UTC serialization path as the stored
      // expires_at (avoids a session-timezone mismatch that would
      // pre-expire fresh requests on the cron's next tick).
      const dueAuto = await db('requests')
        .where('status', 'live')
        .andWhere('is_auto', true)
        .andWhere('expires_at', '<', new Date())
        .select('*')
      for (const r of dueAuto) {
        const tried = Request.triedPartnerIds(r)
        const next = await pickNextAutoPartner(r, tried)
        if (!next) continue
        tried.push(next.user_id)
        await Request.reassignAutoMatch(r.id, next.user_id, tried)
        // Push the timer forward by the original window so the new partner
        // gets a fair shot. Without this the row expires again on the next tick.
        const newExpiry = new Date(Date.now() + (Number(r.timer_seconds) || 30) * 1000)
        await db('requests').where({ id: r.id }).update({ expires_at: newExpiry })
        // Drop the previous partner's toast, push to the new one, tell customer.
        if (r.partner_id) {
          emitToUser(r.partner_id, 'request:resolved', { requestId: r.id, reason: 'reassigned' })
        }
        const fresh = await Request.findById(r.id)
        emitToUser(next.user_id, 'request:incoming', fresh)
        emitToUser(r.customer_id, 'request:reassigned', {
          requestId: r.id,
          partner: {
            user_id:        next.user_id,
            full_name:      next.full_name,
            avatar_class:   next.avatar_class,
            rating_avg:     next.rating_avg,
            rating_count:   next.rating_count,
            jobs_completed: next.jobs_completed,
            distance_km:    next.distance_km != null ? Number(next.distance_km) : null,
          },
        })
        push.sendToUser(next.user_id, {
          title: `New ${r.service} request`,
          body:  `${r.customer_name || 'Customer'} · ₹${r.base_price}`,
          data:  { type: 'request:incoming', requestId: r.id, route: '/partner/requests' },
          icon:  '/favicon.ico',
        }).catch(() => {})
      }

      const expired = await Request.expireOverdue()
      let anyDirect = false
      for (const r of expired) {
        const payload = { requestId: r.id, reason: 'expired' }
        // Tell the customer their request timed out
        emitToUser(r.customer_id, 'request:expired', payload)
        emitToUser(r.customer_id, 'request:resolved', payload)
        // Drop it from every partner's incoming list
        if (r.partner_id) {
          emitToUser(r.partner_id, 'request:resolved', payload)
          anyDirect = true
        } else {
          emitToWork(r.work_name || r.category_name, 'request:resolved', payload)
        }
      }
      // Any direct request that timed out frees up its partner for the list.
      if (anyDirect) {
        await broadcastCounts()
      }
      return expired.length
    } catch { return 0 }
  },

  // POST /api/requests/:id/decline
  // Body (optional): { reason: 'Busy now' | 'Too far' | ..., note: string }
  decline: async (req, res, next) => {
    try {
      const r = await Request.findById(req.params.id)
      if (!r) return res.status(404).json({ success: false, message: 'Not found' })

      const decliner_id = req.user.uid
      const isDirect = !!r.partner_id && r.partner_id === decliner_id

      // H33 — capture the chip (and optional free-text note) so admin gets a
      // weekly breakdown and auto-fanout retries can deprioritise "Too far"
      // partners. Persist before any reassign/status flips so the row carries
      // the reason even after the partner row gets re-assigned.
      const reason = String(req.body?.reason || '').trim().slice(0, 80) || null
      const note   = String(req.body?.note   || '').trim().slice(0, 400) || null
      if (reason || note) {
        await db('requests').where({ id: r.id })
          .update({ decline_reason: reason, decline_note: note })
          .catch(() => { /* column missing on a fresh DB before migration — non-fatal */ })
      }

      // Auto-match fall-through: if this is an auto-matched request, try
      // the next-best partner BEFORE declaring the request declined. The
      // request stays 'live' (just reassigned) so the customer's waiting
      // page keeps spinning instead of bouncing to the "declined" state.
      let reassigned = false
      if (isDirect && r.status === 'live' && r.is_auto) {
        const tried = Request.triedPartnerIds(r)
        if (!tried.includes(decliner_id)) tried.push(decliner_id)
        const next = await pickNextAutoPartner(r, tried)
        if (next) {
          tried.push(next.user_id)
          await Request.reassignAutoMatch(r.id, next.user_id, tried)

          // Drop the toast on the declining partner, push the new offer
          // to the next-best, and notify the customer their auto-match
          // has rolled to a new partner so the waiting card can update.
          emitToUser(decliner_id, 'request:declined-ack', { requestId: r.id })
          const fresh = await Request.findById(r.id)
          emitToUser(next.user_id, 'request:incoming', fresh)
          emitToUser(r.customer_id, 'request:reassigned', {
            requestId: r.id,
            partner: {
              user_id:        next.user_id,
              full_name:      next.full_name,
              avatar_class:   next.avatar_class,
              rating_avg:     next.rating_avg,
              rating_count:   next.rating_count,
              jobs_completed: next.jobs_completed,
              distance_km:    next.distance_km != null ? Number(next.distance_km) : null,
            },
          })
          push.sendToUser(next.user_id, {
            title: `New ${r.service} request`,
            body:  `${r.customer_name || 'Customer'} · ₹${r.base_price}${next.distance_km != null ? ` · ${Number(next.distance_km).toFixed(1)} km` : ''}`,
            data:  { type: 'request:incoming', requestId: r.id, route: '/partner/requests' },
            icon:  '/favicon.ico',
          }).catch(() => {})

          await ActivityLog.add({
            partner_id: decliner_id, type: 'request_declined',
            title: 'Declined request', sub: `${r.service}`,
            icon: '✖️', color: '#dc2626',
          })
          reassigned = true
        }
      }

      // For a DIRECT request (partner_id locked on creation) a single
      // decline is terminal — nobody else can take it, so we mark the
      // request declined and tell the customer so their waiting popup
      // can flip to the "declined" state immediately instead of sitting
      // on a 30s timer. For broadcast requests, declining is just a
      // personal pass — other partners can still accept, so we leave
      // the status alone.
      if (!reassigned && isDirect && r.status === 'live') {
        await Request.updateStatus(r.id, 'declined')
        emitToUser(r.customer_id, 'request:declined', {
          requestId: r.id,
          partner_id: decliner_id,
        })
        // Partner just declined the direct request → they're available again.
        await broadcastCounts()
      }

      if (!reassigned) {
        await ActivityLog.add({
          partner_id: decliner_id, type: 'request_declined',
          title: 'Declined request', sub: `${r.service}`,
          icon: '✖️', color: '#dc2626',
        })
        emitToUser(decliner_id, 'request:declined-ack', { requestId: r.id })
      }
      res.json(success('Declined', { reassigned }))
    } catch (err) { next(err) }
  },
}
