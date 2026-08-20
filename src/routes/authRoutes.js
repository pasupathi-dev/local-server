const router = require('express').Router()
const authController   = require('../controllers/authController')
const { verifyToken }  = require('../middleware/auth')

router.post('/sync',     verifyToken, authController.syncUser)
router.get('/me',        verifyToken, authController.getMe)
router.delete('/delete', verifyToken, authController.deleteUser)
// L79 — self-serve account deletion with 7-day grace window.
router.post('/delete-request', verifyToken, authController.requestDeletion)
router.post('/delete-cancel',  verifyToken, authController.cancelDeletion)

// Onboarding
router.post('/role',     verifyToken, authController.pickRole)
router.patch('/profile', verifyToken, authController.saveProfile)
router.post('/finish-onboarding', verifyToken, authController.finishOnboarding)

// Admin
router.patch('/status',  verifyToken, authController.updateStatus)
router.patch('/role-admin', verifyToken, authController.updateRole)

module.exports = router
