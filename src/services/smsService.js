// Tiny SMS sender. Provider-agnostic — wire your transactional provider via
// env (we'll pick Twilio when SMS_PROVIDER=twilio + creds are set), otherwise
// no-op cleanly so dev/CI doesn't crash. The route still returns the share
// link in the response so the UI can fall back to native share / copy.
//
// Add more providers by branching on SMS_PROVIDER inside `send()`.

const PROVIDER = (process.env.SMS_PROVIDER || '').toLowerCase()

const isReady = () => Boolean(PROVIDER)

async function sendTwilio (to, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  const from  = process.env.TWILIO_FROM
  if (!sid || !token || !from) {
    throw new Error('Twilio configured but missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM')
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`
  const auth = Buffer.from(`${sid}:${token}`).toString('base64')
  const params = new URLSearchParams({ To: to, From: from, Body: body })
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Twilio error ${res.status}: ${txt.slice(0, 200)}`)
  }
  return res.json()
}

async function send (to, body) {
  if (!to || !body) return { sent: false, reason: 'missing_args' }
  if (!isReady()) {
    // Dev/CI fallback — log it and pretend it sent. The caller still gets
    // the share link in the response so the user can hand it over manually.
    console.log(`[sms:noop] → ${to}: ${body}`)
    return { sent: false, reason: 'no_provider', provider: 'noop' }
  }
  try {
    if (PROVIDER === 'twilio') {
      await sendTwilio(to, body)
      return { sent: true, provider: 'twilio' }
    }
    return { sent: false, reason: `unknown_provider:${PROVIDER}` }
  } catch (err) {
    console.warn('[sms] send failed:', err.message)
    return { sent: false, reason: 'send_failed', error: err.message }
  }
}

module.exports = { send, isReady }
