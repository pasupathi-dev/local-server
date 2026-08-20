const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const { requireRole } = require('../middleware/requireRole')
const c = require('../controllers/favouriteController')

// Customer-only — partners don't save other partners.
router.get('/',              verifyToken, requireRole('user'), c.list)
router.get('/ids',           verifyToken, requireRole('user'), c.ids)
router.post('/',             verifyToken, requireRole('user'), c.add)
router.delete('/:partner_id', verifyToken, requireRole('user'), c.remove)

module.exports = router
