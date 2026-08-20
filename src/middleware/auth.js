// src/middleware/auth.js
// ─────────────────────────────────────────────
// Middleware that runs on every protected route.
//
// Flow (default Bearer):
//   1. Frontend sends:  Authorization: Bearer <idToken>
//   2. This middleware calls Firebase Admin to verify the token
//   3. If valid → attaches req.user = { uid, email, name }
//   4. If invalid → returns 401
//
// H90 — Impersonate flow:
//   1. Portal mints a short-lived HMAC token (utils/impersonate.js)
//   2. Frontend sends: Authorization: Impersonate <hmac-token>
//   3. We HMAC-verify; req.user = { uid, impersonatedBy, readOnly: true }
//   4. writeGuard rejects any non-GET request from a readOnly user
// ─────────────────────────────────────────────

const admin = require('../config/firebase')
const { verify: verifyImpersonate } = require('../utils/impersonate')

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        message: 'No token provided. Include Authorization: Bearer <token>',
      })
    }

    // H90 — Admin-issued impersonation token. Same downstream contract
    // (req.user.uid) but flagged readOnly so writes get refused below.
    if (authHeader.startsWith('Impersonate ')) {
      const token = authHeader.split('Impersonate ')[1]
      const { ok, payload, error } = verifyImpersonate(token)
      if (!ok) {
        return res.status(401).json({
          success: false,
          message: `Invalid impersonation token (${error}). Re-request from the portal.`,
        })
      }
      req.user = {
        uid:              payload.aud_uid,
        email:            null,
        name:             null,
        impersonatedBy:   payload.admin_id,
        readOnly:         true,
      }
      // H90 — Inline write guard: an impersonating session is read-only.
      // Allowing any non-GET/HEAD/OPTIONS through could corrupt the user's
      // data on the admin's behalf. Reject with a clear code so the client
      // can surface a "view-only" banner if the action sneaks through.
      const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
      if (!READ_METHODS.has(req.method)) {
        return res.status(403).json({
          success: false,
          code: 'read_only_session',
          message: 'This is a read-only support session. Writes are disabled.',
        })
      }
      return next()
    }

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'No token provided. Include Authorization: Bearer <token>',
      })
    }

    const idToken = authHeader.split('Bearer ')[1]
    const decoded = await admin.auth().verifyIdToken(idToken)

    req.user = {
      uid:   decoded.uid,
      email: decoded.email  || null,
      name:  decoded.name   || req.body.name || null,
    }

    next()
  } catch (err) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token. Please log in again.',
    })
  }
}

// H90 — Read-only guard for impersonation sessions. Mounted on every API
// route via the /api router so a debug session can't accidentally mutate
// the user's data. Allows GET/HEAD/OPTIONS only.
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const writeGuard = (req, res, next) => {
  if (req.user?.readOnly && !READ_METHODS.has(req.method)) {
    return res.status(403).json({
      success: false,
      code: 'read_only_session',
      message: 'This is a read-only support session. Writes are disabled.',
    })
  }
  next()
}

module.exports = { verifyToken, writeGuard }
