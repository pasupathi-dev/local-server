const Partner  = require('../models/Partner')
const User     = require('../models/User')
const Work     = require('../models/Work')
const Review   = require('../models/Review')
const Settings = require('../models/Settings')
const ActivityLog = require('../models/ActivityLog')
const Wallet   = require('../models/Wallet')
const { success } = require('../utils/response')
const { actId } = require('../utils/ids')
const { emitToUser, emitGlobal } = require('../realtime/io')
const { dispatchPendingForPartner } = require('./requestController')
const { db } = require('../config/db')

module.exports = {
  // GET /api/partners?work=&lat=&lng=&radiusKm=&onlineOnly=&sortBy=&limit=&offset=
  // `work` is the bookable leaf; `category` is accepted as a legacy alias.
  list: async (req, res, next) => {
    try {
      const {
        work, category, lat, lng, radiusKm = 10, onlineOnly = 'true',
        sortBy = 'distance', limit = 10, offset = 0,
        minRating = 0, verifiedOnly = 'false', emergencyOnly = 'false',
      } = req.query
      const matchWork = work || category
      const onlyOnline = onlineOnly !== 'false'
      const { rows: partners, total } = await Partner.findNearby({
        work: matchWork,
        lat: lat ? Number(lat) : null,
        lng: lng ? Number(lng) : null,
        radiusKm: Number(radiusKm),
        onlineOnly: onlyOnline,
        sortBy,
        limit:  Number(limit),
        offset: Number(offset),
        minRating:     Number(minRating) || 0,
        verifiedOnly:  verifiedOnly  === 'true',
        emergencyOnly: emergencyOnly === 'true',
      })
      const totalOnline = await Partner.countOnline()
      // eslint-disable-next-line no-console
      console.log(`[partners] list → ${partners.length}/${total} match${total === 1 ? '' : 'es'} `
        + `(work=${matchWork || 'any'}, radius=${radiusKm}km, sort=${sortBy}, `
        + `offset=${offset}, limit=${limit}) | total online in system: ${totalOnline}`)
      res.json(success('Partners', { partners, total, limit: Number(limit), offset: Number(offset) }))
    } catch (err) { next(err) }
  },

  // GET /api/partners/:id?lat=&lng=   (full profile + reviews + distribution)
  // When lat/lng are provided we also return distance_km so the detail page
  // can show "1.2 km away" without a second request.
  detail: async (req, res, next) => {
    try {
      const partner = await Partner.getFullProfile(req.params.id)
      if (!partner) return res.status(404).json({ success: false, message: 'Partner not found' })

      // is_busy = partner currently has a non-terminal job assigned. The
      // customer app reads this to clear any stale "partner busy" flag in
      // session storage when the partner is actually free again. We treat
      // paid/cancelled as terminal; anything else (accepted/travelling/
      // arrived/working/completed) keeps them busy.
      const activeJob = await db('jobs')
        .where({ partner_id: req.params.id })
        .whereNotIn('state', ['paid', 'cancelled'])
        .select('id')
        .first()
      partner.is_busy = !!activeJob

      // First page only — subsequent pages load via GET /:id/reviews so we
      // don't ship every historical review on every detail load.
      const REVIEWS_PAGE_SIZE = 5
      const { rows: reviews, total: reviewsTotal } = await Review.pageForPartner(
        req.params.id, { offset: 0, limit: REVIEWS_PAGE_SIZE },
      )
      const distribution = await Review.ratingDistribution(req.params.id)

      // Distance: Haversine on the server — avoids the browser having to do it.
      const lat = Number(req.query.lat)
      const lng = Number(req.query.lng)
      if (Number.isFinite(lat) && Number.isFinite(lng)
        && partner.lat != null && partner.lng != null) {
        const toRad = (d) => d * Math.PI / 180
        const R = 6371
        const dLat = toRad(partner.lat - lat)
        const dLng = toRad(partner.lng - lng)
        const a = Math.sin(dLat / 2) ** 2
                + Math.cos(toRad(lat)) * Math.cos(toRad(partner.lat))
                * Math.sin(dLng / 2) ** 2
        partner.distance_km = R * 2 * Math.asin(Math.sqrt(a))
      }

      res.json(success('Partner detail', {
        partner,
        reviews,
        reviews_total: reviewsTotal,
        reviews_limit: REVIEWS_PAGE_SIZE,
        distribution,
      }))
    } catch (err) { next(err) }
  },

  // GET /api/partners/:id/reviews?offset=&limit=
  // Paginated reviews — invoked by the partner-detail page when the user
  // clicks page 2+ in the reviews pager. Returns the page rows plus the
  // total so the client can keep its page-count math in sync.
  listReviews: async (req, res, next) => {
    try {
      const offset = Number(req.query.offset) || 0
      const limit  = Number(req.query.limit) || 5
      const partnerExists = await Partner.getFullProfile(req.params.id)
      if (!partnerExists) return res.status(404).json({ success: false, message: 'Partner not found' })
      const { rows, total, offset: o, limit: l } = await Review.pageForPartner(
        req.params.id, { offset, limit },
      )
      res.json(success('Reviews', { reviews: rows, total, offset: o, limit: l }))
    } catch (err) { next(err) }
  },

  // GET /api/partners/me  — authed partner's own profile
  me: async (req, res, next) => {
    try {
      const partner = await Partner.getFullProfile(req.user.uid)
      res.json(success('Me', { partner }))
    } catch (err) { next(err) }
  },

  // PATCH /api/partners/me  — update profile (works/pricing/etc.)
  updateMe: async (req, res, next) => {
    try {
      const uid = req.user.uid
      // `works` + `work_prices` are the taxonomy-v2 fields; `categories` +
      // `category_prices` are accepted as legacy aliases.
      const {
        works = [], work_prices = [],
        categories = [], category_prices = [],
        ...patch
      } = req.body || {}
      const selectedWorks = works.length ? works : categories
      const prices        = work_prices.length ? work_prices : category_prices

      // ensure user is flagged partner
      await User.updateRole(uid, 'partner')

      if (selectedWorks.length && !patch.primary_work) patch.primary_work = selectedWorks[0]
      // Derive the parent category from the chosen primary work so the legacy
      // primary_category column (used for display/analytics) stays in sync.
      if (patch.primary_work && !patch.primary_category) {
        patch.primary_category = (await Work.parentOf(patch.primary_work)) || patch.primary_category
      }

      await Partner.upsert(uid, patch)
      if (Array.isArray(prices) && prices.length) {
        await Partner.setWorkPrices(uid, prices)
      }
      await ActivityLog.add({
        partner_id: uid, type: 'profile_updated',
        title: 'Profile updated', sub: 'Your partner profile was updated',
        icon: '✏️', color: '#2563eb',
      })
      const full = await Partner.getFullProfile(uid)
      res.json(success('Profile updated', { partner: full }))
    } catch (err) { next(err) }
  },

  // POST /api/partners/online  { online: bool }
  setOnline: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const online = !!req.body?.online
      await Partner.setOnline(uid, online)
      // Going offline: forcibly remove their sockets from every partners:*
      // room so broadcast (work-room) requests can't reach them. Server-side
      // so it can't be bypassed by a missed/stale client leave emit.
      if (!online) { const { removePartnerFromRooms } = require('../realtime/io'); await removePartnerFromRooms(uid) }
      await ActivityLog.add({
        partner_id: uid, type: 'online_toggled',
        title: online ? 'You went online' : 'You went offline',
        sub:   online ? 'Ready to receive requests' : 'Paused from receiving requests',
        icon:  online ? '🟢' : '⚫',
        color: online ? '#059669' : '#6b7280',
      })
      // Let realtime system know — partner itself can listen for ack
      emitToUser(uid, 'partner:online-ack', { online })
      const [totalOnline, categoryCounts, workCounts] = await Promise.all([
        Partner.countOnline(),
        Partner.onlineCountsByCategory(),
        Partner.onlineCountsByWork(),
      ])
      // Every connected client (customer or partner) gets the updated counts
      // so category chips, work badges, the map legend, and the "All
      // Categories" list refresh without polling.
      emitGlobal('categories:counts', { counts: categoryCounts, workCounts, totalOnline })
      // eslint-disable-next-line no-console
      console.log(`[partners] ${uid} went ${online ? 'ONLINE' : 'offline'} `
        + `| total online partners in system: ${totalOnline}`)

      // Instant-match hook: a customer may already be waiting (pending auto
      // request with partner_id IS NULL). Try to claim the closest matching
      // one for this newly-online partner so they get the toast immediately
      // instead of having to wait for a fresh request to come in.
      if (online) {
        dispatchPendingForPartner(uid).catch(() => { /* non-fatal */ })
      }

      res.json(success('Online status updated', { online, totalOnline, counts: categoryCounts }))
    } catch (err) { next(err) }
  },

  // POST /api/partners/location  { lat, lng, address?, city? }
  // If address/city not provided, server reverse-geocodes and writes them.
  setLocation: async (req, res, next) => {
    try {
      const lat = Number(req.body?.lat)
      const lng = Number(req.body?.lng)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ success: false, message: 'lat/lng required (numbers)' })
      }
      let { address, city } = req.body || {}
      if (!address || !city) {
        try {
          const { reverseGeocode } = require('../services/geocodeService')
          const r = await reverseGeocode(lat, lng)
          address = address || r.address
          city    = city    || r.city
        } catch { /* fall back silently */ }
      }
      await Partner.setLocation(req.user.uid, { lat, lng, address, city })
      res.json(success('Location updated', { lat, lng, address, city }))
    } catch (err) { next(err) }
  },

  // GET /api/partners/me/dashboard  — aggregate stats for home screen
  dashboard: async (req, res, next) => {
    try {
      const uid = req.user.uid
      await Wallet.clearEligible(uid)
      const [summary, settings] = await Promise.all([
        Wallet.summarize(uid),
        Settings.get(uid),
      ])
      res.json(success('Dashboard', { summary, settings }))
    } catch (err) { next(err) }
  },
}

// not used directly but exposes actId for consistency
module.exports.__actId = actId
