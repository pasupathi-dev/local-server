const { db } = require('../config/db')
const TABLE  = 'payments'

const Payment = {
  create: async (payload) => {
    const [id] = await db(TABLE).insert(payload)
    return Payment.findById(id)
  },

  findById: (id) => db(TABLE).where({ id }).first(),

  // Lookup a pending payment by the Razorpay order id — used during verify
  // so we can match the incoming (order_id, payment_id, signature) tuple
  // back to the job + customer we opened the order for.
  findByOrder: (razorpay_order_id) =>
    db(TABLE).where({ razorpay_order_id }).orderBy('created_at', 'desc').first(),

  findForJob: (job_id) => db(TABLE).where({ job_id }).orderBy('created_at', 'desc').first(),

  markPaid: (id) => db(TABLE).where({ id }).update({ status: 'completed', paid_at: db.fn.now() }),

  markFailed: (id) => db(TABLE).where({ id }).update({ status: 'failed' }),

  // Patch a payment row after a successful signature verification. Called
  // from paymentController.verify — writes both the PSP identifiers and
  // the completed status in one update so partially-updated rows never
  // exist.
  updateOnVerify: (id, { razorpay_payment_id, razorpay_signature, method, status, paid_at }) =>
    db(TABLE).where({ id }).update({
      razorpay_payment_id,
      razorpay_signature,
      method,
      status,
      paid_at,
    }),
}

module.exports = Payment
