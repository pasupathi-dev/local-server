// FCM push fan-out. One sender used by every controller that fires a
// notification.
//
// Behaviour:
//   - sendToUser(uid, payload)    — pulls all device tokens for the user, sends
//                                   in a single multicast call.
//   - sendToUsers(uids, payload)  — same, batched across users.
//   - On invalid tokens (UNREGISTERED / INVALID_ARGUMENT) we prune the row from
//     `fcm_tokens` so future sends skip it.
//   - All calls are best-effort — we NEVER throw out of the controller. If
//     Firebase is misconfigured or the user has no devices, we just log and
//     return cleanly.
//
// Payload shape:
//   {
//     title, body,
//     data?: { route, jobId, requestId, ... }   // strings only — FCM requires it
//     icon?, badge?
//   }

const admin    = require('../config/firebase')
const FcmToken = require('../models/FcmToken')
const Settings = require('../models/Settings')
const { db }   = require('../config/db')
const { categoryForType } = require('../utils/notificationCategory')

// FCM allows up to 500 tokens per multicast. We chunk just in case.
// Override via FCM_BATCH_SIZE only if Firebase docs change the limit.
const CHUNK = Number(process.env.FCM_BATCH_SIZE) || 500

const isFirebaseReady = () => admin.apps?.length > 0

// FCM `data` payload values must all be strings. Coerce nested values so a
// caller passing { jobId: 42 } doesn't blow up the send.
const normaliseData = (data = {}) => {
  const out = {}
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) continue
    out[k] = typeof v === 'string' ? v : String(v)
  }
  return out
}

const buildMessage = (token, { title, body, data, icon }) => ({
  token,
  notification: { title, body },
  data: normaliseData(data),
  webpush: {
    notification: {
      icon: icon || '/favicon.ico',
      // Click handler: when the user taps the notification, focus the tab and
      // navigate to the route in `data.route` if present. The service worker
      // reads this `fcmOptions.link`.
      ...(data?.route ? { } : {}),
    },
    fcmOptions: data?.route ? { link: data.route } : undefined,
  },
})

// Best-effort row insert — never throws into the caller. Admins use this
// table to debug "why didn't user X get my push", so we log even the
// no-firebase / no-tokens cases.
async function logPush ({ user_id, payload, sent, failed, errorCodes }) {
  try {
    const codes = errorCodes && errorCodes.length ? [...new Set(errorCodes)] : null
    await db('push_log').insert({
      user_id: user_id || null,
      type:    payload?.data?.type || null,
      title:   (payload?.title || '').slice(0, 255) || null,
      sent:    sent || 0,
      failed:  failed || 0,
      error_codes_json: codes ? JSON.stringify(codes) : null,
    })
  } catch (err) {
    console.warn('[push] log write failed:', err.message)
  }
}

async function sendToTokens (tokens, payload, meta = {}) {
  const { user_id = null } = meta
  if (!isFirebaseReady()) {
    console.warn('[push] firebase-admin not initialised — skipping send')
    await logPush({ user_id, payload, sent: 0, failed: 0, errorCodes: ['firebase-not-initialised'] })
    return { sent: 0, failed: 0 }
  }
  const unique = [...new Set((tokens || []).filter(Boolean))]
  if (!unique.length) {
    await logPush({ user_id, payload, sent: 0, failed: 0, errorCodes: ['no-tokens'] })
    return { sent: 0, failed: 0 }
  }

  let sent = 0, failed = 0
  const toPrune = []
  const errorCodes = []

  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK)
    const messages = slice.map((t) => buildMessage(t, payload))
    let resp
    try {
      // sendEach is the modern v12+ API; falls back to sendAll on older versions.
      resp = await (admin.messaging().sendEach
        ? admin.messaging().sendEach(messages)
        : admin.messaging().sendAll(messages))
    } catch (err) {
      console.warn('[push] batch send failed:', err.message)
      failed += slice.length
      errorCodes.push(err.code || 'batch-send-error')
      continue
    }
    resp.responses.forEach((r, idx) => {
      if (r.success) { sent += 1; return }
      failed += 1
      const code = r.error?.code || 'unknown-error'
      errorCodes.push(code)
      if (code.includes('registration-token-not-registered')
        || code.includes('invalid-argument')
        || code.includes('invalid-registration-token')) {
        toPrune.push(slice[idx])
      }
    })
  }

  if (toPrune.length) {
    try { await FcmToken.removeMany(toPrune) }
    catch (e) { console.warn('[push] token prune failed:', e.message) }
  }

  await logPush({ user_id, payload, sent, failed, errorCodes })
  return { sent, failed }
}

// M56 — "Urgent" payload data flags that override quiet hours so an
// active-job push (partner arrived, payment received, job cancelled) still
// fires after-hours. The caller sets `data.urgent: 'true'` OR passes a type
// that's always urgent (any partner-side request handling event).
const URGENT_TYPES = new Set([
  // Live job state changes — always urgent.
  'job_completed', 'job_cancelled',
  // Partner accepting / declining you — also urgent if it's the user's own active flow.
  'request_accepted',
  // Payment events — urgent because money is moving.
  'payment_received', 'price_updated',
  // Scheduled job at-the-door alerts.
  'schedule_accepted', 'schedule_cancelled',
  // Safety / dispute — always urgent.
  'dispute_opened', 'safety_sos',
])

// M56 — Returns true if the current wall clock is inside the 22:00–07:00
// quiet window. We use IST (Asia/Kolkata) as the canonical timezone since
// this is a Bharat-only product; if we ever go cross-region this needs to
// move to a per-user timezone column.
function isWithinQuietHours (now = new Date()) {
  try {
    // Hour of day, Asia/Kolkata. Intl handles DST + offset; we just need the hour.
    const fmt = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
    const hour = Number(fmt.format(now)) // 0–23
    if (Number.isNaN(hour)) return false
    return hour >= 22 || hour < 7
  } catch {
    return false
  }
}

// H53/M56 — Per-user preference gate. Runs BEFORE we fetch tokens so we
// also save the FCM round-trip when the user has muted this category.
// Returns { skip, reason } when the push must be dropped, else { skip:false }.
async function shouldSkipForUser (user_id, payload) {
  const type = payload?.data?.type
  if (!type || !user_id) return { skip: false }
  let s = null
  try { s = await Settings.get(user_id) } catch { return { skip: false } }
  if (!s) return { skip: false }
  // Master push toggle off → drop everything.
  if (s.push_on === false) return { skip: true, reason: 'push-disabled' }
  const category = categoryForType(type)
  // H53 — Mute Promos.
  if (category === 'promos' && s.mute_promos) {
    return { skip: true, reason: 'mute-promos' }
  }
  // M56 — Quiet hours. Drop promos always, drop non-urgent jobs/payments,
  // let urgent ones through (active job + safety + money flow).
  if (s.quiet_hours_on && isWithinQuietHours()) {
    const explicitlyUrgent = payload?.data?.urgent === 'true' || payload?.data?.urgent === true
    if (category === 'promos')               return { skip: true, reason: 'quiet-hours-promo' }
    if (!URGENT_TYPES.has(type) && !explicitlyUrgent) {
      return { skip: true, reason: 'quiet-hours' }
    }
  }
  return { skip: false }
}

async function sendToUser (user_id, payload) {
  if (!user_id) return { sent: 0, failed: 0 }
  const gate = await shouldSkipForUser(user_id, payload)
  if (gate.skip) {
    await logPush({ user_id, payload, sent: 0, failed: 0, errorCodes: [gate.reason] })
    return { sent: 0, failed: 0, skipped: gate.reason }
  }
  const tokens = await FcmToken.forUser(user_id)
  return sendToTokens(tokens, payload, { user_id })
}

// Fan-out per user so each gets its own push_log row — admins debugging
// a broadcast can pinpoint which user didn't receive it. Acceptable cost
// since broadcasts are admin-triggered, not on the hot path.
async function sendToUsers (user_ids = [], payload) {
  if (!user_ids?.length) return { sent: 0, failed: 0 }
  let sent = 0, failed = 0
  for (const uid of user_ids) {
    const r = await sendToUser(uid, payload)
    sent   += r.sent || 0
    failed += r.failed || 0
  }
  return { sent, failed }
}

module.exports = { sendToUser, sendToUsers, sendToTokens, isFirebaseReady, shouldSkipForUser, isWithinQuietHours }
