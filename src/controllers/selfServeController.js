// M67 — Self-serve resolutions. Three customer-facing actions that try to
// fix common cases without a support touch:
//
//   POST /api/jobs/:id/self-serve/reschedule  { date, slot, note }
//     – Customer wants the partner to come at a different time. Doesn't
//       change the job state; posts a request as a chat-message attachment
//       and pings the partner. Partner accepts/declines in chat.
//
//   POST /api/jobs/:id/self-serve/refund      { reason }
//     – Auto-issues a Razorpay refund when ALL of the following hold:
//         · job.state === 'paid'
//         · job.total <= AUTO_REFUND_MAX_RUPEES (₹500)
//         · within AUTO_REFUND_WINDOW_HOURS (24) of paid_at
//         · the payment row has a razorpay_payment_id
//       Otherwise falls back to filing a normal dispute the admin handles.
//
//   POST /api/jobs/:id/self-serve/no-show     { reason }
//     – Files a dispute with raised_role='user' tagged "no_show" in the
//       reason text. Admin reviews; if the partner doesn't respond within
//       the dispute timeline the no-show resolution becomes the default.

const { db }       = require('../config/db')
const Job          = require('../models/Job')
const Message      = require('../models/Message')
const Notification = require('../models/Notification')
const razorpay     = require('../config/razorpay')
const push         = require('../services/pushService')
const { success }  = require('../utils/response')
const { emitToJob, emitToUser } = require('../realtime/io')
const { getConfigNumber } = require('../utils/appConfig')

// id factory consistent with the rest of the codebase
const txId = () => `WT-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`

const guardCustomer = async (req, res) => {
  const uid = req.user.uid
  const job = await Job.findById(req.params.id)
  if (!job) { res.status(404).json({ success: false, message: 'Job not found' }); return null }
  if (job.customer_id !== uid) { res.status(403).json({ success: false, message: 'Not your job' }); return null }
  return job
}

module.exports = {
  // POST /api/jobs/:id/self-serve/reschedule  { date, slot, note }
  // Light-touch: post a `reschedule-request` chat attachment + ping the
  // partner. No job-state mutation — the partner chooses how to respond.
  reschedule: async (req, res, next) => {
    try {
      const job = await guardCustomer(req, res); if (!job) return
      const date = String(req.body?.date || '').slice(0, 30)
      const slot = String(req.body?.slot || '').slice(0, 30)
      const note = String(req.body?.note || '').trim().slice(0, 500)
      if (!date && !slot && !note) {
        return res.status(400).json({ success: false, message: 'Tell us when works better' })
      }
      const summary = [date && `📅 ${date}`, slot && `🕐 ${slot}`].filter(Boolean).join(' · ')
      const msg = await Message.create({
        job_id: job.id,
        sender_id: req.user.uid,
        sender_role: 'user',
        sender_initials: job.customer_initials || null,
        body: note
          ? `Reschedule request — ${summary || 'time TBD'}\n${note}`
          : `Reschedule request — ${summary || 'time TBD'}`,
        attachment: {
          type: 'reschedule-request',
          date, slot, note,
          status: 'pending',
        },
      })
      emitToJob(job.id, 'chat:message', msg)
      try {
        await Notification.create({
          user_id: job.partner_id, type: 'job_completed',
          title: `Reschedule requested · ${job.service}`,
          body:  summary || (note ? note.slice(0, 80) : 'Customer wants to reschedule'),
          icon: '🔁', icon_bg: '#dbeafe',
          route: `/chat/${job.id}`,
        })
      } catch { /* swallow */ }
      push.sendToUser(job.partner_id, {
        title: `Reschedule requested · ${job.service}`,
        body:  summary || 'Customer wants to reschedule',
        data:  { type: 'self-serve:reschedule', jobId: job.id, route: `/chat/${job.id}` },
      }).catch(() => {})

      res.json(success('Reschedule request sent', { message: msg }))
    } catch (err) { next(err) }
  },

  // POST /api/jobs/:id/self-serve/refund  { reason }
  // Auto-issues a Razorpay refund when the eligibility conditions hold.
  // Falls back to a regular dispute (admin handles) when it doesn't.
  refund: async (req, res, next) => {
    try {
      const job = await guardCustomer(req, res); if (!job) return
      const reason = String(req.body?.reason || '').trim().slice(0, 2000)
      if (!reason) {
        return res.status(400).json({ success: false, message: 'Tell us why you want a refund' })
      }
      if (job.state !== 'paid') {
        return res.status(409).json({ success: false, message: 'Refunds only apply to paid jobs.' })
      }
      const payment = await db('payments').where({ job_id: job.id, status: 'completed' }).first()
      if (!payment) {
        return res.status(409).json({ success: false, message: 'No completed payment found for this job.' })
      }
      const total = Number(payment.total || 0)
      const paidAt = payment.paid_at ? new Date(payment.paid_at).getTime() : null
      // Cap + window are admin-tunable (app_config). Defaults match the
      // original ₹500 / 24h policy so behaviour is unchanged if DB row missing.
      const AUTO_REFUND_MAX_RUPEES = await getConfigNumber('auto_refund_max_inr', 500)
      const AUTO_REFUND_WINDOW_HOURS = await getConfigNumber('auto_refund_window_hours', 24)
      const AUTO_REFUND_WINDOW_MS    = AUTO_REFUND_WINDOW_HOURS * 60 * 60 * 1000
      const withinWindow = paidAt && (Date.now() - paidAt) <= AUTO_REFUND_WINDOW_MS
      const underCap     = total > 0 && total <= AUTO_REFUND_MAX_RUPEES
      const cashPayment  = payment.method === 'cash' || !payment.razorpay_payment_id

      if (!underCap || !withinWindow || cashPayment) {
        // Fall back to a normal dispute — the admin reviews.
        const existing = await db('disputes').where({ job_id: job.id, status: 'open' }).first()
        if (existing) {
          return res.status(409).json({
            success: false, message: 'A dispute is already open for this job.', dispute: existing,
          })
        }
        const [id] = await db('disputes').insert({
          job_id: job.id,
          raised_by: req.user.uid, raised_role: 'user',
          partner_id: job.partner_id, customer_id: job.customer_id,
          reason: `Refund requested (₹${total}): ${reason}`,
          status: 'open',
        })
        const dispute = await db('disputes').where({ id }).first()
        return res.status(202).json(success('Sent to support — auto-refund criteria not met', {
          auto: false, dispute,
          reasonForReview: !underCap
            ? `Amount ₹${total} exceeds the ₹${AUTO_REFUND_MAX_RUPEES} self-serve cap.`
            : !withinWindow
              ? `Outside the ${AUTO_REFUND_WINDOW_HOURS}-hour auto-refund window.`
              : 'Cash / non-Razorpay payment — admin will reach out.',
        }))
      }

      if (!razorpay.isReady()) {
        return res.status(503).json({ success: false, message: 'Refund engine not configured' })
      }

      // Issue the refund. Mirrors adminController.resolveDispute refund path.
      let refundId = null
      try {
        const rp = await razorpay.instance.payments.refund(payment.razorpay_payment_id, {
          amount: total * 100,
          notes:  { job_id: String(job.id), source: 'self-serve', reason: reason.slice(0, 200) },
        })
        refundId = rp?.id || null
      } catch (err) {
        const psp = err?.error?.description || err.message
        return res.status(502).json({ success: false, message: `Refund failed: ${psp}` })
      }

      // Reverse the wallet credit (negative `credit` row, same convention
      // as the admin refund path).
      await db.transaction(async (trx) => {
        await trx('wallet_transactions').insert({
          id: txId(),
          partner_id: job.partner_id,
          job_id: job.id,
          type: 'credit',
          service: `Refund · Self-serve`,
          customer_name: job.customer_name || 'System',
          amount: -total, tip: 0, total: -total,
          cleared: true,
          eligible_at: trx.fn.now(),
          created_at:  trx.fn.now(),
        })
      })

      // Record as a self-resolved dispute so it shows up in the customer's
      // disputes timeline with a clean "Resolved — refund" entry.
      const [disputeId] = await db('disputes').insert({
        job_id: job.id,
        raised_by: req.user.uid, raised_role: 'user',
        partner_id: job.partner_id, customer_id: job.customer_id,
        reason: `Self-serve refund (₹${total}): ${reason}`,
        status: 'resolved',
        resolution: 'refund',
        resolution_note: 'Auto-refunded via self-serve (within 24h, ≤₹500).',
        admin_id: null,
        refund_amount: total,
        refund_id: refundId,
        under_review_at: db.fn.now(),
        resolved_at: db.fn.now(),
      })

      // Notify both sides.
      try {
        await Notification.create({
          user_id: job.customer_id, type: 'payment_received',
          title: `Refund issued · ₹${total}`,
          body:  'Your self-serve refund is on its way. Funds settle in 5–7 days.',
          icon: '💸', icon_bg: '#dcfce7',
          route: `/my-jobs/${job.id}`,
        })
      } catch { /* swallow */ }
      try {
        await Notification.create({
          user_id: job.partner_id, type: 'payment_received',
          title: `Refund of ₹${total} on ${job.service}`,
          body:  'Customer self-served a refund (within 24h, ≤₹500).',
          icon: '🔁', icon_bg: '#fee2e2',
          route: '/partner/wallet',
        })
      } catch { /* swallow */ }
      push.sendToUser(job.customer_id, {
        title: `Refund issued · ₹${total}`,
        body:  'Your refund is processing.',
        data: { type: 'self-serve:refund', jobId: job.id, route: `/my-jobs/${job.id}` },
      }).catch(() => {})
      push.sendToUser(job.partner_id, {
        title: `Refund issued on ${job.service}`,
        body:  `₹${total} reversed.`,
        data: { type: 'self-serve:refund', jobId: job.id, route: '/partner/wallet' },
      }).catch(() => {})

      emitToUser(job.partner_id, 'wallet:refund', { jobId: job.id, amount: total })

      const dispute = await db('disputes').where({ id: disputeId }).first()
      res.json(success('Refund issued', { auto: true, refundAmount: total, dispute }))
    } catch (err) { next(err) }
  },

  // POST /api/jobs/:id/self-serve/no-show  { reason }
  // Files a dispute tagged as no_show. We tag it in the reason text so the
  // admin queue can filter; we don't add a column for it given current
  // volume.
  noShow: async (req, res, next) => {
    try {
      const job = await guardCustomer(req, res); if (!job) return
      const reason = String(req.body?.reason || '').trim().slice(0, 2000)
      if (!reason) {
        return res.status(400).json({ success: false, message: 'Tell us what happened (or didn\'t).' })
      }
      const existing = await db('disputes').where({ job_id: job.id, status: 'open' }).first()
      if (existing) {
        return res.status(409).json({
          success: false, message: 'A dispute is already open for this job.', dispute: existing,
        })
      }
      const [id] = await db('disputes').insert({
        job_id: job.id,
        raised_by: req.user.uid, raised_role: 'user',
        partner_id: job.partner_id, customer_id: job.customer_id,
        reason: `[NO_SHOW] ${reason}`,
        status: 'open',
      })
      const dispute = await db('disputes').where({ id }).first()

      // Same fan-out as a normal dispute filing but with the no-show framing.
      try {
        await Notification.create({
          user_id: job.partner_id, type: 'dispute_opened',
          title: `No-show reported · ${job.service}`,
          body:  reason.slice(0, 120),
          icon: '🚫', icon_bg: '#fee2e2',
          route: `/partner/transactions/${job.id}`,
        })
      } catch { /* swallow */ }
      push.sendToUser(job.partner_id, {
        title: `No-show reported on ${job.service}`,
        body:  reason.slice(0, 120),
        data: { type: 'self-serve:no-show', jobId: job.id, route: `/partner/transactions/${job.id}` },
      }).catch(() => {})

      res.status(201).json(success('No-show reported', { dispute }))
    } catch (err) { next(err) }
  },
}
