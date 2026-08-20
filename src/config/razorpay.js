// Razorpay SDK singleton.
//
// The key secret is used server-side only:
//   1. `instance.orders.create(...)` to open an order.
//   2. HMAC-SHA256 signature verification on the success callback.
// It is never returned in any API response.

const Razorpay = require('razorpay')

const KEY_ID     = process.env.RAZORPAY_KEY_ID
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET

if (!KEY_ID || !KEY_SECRET) {
  // Soft warning — the server still boots, but any payment-related route
  // will 503 until the env vars are configured. Better than crashing the
  // whole process for a feature that's independent of the rest of the API.
  // eslint-disable-next-line no-console
  console.warn('⚠️  Razorpay keys not set — payment routes will return 503.')
}

const instance = (KEY_ID && KEY_SECRET)
  ? new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET })
  : null

module.exports = {
  instance,
  keyId:     KEY_ID     || null,
  keySecret: KEY_SECRET || null,
  isReady:   () => Boolean(instance),
}
