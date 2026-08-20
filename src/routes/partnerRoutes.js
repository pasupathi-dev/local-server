const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const { requireRole } = require('../middleware/requireRole')
const c = require('../controllers/partnerController')
const flag = require('../controllers/partnerFlagController')
const blocked = require('../controllers/partnerBlockedDatesController')

// Authed partner's own profile / dashboard — partner-only.
router.get('/me',           verifyToken, requireRole('partner'), c.me)
router.patch('/me',         verifyToken, requireRole('partner'), c.updateMe)
router.post('/online',      verifyToken, requireRole('partner'), c.setOnline)
router.post('/location',    verifyToken, requireRole('partner'), c.setLocation)
router.get('/me/dashboard', verifyToken, requireRole('partner'), c.dashboard)
// M83 — Partner-side day-off blocks.
router.get('/me/blocked-dates',         verifyToken, requireRole('partner'), blocked.listMine)
router.post('/me/blocked-dates',        verifyToken, requireRole('partner'), blocked.create)
router.delete('/me/blocked-dates/:id',  verifyToken, requireRole('partner'), blocked.remove)

// Public list + detail — customers browsing partners.
router.get('/',                verifyToken, requireRole('user'), c.list)
router.get('/:id',             verifyToken, requireRole('user'), c.detail)
router.get('/:id/reviews',     verifyToken, requireRole('user'), c.listReviews)
// M68 — flag a partner. Customer-only.
router.post('/:id/flag',       verifyToken, requireRole('user'), flag.create)
router.get('/:id/flags/mine',  verifyToken, requireRole('user'), flag.mine)
// M83 — Customer-facing read of a partner's blocked dates (drives the
// scheduling picker so blocked days are hidden).
router.get('/:id/blocked-dates', verifyToken, requireRole('user'), blocked.listForPartner)

module.exports = router
