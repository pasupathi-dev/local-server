const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const { requireRole } = require('../middleware/requireRole')
const c = require('../controllers/requestController')

// Customers create / cancel requests; partners accept / decline.
router.post('/',            verifyToken, requireRole('user'),               c.create)
router.post('/auto',        verifyToken, requireRole('user'),               c.autoCreate)
router.get('/live',         verifyToken, requireRole('partner'),            c.listLive)
// Customer's current in-flight search (most recent live request) — used to
// resume the waiting UI after a refresh and to drive the global "searching"
// bar. MUST be declared before '/:id' so it isn't captured as id='active'.
router.get('/active',       verifyToken, requireRole('user'),               c.activeForCustomer)
router.get('/:id',          verifyToken, requireRole('user', 'partner'),   c.detail)
router.post('/:id/accept',  verifyToken, requireRole('partner'), c.accept)
router.post('/:id/decline', verifyToken, requireRole('partner'), c.decline)
router.post('/:id/cancel',  verifyToken, requireRole('user'),    c.cancel)
router.post('/:id/fanout',  verifyToken, requireRole('user'),    c.fanout)
router.post('/:id/snooze',  verifyToken, requireRole('partner'), c.snooze)

module.exports = router
