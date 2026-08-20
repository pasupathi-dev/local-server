const { verifyToken } = require('./auth')
const { db } = require('../config/db')

const requireAdmin = async (req, res, next) => {
  verifyToken(req, res, async () => {
    try {
      const user = await db('users').where({ user_id: req.user.uid }).whereNull('deleted_at').first()
      // Two ways to be allowed into the portal:
      //   1. role === 'admin'   (dedicated admin account)
      //   2. is_admin === true  (a regular user/partner who was granted access)
      const isAdmin = !!user && (user.role === 'admin' || !!user.is_admin)
      if (!isAdmin) {
        return res.status(403).json({ success: false, message: 'Admin access required.' })
      }
      req.adminUser = user
      next()
    } catch (err) {
      next(err)
    }
  })
}

module.exports = { requireAdmin }
