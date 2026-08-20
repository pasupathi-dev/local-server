// Disputes — customer or partner can flag a paid/completed job. Admin
// resolves from the portal (see adminController.disputes*). One open dispute
// per job; reraising after resolution is allowed.

const { db }    = require('../config/db')
const Job       = require('../models/Job')
const Notification = require('../models/Notification')
const { success } = require('../utils/response')
const push = require('../services/pushService')
const { getConfigNumber } = require('../utils/appConfig')

const FLAGGABLE_STATES = ['paid', 'completed']

// H66 — Customers and partners can only raise a dispute within this window
// after the job was paid. Admin-tunable from the portal (dispute_window_hours).
const withinDisputeWindow = async (job) => {
  if (job.state !== 'paid') return { ok: true }
  if (!job.paid_at) return { ok: true }
  const paidAt = new Date(job.paid_at).getTime()
  if (Number.isNaN(paidAt)) return { ok: true }
  const hours = await getConfigNumber('dispute_window_hours', 48)
  return { ok: (Date.now() - paidAt) <= hours * 60 * 60 * 1000, hours }
}

module.exports = {
  // POST /api/disputes  { job_id, reason }
  create: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const { job_id, reason } = req.body || {}
      if (!job_id || !reason || !String(reason).trim()) {
        return res.status(400).json({ success: false, message: 'job_id and reason are required' })
      }

      const job = await Job.findById(job_id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.customer_id !== uid && job.partner_id !== uid) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      if (!FLAGGABLE_STATES.includes(job.state)) {
        return res.status(409).json({
          success: false,
          message: `Disputes can only be raised on completed or paid jobs (current: ${job.state})`,
        })
      }
      // H66 — dispute window since payment (admin-tunable).
      const dw = await withinDisputeWindow(job)
      if (!dw.ok) {
        return res.status(409).json({
          success: false,
          code: 'dispute_window_closed',
          message: `The ${dw.hours}-hour window to raise a dispute on this job has passed. Contact support if you still need help.`,
        })
      }

      // One open dispute per job — anything beyond that should attach as a
      // resolution note rather than a new row.
      const existing = await db('disputes')
        .where({ job_id, status: 'open' })
        .first()
      if (existing) {
        return res.status(409).json({
          success: false,
          message: 'A dispute is already open for this job',
          dispute: existing,
        })
      }

      const raised_role = uid === job.partner_id ? 'partner' : 'user'
      const [id] = await db('disputes').insert({
        job_id,
        raised_by:   uid,
        raised_role,
        partner_id:  job.partner_id,
        customer_id: job.customer_id,
        reason:      String(reason).slice(0, 2000).trim(),
        status:      'open',
      })
      const dispute = await db('disputes').where({ id }).first()

      // Notify the other party so they can respond / contact support.
      const otherUid   = raised_role === 'user' ? job.partner_id : job.customer_id
      const raiserName = raised_role === 'user'
        ? (job.customer_name || 'The customer')
        : (job.partner_name  || 'The partner')

      // Other party deep-link mirrors the push payload: customer side →
      // /my-jobs/<id>, partner side → /partner/transactions/<id>.
      const otherRoute = raised_role === 'user'
        ? `/partner/transactions/${job.id}`
        : `/my-jobs/${job.id}`
      try {
        await Notification.create({
          user_id: otherUid, type: 'dispute_opened',
          title:   `Dispute opened on ${job.service}`,
          body:    `${raiserName} has flagged the job. Our team is reviewing.`,
          icon: '⚠️', icon_bg: '#fef3c7',
          route:   otherRoute,
        })
      } catch { /* swallow */ }

      push.sendToUser(otherUid, {
        title: `Dispute opened on ${job.service}`,
        body:  `${raiserName} flagged the job. Our team is reviewing.`,
        data:  { type: 'dispute:opened', jobId: job.id, route: `/my-jobs/${job.id}` },
      }).catch(() => {})

      // Also blast every admin so the portal inbox lights up.
      const adminIds = await db('users')
        .where(b => b.where('role', 'admin').orWhere('is_admin', true))
        .whereNull('deleted_at')
        .pluck('user_id')
      if (adminIds.length) {
        push.sendToUsers(adminIds, {
          title: '⚠️ New dispute',
          body:  `${raiserName} flagged ${job.service} (#${job.id})`,
          data:  { type: 'dispute:new', jobId: job.id, disputeId: String(id), route: '/portal/disputes' },
        }).catch(() => {})
      }

      res.status(201).json(success('Dispute filed', { dispute }))
    } catch (err) { next(err) }
  },

  // GET /api/disputes/mine  — caller's own disputes (raised or party)
  mine: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const rows = await db('disputes as d')
        .leftJoin('jobs as j', function () {
          this.on(db.raw('j.id COLLATE utf8mb4_unicode_ci = d.job_id COLLATE utf8mb4_unicode_ci'))
        })
        .where(b => b.where('d.customer_id', uid).orWhere('d.partner_id', uid))
        .orderBy('d.created_at', 'desc')
        .select(
          'd.*',
          'j.service', 'j.service_icon', 'j.agreed_price', 'j.partner_name',
          'j.customer_name', 'j.state as job_state',
        )
      res.json(success('My disputes', { disputes: rows }))
    } catch (err) { next(err) }
  },

  // GET /api/disputes/by-job/:jobId  — single open or latest dispute on a
  // job. Used by the job-detail page to decide whether to show the "Report a
  // problem" button or a "Dispute open" banner.
  byJob: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const job = await Job.findById(req.params.jobId)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.customer_id !== uid && job.partner_id !== uid) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      const dispute = await db('disputes')
        .where({ job_id: job.id })
        .orderBy('created_at', 'desc')
        .first()
      res.json(success('Dispute', { dispute: dispute || null }))
    } catch (err) { next(err) }
  },

  // GET /api/disputes/:id  — full dispute row, gated to a party of the
  // dispute. Used by the customer's timeline view on MyDisputesPage.
  // H64 — bumps `under_review_at` the first time a non-raiser views the
  // dispute so the customer sees movement past "Submitted" without us
  // needing a separate admin action.
  detail: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const dispute = await db('disputes').where({ id: req.params.id }).first()
      if (!dispute) return res.status(404).json({ success: false, message: 'Dispute not found' })
      if (dispute.customer_id !== uid && dispute.partner_id !== uid) {
        return res.status(403).json({ success: false, message: 'Not your dispute' })
      }
      // Auto-mark "under review" the first time the other party (or anyone
      // besides the raiser) opens the timeline view. We use the raised_by
      // check so the raiser's own polls don't false-fire the step.
      if (dispute.status === 'open' && !dispute.under_review_at && dispute.raised_by !== uid) {
        await db('disputes').where({ id: dispute.id }).update({
          under_review_at: db.fn.now(),
          under_review_by: uid,
        })
        const fresh = await db('disputes').where({ id: dispute.id }).first()
        // Push the raiser so they see progress live.
        try {
          await Notification.create({
            user_id: dispute.raised_by, type: 'dispute_opened',
            title: 'Your dispute is under review',
            body:  'Our team is looking into it.',
            icon: '🔍', icon_bg: '#dbeafe',
            route: dispute.raised_role === 'partner'
              ? `/partner/transactions/${dispute.job_id}`
              : `/my-jobs/${dispute.job_id}`,
          })
        } catch { /* swallow */ }
        push.sendToUser(dispute.raised_by, {
          title: 'Your dispute is under review',
          body:  'Our team is looking into it.',
          data:  { type: 'dispute:under_review', jobId: dispute.job_id, route: `/my-jobs/${dispute.job_id}` },
        }).catch(() => {})
        return res.json(success('Dispute', { dispute: fresh }))
      }
      res.json(success('Dispute', { dispute }))
    } catch (err) { next(err) }
  },

  // POST /api/disputes/:id/respond  { note }   (partner posts their side)
  // H64 — partner's response is a milestone step. One response per dispute;
  // a second call rewrites the note but keeps the original timestamp so
  // "Responded 2d ago" stays honest. Notifies the customer.
  respond: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const dispute = await db('disputes').where({ id: req.params.id }).first()
      if (!dispute) return res.status(404).json({ success: false, message: 'Dispute not found' })
      if (dispute.partner_id !== uid) {
        return res.status(403).json({ success: false, message: 'Only the partner can respond' })
      }
      if (dispute.status !== 'open') {
        return res.status(409).json({ success: false, message: 'This dispute is closed.' })
      }
      const note = String(req.body?.note || '').trim().slice(0, 2000)
      if (!note) return res.status(400).json({ success: false, message: 'Response cannot be empty' })

      const isFirst = !dispute.partner_response_at
      await db('disputes').where({ id: dispute.id }).update({
        partner_response_note: note,
        ...(isFirst ? { partner_response_at: db.fn.now() } : {}),
      })
      const fresh = await db('disputes').where({ id: dispute.id }).first()

      // Customer push only on the first response — subsequent edits don't
      // re-ping (the timestamp is unchanged, so the timeline doesn't move).
      if (isFirst) {
        try {
          await Notification.create({
            user_id: dispute.customer_id, type: 'dispute_opened',
            title:   'Partner responded to your dispute',
            body:    note.slice(0, 120),
            icon: '💬', icon_bg: '#fef3c7',
            route: `/my-disputes`,
          })
        } catch { /* swallow */ }
        push.sendToUser(dispute.customer_id, {
          title: 'Partner responded to your dispute',
          body:  note.slice(0, 120),
          data:  { type: 'dispute:partner_response', jobId: dispute.job_id, route: '/my-disputes' },
        }).catch(() => {})
      }

      res.json(success('Response saved', { dispute: fresh }))
    } catch (err) { next(err) }
  },
}
