const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const { requireRole } = require('../middleware/requireRole')
const c = require('../controllers/disputeController')

// Either side of a job may raise a dispute.
router.post('/',                verifyToken, requireRole('user', 'partner'), c.create)
router.get('/mine',             verifyToken, requireRole('user', 'partner'), c.mine)
router.get('/by-job/:jobId',    verifyToken, requireRole('user', 'partner'), c.byJob)
// H64 — single dispute (with timeline columns) + partner response endpoint.
router.get('/:id',              verifyToken, requireRole('user', 'partner'), c.detail)
router.post('/:id/respond',     verifyToken, requireRole('partner'),         c.respond)

module.exports = router
