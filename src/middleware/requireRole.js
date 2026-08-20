// src/middleware/requireRole.js
// ─────────────────────────────────────────────
// Restricts a route to one or more roles. Always runs *after* verifyToken,
// since it relies on req.user.uid to look up the role from our DB.
//
// Usage:
//   router.post('/withdraw', verifyToken, requireRole('partner'), c.withdraw)
//   router.post('/',         verifyToken, requireRole('user'),    c.create)
//   router.get('/:id',       verifyToken, requireRole('user','partner'), c.detail)
//
// We read the role from the DB (not from the Firebase token) so that role
// changes take effect immediately and tokens can't lie about their role.
// ─────────────────────────────────────────────

const User = require('../models/User')

const requireRole = (...allowed) => async (req, res, next) => {
  try {
    if (!req.user?.uid) {
      return res.status(401).json({ success: false, message: 'Not authenticated' })
    }

    const row = await User.findByUid(req.user.uid)
    if (!row) {
      return res.status(403).json({ success: false, message: 'No profile found for this account' })
    }

    if (!allowed.includes(row.role)) {
      return res.status(403).json({
        success: false,
        message: `Forbidden — this action is restricted to: ${allowed.join(', ')}`,
        role: row.role,
      })
    }

    req.user.role = row.role
    next()
  } catch (err) { next(err) }
}

module.exports = { requireRole }
