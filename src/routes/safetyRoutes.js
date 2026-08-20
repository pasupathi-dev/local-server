const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const { requireRole } = require('../middleware/requireRole')
const c = require('../controllers/safetyController')

// Customer-only writes — partner can't fire safety alerts on themselves.
router.post('/sos',           verifyToken, requireRole('user'),    c.sos)
router.post('/share-trip',    verifyToken, requireRole('user'),    c.shareTrip)
// H39 — Self-share track link (no SMS, just mints the token).
router.post('/track-link',    verifyToken, requireRole('user'),    c.trackLink)
// Partner-side share-trip — partner heading to a job lets a contact follow.
router.post('/partner-share', verifyToken, requireRole('partner'), c.partnerShareTrip)

// Public live tracking — no auth, the bearer token IS the auth.
router.get('/track/:token', c.publicTrack)

module.exports = router
