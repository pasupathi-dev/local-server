const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const { requireRole } = require('../middleware/requireRole')
const c = require('../controllers/trustedContactController')

// Customer-only — partners don't have trusted contacts in this iteration.
router.get('/',         verifyToken, requireRole('user'), c.list)
router.post('/',        verifyToken, requireRole('user'), c.create)
router.patch('/:id',    verifyToken, requireRole('user'), c.update)
router.delete('/:id',   verifyToken, requireRole('user'), c.remove)

module.exports = router
