// src/middleware/errorHandler.js
// ─────────────────────────────────────────────
// Catches any error thrown by controllers/services.
// Prevents raw stack traces leaking to the client.
// ─────────────────────────────────────────────

const errorHandler = (err, req, res, next) => {
  const isDev = process.env.NODE_ENV === 'development'

  // Log full error in development
  if (isDev) {
    console.error('💥 Error:', err.stack)
  } else {
    console.error('💥 Error:', err.message)
  }

  const statusCode = err.statusCode || err.status || 500

  res.status(statusCode).json({
    success: false,
    message: err.message || 'Internal server error',
    // Only show stack trace in development
    ...(isDev && { stack: err.stack }),
  })
}

module.exports = errorHandler
