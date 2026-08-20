const express      = require('express')
const cors         = require('cors')
const helmet       = require('helmet')
const morgan       = require('morgan')
const path         = require('path')
const errorHandler = require('./middleware/errorHandler')
const routes       = require('./routes')

const app = express()

app.use(helmet({
  // Firebase popup auth uses window.closed across origins; 'same-origin' blocks it.
  // 'same-origin-allow-popups' keeps security while allowing OAuth popups to work.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  // Helmet's default CSP is `script-src 'self'`, which blocks the Google
  // Identity script (apis.google.com/js/api.js) that Firebase Auth loads for
  // the "Continue with Google" popup — surfacing as auth/internal-error in the
  // admin portal (served from /portal by this server). Allow the specific
  // Firebase/Google origins the auth flow needs; everything else stays locked.
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      baseUri:     ["'self'"],
      objectSrc:   ["'none'"],
      // gapi loader + Firebase auth helper scripts.
      scriptSrc:   ["'self'", 'https://apis.google.com', 'https://www.gstatic.com', 'https://*.firebaseapp.com'],
      scriptSrcAttr: ["'none'"],
      styleSrc:    ["'self'", "'unsafe-inline'", 'https:'],
      imgSrc:      ["'self'", 'data:', 'https:'],
      fontSrc:     ["'self'", 'https:', 'data:'],
      // The Firebase auth handler runs in an iframe hosted at the project's
      // authDomain (*.firebaseapp.com) and uses Google's accounts/apis origins.
      frameSrc:    ["'self'", 'https://apis.google.com', 'https://*.firebaseapp.com', 'https://accounts.google.com'],
      // Token + identity endpoints, Realtime DB sockets, and same-origin API/WS.
      connectSrc: [
        "'self'",
        'https://*.googleapis.com', 'https://apis.google.com',
        'https://*.firebaseapp.com', 'https://*.firebaseio.com', 'wss://*.firebaseio.com',
        'ws:', 'wss:',
      ],
      // Keep upgrade-insecure-requests off in dev so http://localhost works.
      upgradeInsecureRequests: null,
    },
  },
}))

// ── CORS ──────────────────────────────────────
// In development, accept requests from localhost AND any LAN IP on the same
// port as the frontend (default :5173). Extra origins can be whitelisted
// via CLIENT_URL (comma-separated) for staging/prod.
const extra = (process.env.CLIENT_URL || '')
  .split(',').map((s) => s.trim()).filter(Boolean)

const isDevOrigin = (origin) => {
  if (!origin) return true                           // same-origin / curl
  try {
    const u = new URL(origin)
    // localhost / 127.0.0.1
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true
    // RFC 1918 private LAN ranges (for phones on same Wi-Fi)
    if (/^10\./.test(u.hostname))                    return true
    if (/^192\.168\./.test(u.hostname))              return true
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return true
  } catch { /* ignore */ }
  return extra.includes(origin)
}

app.use(cors({
  origin: (origin, cb) => {
    if (isDevOrigin(origin)) return cb(null, true)
    return cb(new Error(`CORS blocked: ${origin}`))
  },
  credentials: true,
}))

if (process.env.NODE_ENV === 'development') app.use(morgan('dev'))

// Image uploads arrive as base64 data URIs in a JSON body, which can be a few
// MB. Give the upload paths a larger limit; everything else stays at 1 MB.
// Mounted BEFORE the global parser — body-parser sets req._body once parsed,
// so the global 1 MB parser skips these paths.
const bigJson = express.json({ limit: '15mb' })
app.use('/api/uploads', bigJson)
app.use('/api/admin/upload-image', bigJson)

app.use(express.json({ limit: '1mb' }))
app.use(express.urlencoded({ extended: true }))

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use('/api', routes)

// Image storage is Cloudinary now (see config/cloudinary.js + uploadController)
// — no local /uploads static route. Old disk-stored URLs (/uploads/...) from
// before this migration will 404; re-upload to refresh them.

// Admin portal — served from portal/dist (built separately)
const portalDist = path.join(__dirname, '../../portal/dist')
app.use('/portal', express.static(portalDist))
app.get('/portal/*', (req, res) => res.sendFile(path.join(portalDist, 'index.html')))

app.use((req, res) => res.status(404).json({ success: false, message: 'Route not found' }))
app.use(errorHandler)

module.exports = app
