// src/utils/response.js
// ─────────────────────────────────────────────
// Standard response shape used everywhere.
// All API responses look the same — easy to
// handle consistently on the frontend.
//
// Success: { success: true,  message, ...data }
// Error:   { success: false, message, code }
// ─────────────────────────────────────────────

const success = (message, data = {}) => ({
  success: true,
  message,
  ...data,
})

const error = (message, code = 500) => ({
  success: false,
  message,
  code,
})

module.exports = { success, error }
