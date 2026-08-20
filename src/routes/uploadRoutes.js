const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const { requireRole } = require('../middleware/requireRole')
const c = require('../controllers/uploadController')

// Customer-only — partners don't upload request photos.
router.post('/request-photo', verifyToken, requireRole('user'), c.requestPhoto)
// M43 — Partner-only — uploads a before/after job photo.
router.post('/job-photo',     verifyToken, requireRole('partner'), c.jobPhoto)
// L78 — any authed user can upload / remove their profile photo.
router.post('/avatar',        verifyToken, c.avatar)
router.delete('/avatar',      verifyToken, c.removeAvatar)
// Generic authed image upload (e.g. portal category images).
router.post('/image',         verifyToken, c.image)

module.exports = router
