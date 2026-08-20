// Job state transitions + price updates + completion.
// Parties:  customer (role 'user')  |  partner (role 'partner')

const Job          = require('../models/Job')
const Partner      = require('../models/Partner')
const Message      = require('../models/Message')
const ActivityLog  = require('../models/ActivityLog')
const Notification = require('../models/Notification')
const { db }       = require('../config/db')
const { success }  = require('../utils/response')
const { emitToUser, emitToJob, emitToJobLocation } = require('../realtime/io')
const push = require('../services/pushService')
const { getConfigNumber } = require('../utils/appConfig')

// Haversine distance (km). Used to keep `distance_km` fresh on the active
// job response — partners move while a job is open, and a stale value
// from request-creation time would mislead the UI.
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

// Attach a fresh `distance_km` AND the partner's current coords derived
// from the partners table. The coords let the customer's LivePartnerMap
// render the partner marker on first paint instead of waiting for the
// first socket stream event — critical after a tab reload or re-login,
// when no event may arrive for ~15s.
const withLiveDistance = async (job) => {
  if (!job) return job
  if (!job.partner_id) return job
  const partner = await Partner.findByUid(job.partner_id)
  if (partner?.lat != null && partner?.lng != null) {
    job.partner_lat = Number(partner.lat)
    job.partner_lng = Number(partner.lng)
    if (job.customer_lat != null && job.customer_lng != null) {
      job.distance_km = haversineKm(partner.lat, partner.lng, job.customer_lat, job.customer_lng)
    }
  }
  return job
}

const ensureParty = (job, uid) => {
  if (!job) return 'not_found'
  if (uid !== job.customer_id && uid !== job.partner_id) return 'not_party'
  return 'ok'
}

const isPartner = (job, uid) => job && uid === job.partner_id

// Allowed transitions (partner-driven, except price-confirm).
// `completed → working` is permitted so the partner can revert a premature
// "Mark Complete" before the customer has paid.
// Bug #20: completed → paid is terminal via payment flow only — still
//          listed here so setState can be called by paymentController,
//          but isPayable + the API guard prevent a client from driving it.
const NEXT = {
  accepted:       ['priceConfirmed','cancelled'],
  priceConfirmed: ['travelling','cancelled'],
  travelling:     ['arrived','cancelled'],
  arrived:        ['working','cancelled'],
  working:        ['completed','cancelled'],
  completed:      ['working','paid','cancelled'],
}

module.exports = {
  // GET /api/jobs/:id
  detail: async (req, res, next) => {
    try {
      const job = await Job.findById(req.params.id)
      const check = ensureParty(job, req.user.uid)
      if (check !== 'ok') return res.status(check === 'not_found' ? 404 : 403).json({ success: false, message: check })
      res.json(success('Job', { job: await withLiveDistance(job) }))
    } catch (err) { next(err) }
  },

  // GET /api/jobs/:id/location — returns the partner's last-known coords for
  // a job. Used by the customer map to seed the marker on cold start /
  // re-login so they don't have to wait for the next stream tick. Either
  // party on the job may read; coords come straight from the partners row.
  getLastLocation: async (req, res, next) => {
    try {
      const job = await Job.findById(req.params.id)
      const check = ensureParty(job, req.user.uid)
      if (check !== 'ok') return res.status(check === 'not_found' ? 404 : 403).json({ success: false, message: check })
      const partner = await Partner.findByUid(job.partner_id)
      const lat = partner?.lat != null ? Number(partner.lat) : null
      const lng = partner?.lng != null ? Number(partner.lng) : null
      res.json(success('Last location', {
        partner_id: job.partner_id,
        lat, lng,
        ts: partner?.location_updated_at || partner?.updated_at || null,
      }))
    } catch (err) { next(err) }
  },

  // GET /api/jobs/active   — role-aware
  active: async (req, res, next) => {
    try {
      const uid  = req.user.uid
      const job  = await (isPartnerOwnedQuery(req)
        ? Job.findActiveForPartner(uid)
        : Job.findActiveForCustomer(uid))
      res.json(success('Active', { job: await withLiveDistance(job) }))
    } catch (err) { next(err) }
  },

  // GET /api/jobs/mine  — role-aware, paginated + filterable history
  // Query: as=partner|customer, status=all|active|history|<state>,
  //        q=<text>, from=ISO, to=ISO, limit=, offset=
  mine: async (req, res, next) => {
    try {
      const uid  = req.user.uid
      const role = isPartnerOwnedQuery(req) ? 'partner' : 'customer'
      const { status = 'all', q = '', from, to, limit = 10, offset = 0 } = req.query

      // If no pagination params are provided at all, fall back to the legacy
      // unpaginated shape so old callers keep working.
      if (req.query.limit == null && req.query.offset == null
          && req.query.status == null && req.query.q == null
          && req.query.from == null && req.query.to == null) {
        const jobs = await (role === 'partner'
          ? Job.listForPartner(uid)
          : Job.listForCustomer(uid))
        return res.json(success('My jobs', { jobs }))
      }

      const { rows: jobs, total, limit: safeLimit, offset: safeOffset }
        = await Job.listPaged({ uid, role, status, q, from, to, limit, offset })
      res.json(success('My jobs', { jobs, total, limit: safeLimit, offset: safeOffset }))
    } catch (err) { next(err) }
  },

  // POST /api/jobs/:id/state  { to }
  setState: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const { to } = req.body || {}
      const job = await Job.findById(req.params.id)
      const check = ensureParty(job, uid)
      if (check !== 'ok') return res.status(check === 'not_found' ? 404 : 403).json({ success: false, message: check })

      // 'paid' is driven exclusively by the payment verification flow, never
      // by a direct setState call from either client. Bug #20.
      if (to === 'paid') {
        return res.status(403).json({ success: false, message: 'Use the payment flow to mark a job as paid' })
      }
      // Only partner drives state except priceConfirmed (customer confirms)
      if (to !== 'priceConfirmed' && !isPartner(job, uid)) {
        return res.status(403).json({ success: false, message: 'Only partner can change this state' })
      }
      if (to === 'priceConfirmed' && uid !== job.customer_id) {
        return res.status(403).json({ success: false, message: 'Only customer can confirm price' })
      }
      if (!NEXT[job.state]?.includes(to)) {
        return res.status(400).json({ success: false, message: `Cannot go ${job.state} → ${to}` })
      }

      // C46 — block working → completed while a price-change or extra-work
      // proposal is still pending. The customer needs to resolve those
      // first so the final agreed_price is locked before payment.
      if (to === 'completed') {
        const pending = await db('messages')
          .where({ job_id: job.id })
          .whereNotNull('attachment')
          .orderBy('created_at', 'desc')
        for (const m of pending) {
          let att = null
          if (typeof m.attachment === 'object') att = m.attachment
          else { try { att = JSON.parse(m.attachment) } catch { att = null } }
          if (!att) continue
          const isProposal = att.type === 'price-change-proposal'
                          || att.type === 'extra-work-proposal'
          if (isProposal && att.status === 'pending') {
            return res.status(409).json({
              success: false,
              message: 'Resolve the pending price proposal before completing the job',
              code: 'pending_price_proposal',
              proposal_type: att.type,
            })
          }
        }
      }

      const extra = {}
      if (to === 'working')   extra.started_at = new Date()
      if (to === 'completed') extra.completed_at = new Date()
      await Job.setState(job.id, to, extra)
      const fresh = await Job.findById(job.id)

      emitToJob(job.id, 'job:state-changed', { jobId: job.id, state: to })
      const ACT_MAP = {
        priceConfirmed: 'price_confirmed',
        travelling:     'travelling',
        arrived:        'arrived',
        working:        'work_started',
        completed:      'work_completed',
      }
      if (ACT_MAP[to] && isPartner(job, uid)) {
        await ActivityLog.add({
          partner_id: job.partner_id,
          type: ACT_MAP[to],
          title: `Job ${to}`, sub: `${job.service} · ${job.customer_name}`,
          icon: '🧭', color: '#2563eb',
          job_id: job.id, customer_name: job.customer_name,
        })
      }

      // Push to the customer when the partner just hit a milestone they care
      // about. `arrived` is the loud one (they should look outside).
      if (isPartner(job, uid)) {
        const map = {
          travelling: { title: 'Partner is on the way 🛵', body: `${job.partner_name} is heading to you` },
          arrived:    { title: `${job.partner_name} is at your door 🚪`, body: `Open the door — they're here for ${job.service}` },
          working:    { title: 'Work has started', body: `${job.partner_name} began working on ${job.service}` },
          completed:  { title: 'Work completed ✅', body: `Tap to pay for ${job.service}` },
        }
        const msg = map[to]
        if (msg) {
          push.sendToUser(job.customer_id, {
            ...msg,
            data: {
              type: `job:${to}`,
              jobId: job.id,
              route: to === 'completed' ? `/pay/${job.id}` : `/chat/${job.id}`,
            },
          }).catch(() => {})
        }
      }

      res.json(success('State updated', { job: await withLiveDistance(fresh) }))
    } catch (err) { next(err) }
  },

  // M43 — PATCH /api/jobs/:id/completion-photos  { photos: [url, url, url] }
  // Partner attaches up to 3 before/after photos. Stored on the job and
  // visible to the customer on the job detail + review pages.
  setCompletionPhotos: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const job = await Job.findById(req.params.id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (!isPartner(job, uid)) {
        return res.status(403).json({ success: false, message: 'Only the partner can attach photos' })
      }
      const raw = Array.isArray(req.body?.photos) ? req.body.photos : []
      const safe = raw
        .filter((u) => typeof u === 'string' && u.length < 500)
        .slice(0, 3)
      await db('jobs').where({ id: job.id })
        .update({ completion_photos: safe.length ? JSON.stringify(safe) : null })
      const fresh = await Job.findById(job.id)
      emitToJob(job.id, 'job:state-changed', {
        jobId: job.id, completion_photos: safe,
      })
      res.json(success('Completion photos saved', { job: fresh }))
    } catch (err) { next(err) }
  },

  // M44 — POST /api/jobs/:id/extra-work  { description, extra_price }
  // Partner proposes an extra-scope charge mid-job. Sends a structured
  // chat message attachment the customer can Approve / Decline. Approval
  // bumps `agreed_price`; decline leaves it untouched. Single payment at
  // the end — no out-of-platform UPI dance.
  proposeExtraWork: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const job = await Job.findById(req.params.id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (!isPartner(job, uid)) {
        return res.status(403).json({ success: false, message: 'Only the partner can add extra work' })
      }
      if (!['priceConfirmed','travelling','arrived','working'].includes(job.state)) {
        return res.status(409).json({ success: false, message: 'Job state must be active to add extra work' })
      }
      const description = String(req.body?.description || '').trim().slice(0, 200)
      const extra_price = Math.round(Number(req.body?.extra_price))
      if (!description) return res.status(400).json({ success: false, message: 'description required' })
      if (!Number.isFinite(extra_price) || extra_price <= 0) {
        return res.status(400).json({ success: false, message: 'extra_price must be a positive number' })
      }

      const msg = await Message.create({
        job_id: job.id, sender_id: uid, sender_role: 'partner',
        sender_initials: job.partner_initials,
        body: `Extra work proposal — ₹${extra_price} for ${description}`,
        attachment: {
          type: 'extra-work-proposal',
          description,
          extra_price,
          // The customer's UI uses this id to disambiguate which proposal
          // they're approving when multiple are sent over the job's life.
          proposal_id: `xw_${Date.now()}`,
          status: 'pending',
        },
      })
      emitToJob(job.id, 'chat:message', msg)

      await Notification.create({
        user_id: job.customer_id, type: 'price_updated',
        title: 'Extra work proposed',
        body: `${job.partner_name} proposed ₹${extra_price} extra for ${description}`,
        icon: '➕', icon_bg: '#fef3c7',
        route: `/chat/${job.id}`,
      })
      res.json(success('Extra work proposed', { message: msg }))
    } catch (err) { next(err) }
  },

  // H47 — PATCH /api/jobs/:id/line-items  { service, materials, travel }
  // Partner enters the per-line breakdown so the customer's payment screen
  // shows exactly what they're paying for. All three are integer rupees;
  // omitted lines default to 0 (NOT to agreed_price, so the partner has
  // to be explicit). agreed_price stays the canonical labour total and
  // is bumped to match service+materials+travel.
  setLineItems: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const job = await Job.findById(req.params.id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (!isPartner(job, uid)) {
        return res.status(403).json({ success: false, message: 'Only the partner can edit line items' })
      }
      if (!['priceConfirmed','travelling','arrived','working','completed'].includes(job.state)) {
        return res.status(409).json({ success: false, message: 'Job state must be active' })
      }
      const round0 = (v) => Math.max(0, Math.round(Number(v) || 0))
      const service   = round0(req.body?.service)
      const materials = round0(req.body?.materials)
      const travel    = round0(req.body?.travel)
      const labour    = service + materials + travel
      if (labour <= 0) {
        return res.status(400).json({ success: false, message: 'At least one line item must be > 0' })
      }
      await db('jobs').where({ id: job.id }).update({
        line_items:   JSON.stringify({ service, materials, travel }),
        agreed_price: labour,
      })
      const fresh = await Job.findById(job.id)
      emitToJob(job.id, 'job:state-changed', {
        jobId: job.id, line_items: { service, materials, travel }, agreed_price: labour,
      })
      res.json(success('Line items saved', { job: fresh }))
    } catch (err) { next(err) }
  },

  // H47 — GET /api/jobs/:id/bill?tip=...
  // Returns the itemised breakdown the customer sees on PaymentPage. Cheap
  // (no Razorpay round-trip) so the tip-picker can re-quote on every chip
  // tap. The actual paid amount is recomputed on the server in
  // /payments/create-order so a tampered client can't underpay.
  getBill: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const job = await Job.findById(req.params.id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (uid !== job.customer_id && uid !== job.partner_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      const tip = Math.max(0, Math.min(10_000, Math.round(Number(req.query?.tip) || 0)))
      const { billBreakdown } = require('./paymentController')
      const breakdown = await billBreakdown(job, { tip })
      res.json(success('Bill', { breakdown, job: { id: job.id, state: job.state } }))
    } catch (err) { next(err) }
  },

  // M44 — GET /api/jobs/:id/extra-work
  // Returns every extra-work proposal attached to this job, newest first,
  // so both the partner work page and customer job detail can show the
  // running tally without having to scroll through chat.
  listExtraWork: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const job = await Job.findById(req.params.id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (uid !== job.customer_id && uid !== job.partner_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      const rows = await db('messages')
        .where({ job_id: job.id })
        .whereNotNull('attachment')
        .orderBy('created_at', 'desc')
      const proposals = []
      for (const r of rows) {
        let att = null
        if (typeof r.attachment === 'string') {
          try { att = JSON.parse(r.attachment) } catch { att = null }
        } else if (typeof r.attachment === 'object') {
          att = r.attachment
        }
        if (att?.type !== 'extra-work-proposal') continue
        proposals.push({
          message_id:   r.id,
          description:  att.description,
          extra_price:  att.extra_price,
          status:       att.status || 'pending',
          proposal_id:  att.proposal_id || null,
          created_at:   r.created_at,
        })
      }
      res.json(success('Extra work', { proposals }))
    } catch (err) { next(err) }
  },

  // M44 — POST /api/jobs/:id/extra-work/respond  { message_id, accepted: bool }
  // Customer taps Approve or Decline on the proposal attachment. Approve
  // bumps `agreed_price`; both branches edit the original message so the
  // attachment's status flips and the buttons disappear.
  respondExtraWork: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const job = await Job.findById(req.params.id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.customer_id !== uid) {
        return res.status(403).json({ success: false, message: 'Only the customer can respond' })
      }
      const message_id = Number(req.body?.message_id)
      const accepted = !!req.body?.accepted
      if (!Number.isFinite(message_id)) {
        return res.status(400).json({ success: false, message: 'message_id required' })
      }

      const msg = await db('messages').where({ id: message_id, job_id: job.id }).first()
      if (!msg) return res.status(404).json({ success: false, message: 'Proposal message not found' })
      const att = (() => {
        if (!msg.attachment) return null
        if (typeof msg.attachment === 'object') return msg.attachment
        try { return JSON.parse(msg.attachment) } catch { return null }
      })()
      if (!att || att.type !== 'extra-work-proposal') {
        return res.status(400).json({ success: false, message: 'Not an extra-work proposal' })
      }
      if (att.status !== 'pending') {
        return res.status(409).json({ success: false, message: 'Already responded' })
      }
      const nextAtt = { ...att, status: accepted ? 'accepted' : 'declined' }
      await db('messages').where({ id: message_id }).update({
        attachment: JSON.stringify(nextAtt),
      })

      let nextAgreed = Number(job.agreed_price || 0)
      if (accepted) {
        nextAgreed += Number(att.extra_price || 0)
        await Job.setAgreedPrice(job.id, nextAgreed)
      }

      const fresh = await Job.findById(job.id)
      // Fetch via Message.findById so the attachment column comes back as
      // a parsed object (not a JSON string) — the chat UI reads
      // `m.attachment.type` to render the bubble.
      const updatedMsg = await Message.findById(message_id)
      emitToJob(job.id, 'chat:message-edited', updatedMsg)
      if (accepted) {
        emitToJob(job.id, 'price:proposed', {
          jobId: job.id,
          oldPrice: Number(job.agreed_price || 0),
          newPrice: nextAgreed,
        })
      }

      await ActivityLog.add({
        partner_id: job.partner_id,
        type: accepted ? 'price_updated' : 'price_updated',
        title: accepted
          ? `Extra work approved — ₹${att.extra_price} (${att.description})`
          : `Extra work declined — ${att.description}`,
        sub: `${job.service} · ${job.customer_name}`,
        icon: accepted ? '✅' : '✖',
        color: accepted ? '#059669' : '#dc2626',
        job_id: job.id, customer_name: job.customer_name,
        amount: accepted ? att.extra_price : null,
      })

      res.json(success('Responded', { job: fresh, accepted, message: updatedMsg }))
    } catch (err) { next(err) }
  },

  // C46 — POST /api/jobs/:id/price  { agreed_price, reason }
  // Partner PROPOSES a new total price with a reason. Customer must
  // Approve / Reject before agreed_price actually changes. We no longer
  // mutate the job directly here — that prevents sticker-shock at the
  // payment screen. The proposal lives as a chat attachment so both sides
  // have an audit trail.
  proposePrice: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const job = await Job.findById(req.params.id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (!isPartner(job, uid)) return res.status(403).json({ success: false, message: 'Only partner' })
      const newPrice = Number(req.body?.agreed_price)
      // Bug #25: price must be a positive integer; zero price would let work
      // proceed without any payment obligation, which is a business invariant.
      if (!Number.isFinite(newPrice) || newPrice <= 0) return res.status(400).json({ success: false, message: 'Price must be greater than 0' })
      const reason = String(req.body?.reason || '').trim().slice(0, 300) || null

      const oldPrice = Number(job.agreed_price || 0)
      if (newPrice === oldPrice) {
        return res.status(400).json({ success: false, message: 'New price is the same as current' })
      }

      const proposal_id = `pc_${Date.now()}`
      const msg = await Message.create({
        job_id: job.id, sender_id: uid, sender_role: 'partner',
        sender_initials: job.partner_initials,
        body: reason
          ? `Proposing new price ₹${newPrice} (was ₹${oldPrice}): ${reason}`
          : `Proposing new price ₹${newPrice} (was ₹${oldPrice})`,
        attachment: {
          type: 'price-change-proposal',
          old_price: oldPrice,
          new_price: newPrice,
          reason,
          proposal_id,
          status: 'pending',
        },
      })
      emitToJob(job.id, 'chat:message', msg)
      emitToJob(job.id, 'price:change-proposed', {
        jobId: job.id, old_price: oldPrice, new_price: newPrice, message_id: msg.id,
      })

      await ActivityLog.add({
        partner_id: job.partner_id, type: 'price_updated',
        title: `Proposed price ₹${oldPrice} → ₹${newPrice}`,
        sub: `${job.service} · ${job.customer_name}`,
        icon: '💲', color: '#d97706',
        job_id: job.id, customer_name: job.customer_name, amount: newPrice,
      })
      await Notification.create({
        user_id: job.customer_id, type: 'price_updated',
        title: 'Partner proposed a new price',
        body: `${job.partner_name} is proposing ₹${newPrice} (was ₹${oldPrice}). Tap to review.`,
        icon: '💲', icon_bg: '#fef3c7',
        route: `/chat/${job.id}`,
      })
      res.json(success('Price proposed', {
        job: await withLiveDistance(await Job.findById(job.id)),
        message: msg,
      }))
    } catch (err) { next(err) }
  },

  // C46 — POST /api/jobs/:id/price-change/respond  { message_id, accepted }
  // Customer Accepts / Rejects a pending price-change proposal. Accept
  // updates `agreed_price`. Reject leaves it untouched. Either way the
  // proposal message's status flips so the buttons disappear.
  respondPriceChange: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const job = await Job.findById(req.params.id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.customer_id !== uid) {
        return res.status(403).json({ success: false, message: 'Only the customer can respond' })
      }
      const message_id = Number(req.body?.message_id)
      const accepted = !!req.body?.accepted
      if (!Number.isFinite(message_id)) {
        return res.status(400).json({ success: false, message: 'message_id required' })
      }

      const msg = await db('messages').where({ id: message_id, job_id: job.id }).first()
      if (!msg) return res.status(404).json({ success: false, message: 'Proposal not found' })
      const att = (() => {
        if (!msg.attachment) return null
        if (typeof msg.attachment === 'object') return msg.attachment
        try { return JSON.parse(msg.attachment) } catch { return null }
      })()
      if (!att || att.type !== 'price-change-proposal') {
        return res.status(400).json({ success: false, message: 'Not a price-change proposal' })
      }
      if (att.status !== 'pending') {
        return res.status(409).json({ success: false, message: 'Already responded' })
      }

      const nextAtt = { ...att, status: accepted ? 'accepted' : 'declined' }
      await db('messages').where({ id: message_id }).update({
        attachment: JSON.stringify(nextAtt),
      })

      if (accepted) {
        await Job.setAgreedPrice(job.id, Number(att.new_price))
      }

      const fresh = await Job.findById(job.id)
      const updatedMsg = await Message.findById(message_id)
      emitToJob(job.id, 'chat:message-edited', updatedMsg)
      if (accepted) {
        emitToJob(job.id, 'price:proposed', {
          jobId: job.id,
          oldPrice: Number(att.old_price),
          newPrice: Number(att.new_price),
        })
      }

      await ActivityLog.add({
        partner_id: job.partner_id, type: 'price_updated',
        title: accepted
          ? `Price-change approved ₹${att.old_price} → ₹${att.new_price}`
          : `Price-change declined (₹${att.new_price})`,
        sub: `${job.service} · ${job.customer_name}`,
        icon: accepted ? '✅' : '✖',
        color: accepted ? '#059669' : '#dc2626',
        job_id: job.id, customer_name: job.customer_name,
        amount: accepted ? att.new_price : null,
      })

      res.json(success('Responded', { job: fresh, accepted, message: updatedMsg }))
    } catch (err) { next(err) }
  },

  // POST /api/jobs/:id/location  { lat, lng }
  // Partner pings their current location every ~15s while the job is in a
  // motion state (travelling / arrived). Server validates the caller is the
  // partner on the job and the state allows streaming, persists the latest
  // coords on the partners row (so anyone who joins late gets a starting
  // point), and emits to the job's dedicated location room. Customer clients
  // subscribe via socket `join-job-location`.
  streamLocation: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const lat = Number(req.body?.lat)
      const lng = Number(req.body?.lng)
      const heading = req.body?.heading != null ? Number(req.body.heading) : null
      const speed   = req.body?.speed   != null ? Number(req.body.speed)   : null
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ success: false, message: 'lat/lng required (numbers)' })
      }

      const job = await Job.findById(req.params.id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.partner_id !== uid) {
        return res.status(403).json({ success: false, message: 'Only the partner on this job can stream location' })
      }
      // Only allow streaming while we're actually moving toward / at the
      // customer. Once the job is `working` (on-site), `completed`, `paid`
      // or `cancelled`, the location stream stops being useful and we
      // shouldn't emit further coords.
      if (!['travelling', 'arrived'].includes(job.state)) {
        return res.status(409).json({ success: false, message: `Streaming only allowed in travelling/arrived (current: ${job.state})` })
      }

      // Persist last-known coords to the partners row. This is the same
      // column setLocation() updates, so any other consumer of the partner's
      // location (live distance on /jobs/:id, map list) stays current too.
      await Partner.setLocation(uid, { lat, lng })

      const ts = new Date().toISOString()
      emitToJobLocation(job.id, 'job:location', {
        jobId: job.id,
        partner_id: uid,
        lat, lng,
        heading: Number.isFinite(heading) ? heading : null,
        speed:   Number.isFinite(speed)   ? speed   : null,
        ts,
      })

      // Proximity alert — fire ONCE per trip when the partner crosses the
      // 100m threshold to the customer. Uses `proximity_announced_at` as a
      // dedupe flag so we don't spam toasts on every subsequent ping.
      // Customer + partner each get their own role-specific message via
      // direct emit (no role-checking on the client).
      if (job.proximity_announced_at == null
          && job.customer_lat != null && job.customer_lng != null) {
        const distM = haversineKm(lat, lng, Number(job.customer_lat), Number(job.customer_lng)) * 1000
        if (Number.isFinite(distM) && distM <= 100) {
          await db('jobs').where({ id: job.id }).update({ proximity_announced_at: db.fn.now() }).catch(() => {})
          const partnerName  = job.partner_name  || 'Your partner'
          const customerName = job.customer_name || 'the customer'
          emitToUser(job.customer_id, 'job:proximity', {
            jobId: job.id,
            distance_m: Math.round(distM),
            title: `${partnerName} is almost here`,
            body:  `Just ${Math.round(distM)} m away — keep an eye out 👀`,
          })
          emitToUser(job.partner_id, 'job:proximity', {
            jobId: job.id,
            distance_m: Math.round(distM),
            title: 'Almost there!',
            body:  `You're ${Math.round(distM)} m from ${customerName} — get ready to mark Arrived.`,
          })
        }
      }

      res.json(success('Location streamed', { lat, lng, ts }))
    } catch (err) { next(err) }
  },

  // POST /api/jobs/:id/cancel  { reason, note }
  cancel: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const job = await Job.findById(req.params.id)
      const check = ensureParty(job, uid)
      if (check !== 'ok') return res.status(check === 'not_found' ? 404 : 403).json({ success: false, message: check })
      const cancelled_by = uid === job.partner_id ? 'partner' : 'user'
      const reason = String(req.body?.reason || '').trim() || null
      const note   = String(req.body?.note || '').trim() || null

      // H27 — free cancellation window: customers cancelling within the
      // grace window pay nothing. After that we charge a flat fee.
      // Both values are admin-tunable from the portal (app_config table).
      const FREE_WINDOW_SEC = await getConfigNumber('free_cancel_window_sec', 90)
      const FREE_WINDOW_MS  = FREE_WINDOW_SEC * 1000
      const FLAT_FEE_INR    = await getConfigNumber('cancel_fee_inr', 50)
      const acceptedAt = job.accepted_at ? new Date(job.accepted_at).getTime() : null
      const sinceAccept = acceptedAt ? Date.now() - acceptedAt : 0
      const withinFreeWindow = acceptedAt == null || sinceAccept <= FREE_WINDOW_MS
      let cancellation_fee = 0
      if (cancelled_by === 'user' && !withinFreeWindow) {
        if (req.body?.confirm_fee !== true) {
          return res.status(409).json({
            success: false,
            code: 'fee_confirmation_required',
            message: `Cancelling now costs ₹${FLAT_FEE_INR}. Re-submit with confirm_fee=true to proceed.`,
            fee_inr: FLAT_FEE_INR,
            free_window_remaining_seconds: 0,
          })
        }
        cancellation_fee = FLAT_FEE_INR
      }

      await Job.cancel(job.id, { cancel_reason: reason, cancel_note: note, cancelled_by })

      // Both parties get the full payload so the receiving side can render a
      // detailed overlay with the reason + free-text note.
      emitToJob(job.id, 'job:cancelled', {
        jobId: job.id,
        cancelled_by,
        reason, note,
        partner_name:  job.partner_name,
        customer_name: job.customer_name,
        service: job.service,
        cancelled_at: new Date().toISOString(),
      })
      // Mirror as a state change so existing listeners (Redux) flip the job to
      // 'cancelled' immediately, even if they don't subscribe to job:cancelled.
      emitToJob(job.id, 'job:state-changed', {
        jobId: job.id, state: 'cancelled', reason, note, cancelled_by,
      })

      await ActivityLog.add({
        partner_id: job.partner_id, type: 'job_cancelled',
        title: 'Job cancelled',
        sub: `${job.service} · ${reason || 'No reason'}${note ? ` — ${note}` : ''}`,
        icon: '🚫', color: '#dc2626', job_id: job.id, customer_name: job.customer_name,
      })

      // Notify the *other* party so they get an in-app push and a record in
      // the notification list. The cancelling party already saw the modal.
      const otherUid = cancelled_by === 'user' ? job.partner_id : job.customer_id
      const otherLabel = cancelled_by === 'user'
        ? (job.customer_name || 'The customer')
        : (job.partner_name  || 'The partner')
      // Other party's deep-link target depends on which app they use:
      // customer → /my-jobs/<id>, partner → /partner/transactions/<id>.
      const otherRoute = cancelled_by === 'user'
        ? `/partner/transactions/${job.id}`
        : `/my-jobs/${job.id}`
      await Notification.create({
        user_id: otherUid, type: 'job_cancelled',
        title: 'Job cancelled',
        body:  `${otherLabel} cancelled · ${reason || 'No reason given'}`,
        icon: '🚫', icon_bg: '#fee2e2',
        route: otherRoute,
      })

      res.json(success('Cancelled', {
        job: await Job.findById(job.id),
        cancelled_by, reason, note,
        cancellation_fee,
        within_free_window: withinFreeWindow,
      }))
    } catch (err) { next(err) }
  },
}

// Simple helper: accept a `?as=partner` flag in the query or infer from user role.
// Controllers can just check `req.query.as`.
const isPartnerOwnedQuery = (req) => req.query?.as === 'partner'

// ── Stale-job cron ────────────────────────────────────────────────────
//
// Cancels non-terminal jobs that haven't been touched in > 48h. Reasons
// to do this:
//   - Customer ghosted before paying a `completed` job → partner stuck.
//   - Either party closed the app at `working` and never came back.
//   - The 24h busy-filter on Partner.findNearby already hides such jobs
//     from listings, but the row still says "active" — which is misleading
//     in admin reports and can confuse audit/forensics.
//
// Auto-cancel uses cancelled_by='system', cancel_reason='auto-abandoned'
// so it's distinguishable from user/partner cancels in analytics.
//
// Called from server.js on boot + every 10 minutes.

async function expireStaleJobs () {
  try {
    // Admin-tunable from portal (stale_job_hours). 48h default = 2 days.
    const STALE_JOB_HOURS = await getConfigNumber('stale_job_hours', 48)
    const stale = await db('jobs')
      .whereNotIn('state', ['paid', 'cancelled'])
      .where('updated_at', '<', db.raw(`DATE_SUB(NOW(), INTERVAL ${STALE_JOB_HOURS} HOUR)`))
      .select('id', 'customer_id', 'partner_id', 'service', 'partner_name', 'customer_name', 'state')
    if (!stale.length) return 0

    const now = new Date()
    await db('jobs').whereIn('id', stale.map((j) => j.id)).update({
      state:         'cancelled',
      cancel_reason: 'auto-abandoned',
      cancelled_by:  'system',
      updated_at:    now,
    })

    for (const j of stale) {
      try {
        // Real-time + push to both parties so any open client closes the
        // job card cleanly instead of leaving a stale "in progress" view.
        emitToJob(j.id, 'job:state-changed', {
          jobId: j.id, state: 'cancelled',
          reason: 'auto-abandoned', cancelled_by: 'system',
        })
        emitToJob(j.id, 'job:cancelled', {
          jobId: j.id, cancelled_by: 'system',
          reason: 'auto-abandoned',
          partner_name: j.partner_name, customer_name: j.customer_name,
          service: j.service,
          cancelled_at: now.toISOString(),
        })

        await Notification.create({
          user_id: j.customer_id, type: 'job_cancelled',
          title:   'Job auto-closed',
          body:    `${j.service} was inactive for ${STALE_JOB_HOURS}h and closed automatically.`,
          icon: '⏱', icon_bg: '#fef3c7',
          route:   `/my-jobs/${j.id}`,
        }).catch(() => {})
        await Notification.create({
          user_id: j.partner_id, type: 'job_cancelled',
          title:   'Job auto-closed',
          body:    `${j.service} was inactive for ${STALE_JOB_HOURS}h and closed automatically.`,
          icon: '⏱', icon_bg: '#fef3c7',
          route:   `/partner/transactions/${j.id}`,
        }).catch(() => {})

        push.sendToUser(j.customer_id, {
          title: 'Job auto-closed',
          body:  `${j.service} was inactive for ${STALE_JOB_HOURS}h.`,
          data:  { type: 'job:auto-cancelled', jobId: j.id, route: `/my-jobs/${j.id}` },
        }).catch(() => {})
        push.sendToUser(j.partner_id, {
          title: 'Job auto-closed',
          body:  `${j.service} was inactive for ${STALE_JOB_HOURS}h.`,
          data:  { type: 'job:auto-cancelled', jobId: j.id, route: '/partner/wallet' },
        }).catch(() => {})

        await ActivityLog.add({
          partner_id: j.partner_id, type: 'job_cancelled',
          title: 'Job auto-cancelled',
          sub:   `${j.service} · inactive for ${STALE_JOB_HOURS}h`,
          icon: '⏱', color: '#92400e', job_id: j.id, customer_name: j.customer_name,
        }).catch(() => {})
      } catch { /* keep iterating — one bad row mustn't stop the cron */ }
    }
    return stale.length
  } catch (err) {
    console.warn('[stale-jobs] cron failed:', err.message)
    return 0
  }
}

module.exports.expireStaleJobs = expireStaleJobs
