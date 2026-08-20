const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const c = require('../controllers/supportController')

router.post('/bug', verifyToken, c.reportBug)

module.exports = router
