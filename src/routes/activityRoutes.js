const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const c = require('../controllers/activityController')

router.get('/', verifyToken, c.list)

module.exports = router
