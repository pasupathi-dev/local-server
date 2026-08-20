// H90 — HMAC-signed impersonation tokens. Used by admins to view the
// customer/partner app as a specific user without that user's password.
//
// Token shape: base64url(JSON({ aud_uid, admin_id, exp, readonly: true }))
//              + '.' + HMAC-SHA256(secret, base64).
//
// Format (Authorization header):
//   Authorization: Impersonate <token>
//
// The verifyToken middleware recognises the prefix; in that mode it skips
// Firebase verification and instead validates the HMAC + expiry. It also
// stamps `req.user.readOnly = true` so the writeGuard middleware can
// reject any POST/PATCH/PUT/DELETE.

const crypto = require('crypto')

const TOKEN_VERSION = 1
// Token lifetime — long enough for one debug session, short enough that a
// leaked token is mostly worthless. Override via IMPERSONATE_TTL_MIN.
const DEFAULT_TTL_MIN = Number(process.env.IMPERSONATE_TTL_MIN) || 15
const DEFAULT_TTL_MS  = DEFAULT_TTL_MIN * 60 * 1000

function secret () {
  // Fall back to a deterministic-but-warned value in dev so admins don't
  // have to set up env vars to try the feature. Production MUST set
  // IMPERSONATE_SECRET (a 32+ char random string).
  if (process.env.IMPERSONATE_SECRET) return process.env.IMPERSONATE_SECRET
  if (process.env.NODE_ENV !== 'development') {
    console.warn('⚠️ IMPERSONATE_SECRET not set in non-dev env — using dev fallback')
  }
  return 'dev-impersonate-secret-do-not-use-in-prod'
}

const toBase64url = (buf) => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromBase64url = (s) => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

function sign (payload) {
  const json = JSON.stringify(payload)
  const body = toBase64url(Buffer.from(json, 'utf8'))
  const mac = crypto.createHmac('sha256', secret()).update(body).digest()
  return `${body}.${toBase64url(mac)}`
}

// Returns { ok, payload, error }.
function verify (token) {
  if (typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, error: 'malformed' }
  }
  const [body, mac] = token.split('.', 2)
  const expectedMac = crypto.createHmac('sha256', secret()).update(body).digest()
  const givenMac = fromBase64url(mac)
  if (expectedMac.length !== givenMac.length
   || !crypto.timingSafeEqual(expectedMac, givenMac)) {
    return { ok: false, error: 'bad_signature' }
  }
  let payload
  try {
    payload = JSON.parse(fromBase64url(body).toString('utf8'))
  } catch { return { ok: false, error: 'bad_payload' } }
  if (payload.v !== TOKEN_VERSION)   return { ok: false, error: 'bad_version' }
  if (!payload.aud_uid)              return { ok: false, error: 'missing_aud' }
  if (!payload.admin_id)             return { ok: false, error: 'missing_admin' }
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) {
    return { ok: false, error: 'expired' }
  }
  return { ok: true, payload }
}

function mint ({ aud_uid, admin_id, ttlMs = DEFAULT_TTL_MS }) {
  if (!aud_uid || !admin_id) throw new Error('mint: aud_uid and admin_id required')
  return sign({
    v:         TOKEN_VERSION,
    aud_uid,
    admin_id,
    readonly:  true,
    exp:       Date.now() + ttlMs,
  })
}

module.exports = { mint, verify, DEFAULT_TTL_MS }
