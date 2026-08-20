const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const categoryController = require('../controllers/categoryController')

router.get('/',                  verifyToken, categoryController.list)
router.get('/search',            verifyToken, categoryController.search)
router.get('/:category/works',   verifyToken, categoryController.works)

module.exports = router
