const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const { requireRole } = require('../middleware/requireRole')
const c = require('../controllers/paymentController')

// Razorpay two-step flow — customer-initiated only.
router.post('/create-order', verifyToken, requireRole('user'), c.createOrder)
router.post('/verify',       verifyToken, requireRole('user'), c.verify)
// Customer dismissed the Razorpay sheet — best-effort signal so the
// partner's payment popup flips to "cancelled" instead of sitting on the
// 90s anti-stuck timer. Idempotent + tolerant: failure is non-fatal.
router.post('/cancelled',    verifyToken, requireRole('user'), c.cancelled)
// M50 — Cash payments. Customer requests; partner confirms / declines.
router.post('/cash-request', verifyToken, requireRole('user'),    c.cashRequest)
router.post('/cash-confirm', verifyToken, requireRole('partner'), c.cashConfirm)

module.exports = router
