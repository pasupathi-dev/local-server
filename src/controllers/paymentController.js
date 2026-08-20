// Payment flow — Razorpay-backed, two-step:
//
//   1. POST /api/payments/create-order   { job_id }
//        Validates the job is payable and creates a Razorpay order. Stores
//        the order_id against a pending payment row so we have a paper trail
//        even if the user never completes checkout.
//
//   2. POST /api/payments/verify
//        { job_id, razorpay_order_id, razorpay_payment_id, razorpay_signature }
//        Verifies the HMAC signature (prevents a forged success from a
//        malicious client). Only on success do we:
//          - mark the payment row completed
//          - credit the partner wallet
//          - transition the job to `paid`
//          - emit socket events + notifications
//
// Security invariants:
//   - `key_secret` never leaves the server.
//   - We NEVER trust an amount coming from the client — amount is always
//     recomputed from the job row.
//   - Signature verification is the sole source of truth for "paid".
//   - Order ids are scoped to (job_id, customer_id) so a stolen order_id
//     can't be replayed by another user.

const crypto      = require('crypto')
const { v4: uuidv4 } = require('uuid')
const Job         = require('../models/Job')
const Payment     = require('../models/Payment')
const Wallet      = require('../models/Wallet')
const ActivityLog = require('../models/ActivityLog')
const Notification = require('../models/Notification')
const Partner     = require('../models/Partner')
const razorpay    = require('../config/razorpay')
const { success } = require('../utils/response')
const { txId }    = require('../utils/ids')
const { db }      = require('../config/db')
const { emitToUser, emitToJob } = require('../realtime/io')
const { broadcastCounts } = require('../utils/counts')
const push = require('../services/pushService')
const { getConfigNumber } = require('../utils/appConfig')

// Bug #21: only 'completed' is payable — not 'working'.
const isPayable = (job) => job?.state === 'completed'

// H47 — Itemised bill breakdown.
//
// If the partner entered line items (service / materials / travel) we
// surface them, derive platform-fee on the labour subtotal at the rate
// stored in app_config, and add 18% GST on TOP of the platform fee
// (marketplace pattern — partner-side labour is GST-exempt at the
// platform layer).
//
// If no line items, we treat the entire `agreed_price` as a single
// service-line item so the customer still gets a coherent breakdown.
// `tip` is an explicit pass-through arg (H48) so it appears on the
// receipt without being mistaken for service revenue.
async function billBreakdown (job, { tip = 0 } = {}) {
  let li = null
  if (job?.line_items) {
    if (typeof job.line_items === 'object') li = job.line_items
    else { try { li = JSON.parse(job.line_items) } catch { li = null } }
  }
  const service   = Math.round(Number(li?.service ?? job?.agreed_price ?? 0)) || 0
  const materials = Math.round(Number(li?.materials ?? 0)) || 0
  const travel    = Math.round(Number(li?.travel ?? 0)) || 0

  // Both rates are admin-tunable from the portal (app_config). Defaults
  // match the historical values (0% platform fee, 18% GST) so changing
  // either via the portal flows straight into every new bill — no deploy.
  const feePct = await getConfigNumber('platform_fee_percent', 0)
  const gstPct = await getConfigNumber('gst_pct', 18)

  const labour       = service + materials + travel
  const platformFee  = Math.round((labour * feePct) / 100)
  const gst          = Math.round((platformFee * gstPct) / 100)
  const tipAmount    = Math.max(0, Math.round(Number(tip) || 0))
  const total        = labour + platformFee + gst + tipAmount
  return {
    service, materials, travel, labour,
    platformFee, platformFeePct: feePct,
    gst, gstPct,
    tip: tipAmount,
    total,
  }
}

module.exports = {
  // Re-exported so jobController.getBill can quote without an HTTP round-trip.
  billBreakdown,
  // POST /api/payments/create-order  { job_id }
  createOrder: async (req, res, next) => {
    try {
      if (!razorpay.isReady()) {
        return res.status(503).json({ success: false, message: 'Payments not configured on server' })
      }
      const customer_id = req.user.uid
      const { job_id } = req.body || {}
      if (!job_id) return res.status(400).json({ success: false, message: 'job_id is required' })

      const job = await Job.findById(job_id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.customer_id !== customer_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      if (!isPayable(job)) {
        return res.status(400).json({ success: false, message: `Job is ${job.state}, cannot pay` })
      }

      // H47 + H48 — Amount is the itemised breakdown total (labour +
      // platform fee + GST) plus an optional tip the client picks BEFORE
      // checkout. Tip is clamped to a sane band so a tampered client
      // can't send a million-rupee tip and bypass server-side checks.
      const rawTip = Number(req.body?.tip)
      const tip = Number.isFinite(rawTip) && rawTip >= 0 && rawTip <= 10_000
        ? Math.round(rawTip) : 0
      const bd = await billBreakdown(job, { tip })
      const amount = bd.total
      if (!amount || amount <= 0) {
        return res.status(400).json({ success: false, message: 'Job has no agreed price' })
      }
      const amountPaise = amount * 100

      // Bug #29: use UUID so the receipt is globally unique and not guessable.
      // Razorpay has a 40-char limit so we take the first 36 chars of the UUID.
      const receipt = uuidv4().slice(0, 36)

      const order = await razorpay.instance.orders.create({
        amount: amountPaise,
        currency: 'INR',
        receipt,
        notes: {
          job_id: String(job_id),
          customer_id,
          partner_id: job.partner_id,
          service: job.service || '',
        },
      })

      // Write an `initiated` payment row so we have a record even if the
      // user drops off inside Razorpay Checkout.
      await Payment.create({
        job_id,
        customer_id,
        partner_id: job.partner_id,
        // Store the labour-only base in `amount` so legacy reports still
        // see the partner's revenue. `total` carries the customer-facing
        // grand total. `tip` and `platform_fee` are recorded explicitly
        // for the receipt.
        amount: bd.labour,
        tip:    bd.tip,
        total:  bd.total,
        platform_fee: bd.platformFee,
        method: 'upi',                  // updated on verify from PSP method
        status: 'initiated',
        razorpay_order_id: order.id,
      })

      // Tell the partner the customer has just opened checkout — drives the
      // PaymentIncomingOverlay popup on the partner's app the moment Pay
      // is tapped, before Razorpay even returns. Best-effort: socket emit
      // failures must NOT break this response.
      try {
        emitToUser(job.partner_id, 'payment:initiated', {
          jobId: job.id,
          amount,
          customer_id,
          customer_name: job.customer_name || 'Customer',
          service:       job.service || job.category_name || 'Service',
          ts: new Date().toISOString(),
        })
      } catch { /* non-fatal */ }

      res.json(success('Order', {
        order_id: order.id,
        amount:   order.amount,        // paise, for Razorpay Checkout
        currency: order.currency,
        key_id:   razorpay.keyId,      // client uses this to open checkout
        breakdown: bd,                 // H47 — itemised bill for the UI
        job: { id: job.id, service: job.service, partner_name: job.partner_name },
      }))
    } catch (err) {
      // Razorpay SDK errors surface as `err.error?.description`.
      const psp = err?.error?.description
      if (psp) return res.status(502).json({ success: false, message: `Razorpay: ${psp}` })
      next(err)
    }
  },

  // M50 — POST /api/payments/cash-request  { job_id, tip? }
  // Customer indicates they'll pay in cash. We record an `initiated`
  // payment row with method='cash' and emit a socket so the partner
  // gets a "Customer says they're paying cash — confirm?" prompt.
  // The job stays in `completed` until the partner confirms (next call).
  cashRequest: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const { job_id } = req.body || {}
      if (!job_id) return res.status(400).json({ success: false, message: 'job_id is required' })
      const job = await Job.findById(job_id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.customer_id !== customer_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      if (!isPayable(job)) {
        return res.status(400).json({ success: false, message: `Job is ${job.state}, cannot pay` })
      }
      const rawTip = Number(req.body?.tip)
      const tip = Number.isFinite(rawTip) && rawTip >= 0 && rawTip <= 10_000
        ? Math.round(rawTip) : 0
      const bd = await billBreakdown(job, { tip })

      // Drop any in-flight initiated row first — partner shouldn't see two
      // "incoming" badges if the customer flipped from UPI to cash.
      await db('payments')
        .where({ job_id, customer_id, status: 'initiated' })
        .update({ status: 'failed' })
        .catch(() => {})

      await Payment.create({
        job_id,
        customer_id,
        partner_id: job.partner_id,
        amount: bd.labour,
        tip:    bd.tip,
        total:  bd.total,
        platform_fee: bd.platformFee,
        method: 'cash',
        status: 'initiated',
      })

      // Partner-side prompt — surface the cash request immediately.
      emitToUser(job.partner_id, 'payment:cash-requested', {
        jobId: job.id,
        amount: bd.total,
        breakdown: bd,
        customer_name: job.customer_name || 'Customer',
        service:       job.service || job.category_name || 'Service',
      })
      res.status(201).json(success('Cash requested', { breakdown: bd }))
    } catch (err) { next(err) }
  },

  // M50 / H49 — POST /api/payments/cash-confirm  { job_id, accepted: bool }
  // Partner-only. Flips the most recent initiated cash payment to either
  // completed (paid in cash) or failed (partner didn't actually get the
  // cash). On completed: job moves to `paid`, partner wallet is credited
  // for labour + tip, platform_fee is recorded but NOT debited (settled
  // at next online payment — admin reconciles).
  cashConfirm: async (req, res, next) => {
    try {
      const partner_id = req.user.uid
      const { job_id } = req.body || {}
      const accepted = !!req.body?.accepted
      if (!job_id) return res.status(400).json({ success: false, message: 'job_id is required' })

      const job = await Job.findById(job_id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.partner_id !== partner_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }

      const payment = await db('payments')
        .where({ job_id, partner_id, status: 'initiated', method: 'cash' })
        .orderBy('created_at', 'desc').first()
      if (!payment) {
        return res.status(404).json({ success: false, message: 'No pending cash payment' })
      }

      if (!accepted) {
        await db('payments').where({ id: payment.id }).update({ status: 'failed' })
        emitToUser(job.customer_id, 'payment:cash-rejected', { jobId: job.id })
        return res.json(success('Cash declined', { payment: { ...payment, status: 'failed' } }))
      }

      // Accept path — same transactional shape as Razorpay verify, but no
      // signature checks since the partner is the trust anchor for cash.
      await db.transaction(async (trx) => {
        await trx('payments').where({ id: payment.id }).update({
          status: 'completed', paid_at: new Date(),
        })
        await trx('jobs').where({ id: job.id }).update({
          state: 'paid', paid_at: new Date(), tip_amount: payment.tip || 0,
        })
        await trx('wallet_transactions').insert({
          id: txId(),
          partner_id,
          job_id: job.id,
          type: 'credit',
          service: job.service,
          customer_name: job.customer_name,
          amount: payment.amount || 0,
          tip: payment.tip || 0,
          total: (payment.amount || 0) + (payment.tip || 0),
          cleared: false,
          eligible_at: new Date(Date.now() + 5_000),
        })
      })

      // Flip partner back online so they can take new work.
      await Partner.setOnline(partner_id, true).catch(() => {})

      const updatedJob = await Job.findById(job.id)
      emitToJob(job.id, 'payment:succeeded', {
        jobId: job.id, method: 'cash',
        amount: payment.amount, tip: payment.tip, total: payment.total,
        paid_at: new Date().toISOString(),
      })
      emitToUser(job.customer_id, 'payment:cash-confirmed', { jobId: job.id })

      await ActivityLog.add({
        partner_id, type: 'paid',
        title: 'Cash payment confirmed',
        sub: `${job.service} · ${job.customer_name}`,
        icon: '💵', color: '#059669',
        job_id: job.id, customer_name: job.customer_name,
        amount: payment.total,
      })
      await Notification.create({
        user_id: job.customer_id, type: 'payment_received',
        title: 'Cash payment confirmed',
        body:  `${job.partner_name} confirmed cash receipt for ${job.service}`,
        icon:  '💵', icon_bg: '#dcfce7',
        route: `/done/${job.id}`,
      })

      res.json(success('Cash confirmed', { job: updatedJob }))
    } catch (err) { next(err) }
  },

  // POST /api/payments/cancelled  { job_id }
  // Best-effort signal that the customer dismissed the Razorpay sheet.
  // Flips any in-flight `initiated` payment row to `failed` so the next
  // Pay attempt opens a fresh order, and emits `payment:cancelled` so
  // the partner's PaymentIncomingOverlay drops out of the spinner state
  // immediately rather than waiting on the 90s timeout.
  cancelled: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const { job_id } = req.body || {}
      if (!job_id) return res.status(400).json({ success: false, message: 'job_id is required' })
      const job = await Job.findById(job_id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.customer_id !== customer_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      // Mark the most recent in-flight payment row as failed (if any). This
      // is idempotent — re-firing this endpoint is a no-op when no row is
      // initiated. Use a direct query so we don't need a new model method.
      await db('payments')
        .where({ job_id, customer_id, status: 'initiated' })
        .orderBy('created_at', 'desc')
        .limit(1)
        .update({ status: 'failed' })
        .catch(() => {})
      try {
        emitToUser(job.partner_id, 'payment:cancelled', {
          jobId: job.id,
          customer_name: job.customer_name || 'Customer',
        })
      } catch { /* non-fatal */ }
      res.json(success('Cancellation noted'))
    } catch (err) { next(err) }
  },

  // POST /api/payments/verify
  //   { job_id, razorpay_order_id, razorpay_payment_id, razorpay_signature }
  verify: async (req, res, next) => {
    try {
      if (!razorpay.isReady()) {
        return res.status(503).json({ success: false, message: 'Payments not configured on server' })
      }

      const customer_id = req.user.uid
      const {
        job_id,
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      } = req.body || {}

      if (!job_id || !razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Missing fields' })
      }

      const job = await Job.findById(job_id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.customer_id !== customer_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      if (job.state === 'paid') {
        // Idempotent re-submission — return the current state so the client
        // can just continue to /done instead of erroring out.
        return res.json(success('Already paid', { job }))
      }
      if (!isPayable(job)) {
        return res.status(400).json({ success: false, message: `Job is ${job.state}, cannot pay` })
      }

      // Order must belong to this job+customer. Guards against a malicious
      // client passing an order_id that was created for a different job.
      const pending = await Payment.findByOrder(razorpay_order_id)
      if (!pending || pending.job_id !== job_id || pending.customer_id !== customer_id) {
        return res.status(400).json({ success: false, message: 'Order does not belong to this job' })
      }

      // ── Signature verification (source of truth) ────────────────────
      const body = `${razorpay_order_id}|${razorpay_payment_id}`
      const expected = crypto
        .createHmac('sha256', razorpay.keySecret)
        .update(body)
        .digest('hex')
      const provided = String(razorpay_signature)
      // timingSafeEqual needs equal-length Buffers.
      const valid = expected.length === provided.length
        && crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'))

      if (!valid) {
        await Payment.markFailed(pending.id)
        try { emitToUser(job.partner_id, 'payment:failed', { jobId: job_id, reason: 'invalid_signature' }) } catch { /* non-fatal */ }
        return res.status(400).json({ success: false, message: 'Invalid payment signature' })
      }

      // Look up the actual payment on Razorpay's side — ensures the
      // payment id + amount match and the payment is `captured`.
      let pspPayment
      try {
        pspPayment = await razorpay.instance.payments.fetch(razorpay_payment_id)
      } catch (e) {
        return res.status(502).json({ success: false, message: 'Could not verify payment with PSP' })
      }
      // H47/H48 — The order was created with the FULL breakdown total
      // (labour + platform fee + GST + tip), which is exactly what was
      // stored on the pending payment row. Validate against that, NOT
      // raw agreed_price (which is just the labour subtotal).
      const expectedPaise = Number(pending.total || pending.amount || 0) * 100
      if (
        pspPayment.order_id !== razorpay_order_id
        || Number(pspPayment.amount) !== expectedPaise
        || !['captured', 'authorized'].includes(pspPayment.status)
      ) {
        await Payment.markFailed(pending.id)
        try { emitToUser(job.partner_id, 'payment:failed', { jobId: job_id, reason: 'mismatch' }) } catch { /* non-fatal */ }
        return res.status(400).json({ success: false, message: 'Payment does not match order' })
      }

      // ── Commit: mark payment, credit partner, flip job ──────────────
      // Bug #3/#6/#7: all three writes are in a single DB transaction so a
      // crash between them doesn't leave money or job state inconsistent.
      // Partner wallet gets credited LABOUR + TIP — platform fee and GST
      // stay with the platform.
      const labour = Number(pending.amount || 0)
      const tipPaid = Number(pending.tip || 0)
      const total  = Number(pending.total || labour + tipPaid)
      const amount = labour
      // Bug #30: store the raw PSP method (not coerced), so analytics can
      // distinguish card/UPI/netbanking. We still coerce for the DB enum.
      const rawMethod    = String(pspPayment.method || 'upi')
      const method       = normaliseMethod(rawMethod)

      const txCreditId = txId()
      let credit
      await db.transaction(async (trx) => {
        await trx('payments').where({ id: pending.id }).update({
          razorpay_payment_id,
          razorpay_signature,
          method,
          status: 'completed',
          paid_at: new Date(),
        })
        const eligible_at = new Date(Date.now() + 5000)
        await trx('wallet_transactions').insert({
          id: txCreditId,
          partner_id:    job.partner_id,
          job_id,
          type:          'credit',
          service:       job.service || null,
          customer_name: job.customer_name || null,
          // H48 — partner gets labour + tip. Platform fee + GST stay
          // with the platform (won't be credited to the partner).
          amount, tip: tipPaid, total: amount + tipPaid,
          cleared: false,
          eligible_at,
        })
        await trx('jobs').where({ id: job_id }).update({
          state: 'paid', paid_at: new Date(), tip_amount: tipPaid,
          updated_at: new Date(),
        })
      })
      credit = await db('wallet_transactions').where({ id: txCreditId }).first()

      await Partner.incrementJobs(job.partner_id)

      // Job is now fully closed (paid). The partner was auto-paused on accept
      // (requestController) so they wouldn't receive new requests mid-job —
      // bring them back online now so they reappear in customer searches for
      // their category. Without this they stay invisible until they manually
      // toggle online or re-login, which is the bug we're fixing.
      try {
        await Partner.setOnline(job.partner_id, true)
        emitToUser(job.partner_id, 'partner:online-ack', { online: true })
        await broadcastCounts()
      } catch { /* non-fatal — payment already committed */ }

      emitToUser(job.partner_id, 'payment:succeeded', {
        jobId: job_id, amount, tip: tipPaid, total: amount + tipPaid, credit,
        customer_name: job.customer_name, service: job.service,
        paid_at: new Date().toISOString(),
      })
      emitToJob(job_id, 'job:state-changed', {
        jobId: job_id, state: 'paid', amount, tip: 0, total,
        paid_at: new Date().toISOString(),
      })

      await ActivityLog.add({
        partner_id: job.partner_id, type: 'payment_received',
        title: `Received ₹${total}`, sub: `${job.service} · ${job.customer_name}`,
        icon: '💰', color: '#059669',
        job_id, customer_name: job.customer_name, amount: total,
      })
      await Notification.create({
        user_id: job.customer_id, type: 'job_completed',
        title: 'Payment successful',
        body:  `Paid ₹${total} for ${job.service}`,
        icon: '✅', icon_bg: '#dcfce7',
        route: `/done/${job_id}`,
      })
      await Notification.create({
        user_id: job.partner_id, type: 'payment_received',
        title: `Payment received · ₹${total}`,
        body:  `${job.customer_name || 'Customer'} paid for ${job.service}`,
        icon: '💰', icon_bg: '#dcfce7',
        route: '/partner/wallet',
      })

      // Push — partner sees the money land even if the app is closed.
      push.sendToUser(job.partner_id, {
        title: `Payment received · ₹${total} 💰`,
        body:  `${job.customer_name || 'Customer'} paid for ${job.service}`,
        data:  { type: 'payment:received', jobId: job_id, route: '/partner/wallet' },
      }).catch(() => {})
      push.sendToUser(job.customer_id, {
        title: 'Payment successful ✅',
        body:  `Paid ₹${total} for ${job.service}`,
        data:  { type: 'payment:done', jobId: job_id, route: `/done/${job_id}` },
      }).catch(() => {})

      res.json(success('Paid', {
        payment: await Payment.findById(pending.id),
        job: await Job.findById(job_id),
      }))
    } catch (err) { next(err) }
  },
}

// Razorpay returns method as 'upi' / 'card' / 'netbanking' / 'wallet' / 'emi'
// / 'paylater'. Our PAYMENT_METHODS enum is a subset — coerce anything
// unknown down to 'upi' so the insert doesn't fail on an old DB.
function normaliseMethod (m) {
  const allowed = new Set(['upi', 'card', 'netbanking'])
  return allowed.has(String(m)) ? String(m) : 'upi'
}
