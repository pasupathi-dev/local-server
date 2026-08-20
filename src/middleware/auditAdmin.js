// Universal audit log for admin writes. Wraps res.json so every successful
// write produces an `admin_audit_log` row with method + path + body. Reads
// (GET) are not audited by default; opt-in by setting req.auditRead = true
// inside a controller for sensitive read paths.
//
// Drop into adminRoutes.js after requireAdmin so req.adminUser is populated.

const { db } = require('../config/db')

const SENSITIVE_KEYS = ['account_full', 'ifsc', 'razorpay_signature', 'token', 'password']

const redact = (obj) => {
  if (!obj || typeof obj !== 'object') return obj
  const out = Array.isArray(obj) ? [] : {}
  for (const k of Object.keys(obj)) {
    if (SENSITIVE_KEYS.includes(k)) out[k] = '***'
    else if (obj[k] && typeof obj[k] === 'object') out[k] = redact(obj[k])
    else out[k] = obj[k]
  }
  return out
}

const inferTarget = (req) => {
  // /api/admin/users/abc123/role  →  target_type=user, target_id=abc123
  const m = req.path.match(/^\/?([a-z_-]+)(?:\/([^/]+))?(?:\/([a-z_-]+))?/i)
  if (!m) return { type: null, id: null }
  return { type: m[1] || null, id: m[2] || null }
}

const auditAdmin = (req, res, next) => {
  // Only audit mutating verbs; reads are usually high-volume.
  if (req.method === 'GET' && !req.auditRead) return next()

  const start = Date.now()
  const orig = res.json.bind(res)
  res.json = (payload) => {
    try {
      // Treat 2xx responses as the success path; skip 4xx/5xx so we don't
      // log every bad-request as an audit event.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const { type, id } = inferTarget(req)
        const action = `${req.method} ${req.baseUrl || ''}${req.path}`
        db('admin_audit_log').insert({
          admin_id:    req.adminUser?.user_id || null,
          admin_email: req.adminUser?.email   || null,
          action,
          target_type: type,
          target_id:   id ? String(id) : null,
          before_data: null,
          after_data:  JSON.stringify({
            body: redact(req.body),
            query: redact(req.query),
            ms: Date.now() - start,
          }),
          ip: req.ip || null,
          created_at: db.fn.now(),
        }).catch(() => { /* never block the response */ })
      }
    } catch { /* never throw from audit */ }
    return orig(payload)
  }
  next()
}

module.exports = { auditAdmin }
