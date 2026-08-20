const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const c = require('../controllers/messageController')

router.get('/:jobId',                 verifyToken, c.list)
router.post('/:jobId',                verifyToken, c.send)
router.patch('/:jobId/:messageId',    verifyToken, c.update)
router.delete('/:jobId/:messageId',   verifyToken, c.remove)
router.post('/:jobId/read',           verifyToken, c.markRead)

module.exports = router
