const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const c = require('../controllers/settingsController')

router.get('/',    verifyToken, c.get)
router.patch('/',  verifyToken, c.update)

module.exports = router
