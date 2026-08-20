// Per-route rate limits. Keep them generous enough for normal use but tight
// enough to stop a stuck client (or attacker) from running up costs.
//
//   authLimiter      — sync/onboarding writes
//   paymentLimiter   — Razorpay order creation + verify
//   geocodeLimiter   — Google reverse-geocode (each call costs us money)
//   adminWriteLimiter — admin portal writes
//
// Keyed by Firebase uid when available, IP otherwise — protects shared NATs
// from collateral 429s while still making per-account abuse expensive.

const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')

// Bucket by uid when authenticated (so a logged-in user is rate-limited as
// themselves regardless of which device/IP), and fall back to the library's
// built-in IPv6-aware IP key for unauthenticated traffic.
const keyByUidOrIp = (req, res) => req.user?.uid || ipKeyGenerator(req, res)

const make = (opts) => rateLimit({
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: keyByUidOrIp,
  message: { success: false, message: 'Too many requests, slow down.' },
  ...opts,
})

const authLimiter = make({
  windowMs: 60 * 1000,
  limit: 30,                  // 30 auth writes per minute per user/IP
})

const paymentLimiter = make({
  windowMs: 60 * 1000,
  limit: 10,                  // 10 order/verify calls per minute per user
})

const geocodeLimiter = make({
  windowMs: 60 * 1000,
  limit: 20,                  // protects Google API budget
})

const adminWriteLimiter = make({
  windowMs: 60 * 1000,
  limit: 60,
})

module.exports = { authLimiter, paymentLimiter, geocodeLimiter, adminWriteLimiter }
