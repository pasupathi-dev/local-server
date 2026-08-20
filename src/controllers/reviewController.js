const Review   = require('../models/Review')
const Partner  = require('../models/Partner')
const Job      = require('../models/Job')
const User     = require('../models/User')
const Notification = require('../models/Notification')
const ActivityLog  = require('../models/ActivityLog')
const { success }  = require('../utils/response')
const { emitToUser } = require('../realtime/io')
const { db } = require('../config/db')
const { initials } = require('../utils/ids')
const push = require('../services/pushService')
const { getConfigNumber } = require('../utils/appConfig')

module.exports = {
  // POST /api/reviews    { job_id, stars, comment, tags? }     (customer → partner)
  // H60 — tags is an array of aspect-chip slugs (e.g. ['on_time','fair_price']).
  // The model sanitises against the canonical vocab so unknown slugs are dropped.
  create: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const { job_id, stars, comment, tags } = req.body || {}
      if (!job_id || !(stars >= 1 && stars <= 5)) {
        return res.status(400).json({ success: false, message: 'job_id + stars 1–5 required' })
      }
      const job = await Job.findById(job_id)
      if (!job || job.customer_id !== customer_id) return res.status(403).json({ success: false, message: 'Not your job' })

      const user = await User.findByUid(customer_id)
      const review = await Review.create({
        job_id,
        customer_id,
        partner_id: job.partner_id,
        stars, comment, tags,
        reviewer_initials:   initials(user?.full_name),
        reviewer_name:       user?.full_name,
        reviewer_avatar_url: user?.avatar_url || null,
      })
      const agg = await Review.partnerAggregate(job.partner_id)
      await db('partners').where({ user_id: job.partner_id }).update(agg)
      // L63 — keep the social-proof quote on the partner card fresh.
      // Best-effort — never block the response on it.
      Review.refreshTopQuote(job.partner_id).catch(() => {})

      emitToUser(job.partner_id, 'review:submitted', { jobId: job_id, review, aggregate: agg })
      await Notification.create({
        user_id: job.partner_id, type: 'new_review',
        title: `${stars}★ from ${user?.full_name || 'customer'}`,
        body: comment || '',
        icon: '⭐', icon_bg: '#fef3c7',
        route: '/partner/reviews',
      })
      push.sendToUser(job.partner_id, {
        title: `${stars}★ from ${user?.full_name || 'customer'}`,
        body:  comment || `Your job was rated ${stars}★`,
        data:  { type: 'review:new', jobId: job_id, route: '/partner/reviews' },
      }).catch(() => {})
      await ActivityLog.add({
        partner_id: job.partner_id, type: 'customer_rated',
        title: `Rated ${stars}★`, sub: comment || '',
        icon: '⭐', color: '#d97706',
        job_id, customer_name: job.customer_name,
      })
      res.status(201).json(success('Review submitted', { review }))
    } catch (err) { next(err) }
  },

  // POST /api/reviews/customer   { job_id, stars, comment }   (partner → customer)
  // One rating per job — DB has UNIQUE(job_id) on customer_ratings, but we
  // pre-check so the client gets a friendly 409 instead of a SQL error.
  rateCustomer: async (req, res, next) => {
    try {
      const partner_id = req.user.uid
      const { job_id, stars, comment } = req.body || {}
      if (!job_id || !(stars >= 1 && stars <= 5)) {
        return res.status(400).json({ success: false, message: 'job_id + stars 1–5 required' })
      }
      const job = await Job.findById(job_id)
      if (!job || job.partner_id !== partner_id) return res.status(403).json({ success: false, message: 'Not your job' })
      const existing = await Review.findCustomerRatingForJob(job_id)
      if (existing) return res.status(409).json({ success: false, message: 'Already rated', rating: existing })
      await Review.createCustomerRating({ job_id, partner_id, customer_id: job.customer_id, stars, comment })
      const rating = await Review.findCustomerRatingForJob(job_id)
      res.status(201).json(success('Customer rated', { rating }))
    } catch (err) { next(err) }
  },

  // GET /api/reviews/customer/:job_id   (partner → check own rating for a job)
  // Drives the post-paid "Rate this customer" card — if a row exists,
  // the UI shows the saved rating instead of the form.
  getCustomerRating: async (req, res, next) => {
    try {
      const partner_id = req.user.uid
      const { job_id } = req.params
      const job = await Job.findById(job_id)
      if (!job || job.partner_id !== partner_id) return res.status(403).json({ success: false, message: 'Not your job' })
      const rating = await Review.findCustomerRatingForJob(job_id)
      res.json(success('Customer rating', { rating: rating || null }))
    } catch (err) { next(err) }
  },

  // GET /api/reviews/partner/:id?limit=&offset=
  // Paginated when `limit` or `offset` is passed (used by the partner's
  // "My Reviews" infinite-scroll page). Returns the flat list otherwise
  // so existing callers (e.g. the partner detail page slice) stay happy.
  listForPartner: async (req, res, next) => {
    try {
      if (req.query.limit != null || req.query.offset != null) {
        const { rows: reviews, total, limit, offset } = await Review.pageForPartner(
          req.params.id,
          { limit: req.query.limit, offset: req.query.offset },
        )
        return res.json(success('Reviews', { reviews, total, limit, offset }))
      }
      const reviews = await Review.listForPartner(req.params.id)
      res.json(success('Reviews', { reviews }))
    } catch (err) { next(err) }
  },

  // GET /api/reviews/partner/:id/aspects
  // H60 — aspect aggregate. Returns one entry per chip slug actually used
  // on this partner, with count + pct of total reviews. Powers the
  // "On time (87%)" stats on the partner detail page.
  aspectsForPartner: async (req, res, next) => {
    try {
      const out = await Review.aspectStats(req.params.id)
      res.json(success('Aspects', out))
    } catch (err) { next(err) }
  },

  // GET /api/reviews/pending
  // Drives the "rate your last job before booking again" nag. Returns the
  // oldest paid-but-unrated job by this customer that's >1h old AND hasn't
  // been skipped. Returns { pending: null } when nothing is owed.
  // H59 — Each call increments review_nag_count on the job we surface. If
  // the count crosses MAX_NAGS we auto-mark the job as skipped and return
  // null so the modal stops nagging across days.
  pending: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const job = await db('jobs as j')
        .leftJoin('reviews as r', function () {
          this.on(db.raw('r.job_id COLLATE utf8mb4_unicode_ci = j.id COLLATE utf8mb4_unicode_ci'))
        })
        .where({ 'j.customer_id': customer_id, 'j.state': 'paid' })
        .whereNull('j.review_skipped_at')
        .whereNull('r.id')
        .whereRaw('j.paid_at IS NOT NULL AND j.paid_at <= DATE_SUB(NOW(), INTERVAL 1 HOUR)')
        .orderBy('j.paid_at', 'asc')
        .select(
          'j.id', 'j.service', 'j.service_icon', 'j.category_name',
          'j.partner_id', 'j.partner_name', 'j.partner_initials',
          'j.partner_av_class', 'j.agreed_price', 'j.paid_at',
          'j.review_nag_count',
        )
        .first()

      if (!job) return res.json(success('Pending review', { pending: null }))

      const MAX_NAGS = await getConfigNumber('max_review_nags', 3)
      const newCount = Number(job.review_nag_count || 0) + 1
      if (newCount > MAX_NAGS) {
        // Auto-skip and return nothing — caller stops nagging on this job.
        await db('jobs').where({ id: job.id }).update({ review_skipped_at: db.fn.now() })
        return res.json(success('Pending review', { pending: null }))
      }
      // Bump the counter so subsequent app-focus polls converge to auto-skip.
      await db('jobs').where({ id: job.id }).update({ review_nag_count: newCount })
      res.json(success('Pending review', { pending: { ...job, review_nag_count: newCount } }))
    } catch (err) { next(err) }
  },

  // POST /api/reviews/:id/reply   { reply }    (partner → reply to their own review)
  // M61 — one public reply per review, 280 chars max. The partner can edit
  // the text by posting again, but we don't bump the timestamp on edits so
  // "Replied 3 days ago" stays honest. Returns the updated review row so the
  // client can swap the bubble in place.
  reply: async (req, res, next) => {
    try {
      const partner_id = req.user.uid
      const review = await Review.findById(req.params.id)
      if (!review) return res.status(404).json({ success: false, message: 'Review not found' })
      if (review.partner_id !== partner_id) {
        return res.status(403).json({ success: false, message: 'Not your review' })
      }
      const reply = String(req.body?.reply || '').trim().slice(0, 280)
      if (!reply) return res.status(400).json({ success: false, message: 'Reply cannot be empty' })

      const updated = await Review.setPartnerReply(req.params.id, reply)
      res.json(success('Replied', { review: updated }))
    } catch (err) { next(err) }
  },

  // POST /api/reviews/:id/support  { note }    (customer → private follow-up on a ≤2★)
  // M62 — auto-trigger support form opens after a low-star submit. We
  // attach the customer's free-text "what went wrong" to the review row
  // and ping admins (an in-app notification + a generic admin email is
  // out of scope for this server — admins poll the disputes/safety queue
  // already). The public review itself is unchanged.
  supportFollowup: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const review = await Review.findById(req.params.id)
      if (!review) return res.status(404).json({ success: false, message: 'Review not found' })
      if (review.customer_id !== customer_id) {
        return res.status(403).json({ success: false, message: 'Not your review' })
      }
      if (review.stars > 2) {
        // Guard: we only want this path for genuine low-star follow-ups.
        return res.status(400).json({ success: false, message: 'Follow-up only available for 1★ and 2★ reviews' })
      }
      const note = String(req.body?.note || '').trim().slice(0, 1000)
      if (!note) return res.status(400).json({ success: false, message: 'Note cannot be empty' })

      const updated = await Review.setSupportNote(req.params.id, note)

      // Notify every admin so the team can follow up. Best-effort — we
      // don't fail the request if the notification fan-out hits an issue.
      try {
        const adminIds = await db('users')
          .where((b) => b.where('role', 'admin').orWhere('is_admin', true))
          .whereNull('deleted_at')
          .pluck('user_id')
        const job = await Job.findById(review.job_id)
        for (const adminId of adminIds) {
          await Notification.create({
            user_id: adminId, type: 'dispute_opened',
            title: `${review.stars}★ review needs follow-up`,
            body: `${review.reviewer_name || 'A customer'} on ${job?.service || 'a job'}: ${note.slice(0, 80)}`,
            icon: '⚠️', icon_bg: '#fee2e2',
            route: '/portal/safety',
          })
        }
      } catch { /* swallow — the review + note are still saved */ }

      res.json(success('Follow-up saved', { review: updated }))
    } catch (err) { next(err) }
  },

  // POST /api/reviews/skip  { job_id }
  // Marks the job as skipped so the nag stops surfacing it. Customer may
  // still rate later from /my-jobs/:id — skipping is just "not now".
  skip: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const { job_id } = req.body || {}
      if (!job_id) return res.status(400).json({ success: false, message: 'job_id required' })
      const job = await Job.findById(job_id)
      if (!job || job.customer_id !== customer_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      await db('jobs').where({ id: job_id }).update({ review_skipped_at: db.fn.now() })
      res.json(success('Skipped'))
    } catch (err) { next(err) }
  },
}
