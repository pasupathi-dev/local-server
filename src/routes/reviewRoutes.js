const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const { requireRole } = require('../middleware/requireRole')
const c = require('../controllers/reviewController')

// Pending review nag — checked by the customer client on app load and
// before booking actions. Skip records the dismissal so we don't re-ask.
router.get('/pending',         verifyToken, requireRole('user'),               c.pending)
router.post('/skip',           verifyToken, requireRole('user'),               c.skip)

router.post('/',                 verifyToken, requireRole('user'),               c.create)             // customer → partner
router.post('/customer',         verifyToken, requireRole('partner'),            c.rateCustomer)       // partner → customer
router.get('/customer/:job_id',  verifyToken, requireRole('partner'),            c.getCustomerRating)  // partner reads own rating
router.get('/partner/:id',       verifyToken, requireRole('user', 'partner'),   c.listForPartner)
// H60 — aspect chip aggregate for the partner profile.
router.get('/partner/:id/aspects', verifyToken, requireRole('user', 'partner'), c.aspectsForPartner)
// M61 — partner replies to their own review.
router.post('/:id/reply',          verifyToken, requireRole('partner'),         c.reply)
// M62 — customer attaches a private "what went wrong" follow-up to a ≤2★ review.
router.post('/:id/support',        verifyToken, requireRole('user'),            c.supportFollowup)

module.exports = router
