const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const c = require('../controllers/notificationController')

router.get('/',                verifyToken, c.list)
router.post('/:id/read',       verifyToken, c.markRead)
router.post('/read-all',       verifyToken, c.markAllRead)

// FCM device registration. Both apps (customer + partner) call /devices on
// startup with the browser's FCM token, and DELETE on logout.
router.post('/devices',          verifyToken, c.registerDevice)
router.delete('/devices/:token', verifyToken, c.unregisterDevice)

module.exports = router
