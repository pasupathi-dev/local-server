const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const { requireRole } = require('../middleware/requireRole')
const c = require('../controllers/scheduledJobController')

// Customer creates the booking; either side may view/cancel; partner-side
// actions (accept / decline / start) are restricted to partners.
router.post('/',                 verifyToken, requireRole('user'),               c.create)
router.get('/mine',              verifyToken, requireRole('user', 'partner'),   c.mine)
router.post('/:id/accept',       verifyToken, requireRole('partner'),           c.accept)
router.post('/:id/decline',      verifyToken, requireRole('partner'),           c.decline)
router.post('/:id/cancel',       verifyToken, requireRole('user', 'partner'),   c.cancel)
router.post('/:id/start',        verifyToken, requireRole('partner'),           c.start)
// M82 — Reschedule proposal + response. Both sides can propose; the OTHER
// side accepts/declines.
router.post('/:id/reschedule',         verifyToken, requireRole('user', 'partner'), c.proposeReschedule)
router.post('/:id/reschedule/respond', verifyToken, requireRole('user', 'partner'), c.respondReschedule)

module.exports = router
