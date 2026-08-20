const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const { requireRole } = require('../middleware/requireRole')
const c = require('../controllers/jobController')
const receipt = require('../controllers/receiptController')
const selfServe = require('../controllers/selfServeController')

router.get('/active',         verifyToken, c.active)
router.get('/mine',           verifyToken, c.mine)
router.get('/:id',            verifyToken, c.detail)
router.post('/:id/state',     verifyToken, c.setState)
router.post('/:id/price',     verifyToken, c.proposePrice)
// C46 — Customer Accepts / Rejects a pending price-change proposal.
router.post('/:id/price-change/respond', verifyToken, c.respondPriceChange)
router.post('/:id/cancel',    verifyToken, c.cancel)
// M43 — Partner attaches before/after photos to a job.
router.patch('/:id/completion-photos', verifyToken, c.setCompletionPhotos)
// H47 — Itemised bill: partner sets, both sides quote.
router.patch('/:id/line-items',        verifyToken, c.setLineItems)
router.get('/:id/bill',                verifyToken, c.getBill)
// M51 — PDF receipt download. Auth via Firebase header.
router.get('/:id/receipt',             verifyToken, receipt.getReceipt)
// M44 — Partner proposes mid-job extra work; customer Approve / Decline.
router.get('/:id/extra-work',          verifyToken, c.listExtraWork)
router.post('/:id/extra-work',         verifyToken, c.proposeExtraWork)
router.post('/:id/extra-work/respond', verifyToken, c.respondExtraWork)
// M67 — customer self-serve resolutions.
router.post('/:id/self-serve/reschedule', verifyToken, requireRole('user'), selfServe.reschedule)
router.post('/:id/self-serve/refund',     verifyToken, requireRole('user'), selfServe.refund)
router.post('/:id/self-serve/no-show',    verifyToken, requireRole('user'), selfServe.noShow)

// Live partner location ping — server gates on partner_id + state inside.
router.post('/:id/location',  verifyToken, c.streamLocation)
// Cold-start seed for the customer map — returns the partner's last-known
// coords so the marker renders before the next stream tick arrives.
router.get('/:id/location',   verifyToken, c.getLastLocation)

module.exports = router
