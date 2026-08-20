// Socket.IO singleton + auth + room conventions.
//
// Rooms:
//   user:<uid>        — targets a single user (customer or partner) by uid
//   partners:<cat>    — all online partners subscribed to a category
//   partners:online   — all online partners (broadcast online count, etc.)
//   job:<jobId>       — both parties of an active job (chat, state transitions)
//
// Client should emit `auth` immediately after connect with { token, role }.
// We verify the Firebase token, then auto-join user:<uid>. Partners also join
// partners:online once they toggle online (separate `partner:online` event).

const { Server } = require('socket.io')
const admin      = require('../config/firebase')
const { db }     = require('../config/db')

let ioInstance = null

// Socket.IO heartbeat tuning. Defaults match the library's own defaults but
// can be raised on flaky networks (mobile / VPN) without a code change.
const PING_INTERVAL_MS    = Number(process.env.SOCKET_PING_INTERVAL_MS) || 25000
const PING_TIMEOUT_MS     = Number(process.env.SOCKET_PING_TIMEOUT_MS)  || 60000
// How long after boot to run the stale-online sweep. Long enough for any
// partner whose client is reconnecting to re-join the online room first.
const STALE_SWEEP_DELAY_MS = Number(process.env.STALE_ONLINE_SWEEP_MS) || 60000
// Grace window before flipping is_online=false after a disconnect — covers
// quick route-change socket teardowns that reconnect within a second.
const DISCONNECT_GRACE_MS  = Number(process.env.SOCKET_DISCONNECT_GRACE_MS) || 4000

// Accept same dev origins as the HTTP server (localhost + RFC 1918 LAN)
const isDevOrigin = (origin) => {
  if (!origin) return true
  try {
    const u = new URL(origin)
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true
    if (/^10\./.test(u.hostname))                     return true
    if (/^192\.168\./.test(u.hostname))               return true
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return true
  } catch { /* ignore */ }
  return (process.env.CLIENT_URL || '').split(',').map((s) => s.trim()).includes(origin)
}

function initRealtime (httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: (origin, cb) => isDevOrigin(origin) ? cb(null, true) : cb(new Error(`CORS blocked: ${origin}`)),
      credentials: true,
    },
    pingInterval: PING_INTERVAL_MS,
    pingTimeout:  PING_TIMEOUT_MS,
  })

  // Boot-time stale-online sweep.
  // The legacy bug: partners who close their browser without toggling off
  // stay `is_online=true` in the DB forever. After the disconnect-handler
  // below is wired this stops happening on the live path — but existing
  // rows are still stale. We sweep them out 60 seconds after boot so any
  // partner whose client reconnects in that window is preserved (the
  // reconnect handler at line ~65 below re-joins them to the online room
  // when their DB row says they're online).
  setTimeout(async () => {
    try {
      const candidates = await db('partners').where({ is_online: true }).pluck('user_id')
      if (!candidates.length) return
      let flipped = 0
      for (const uid of candidates) {
        const sockets = await io.in(`user:${uid}`).fetchSockets()
        if (sockets.length === 0) {
          await db('partners').where({ user_id: uid })
            .update({ is_online: false, online_since: null })
          flipped += 1
        }
      }
      if (flipped) console.log(`🧹 Auto-offlined ${flipped} stale partner(s) without live sockets`)
    } catch (err) {
      console.warn('[realtime] stale-online sweep failed:', err.message)
    }
  }, STALE_SWEEP_DELAY_MS)

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token
      if (!token) return next(new Error('no_token'))
      const decoded = await admin.auth().verifyIdToken(token)
      socket.uid  = decoded.uid
      socket.role = socket.handshake.auth?.role || 'user'
      next()
    } catch (err) {
      next(new Error('invalid_token'))
    }
  })

  io.on('connection', (socket) => {
    socket.join(`user:${socket.uid}`)

    // Auto-join partner category rooms based on DB state. Without this, a
    // partner who refreshed the page (or just logged in fresh) won't be in
    // `partners:<category>` until they manually toggle online again — so
    // they'd miss `request:incoming` broadcasts AND `request:resolved`
    // events for requests they had already seen. The client-side toggle
    // still emits `partner:online` explicitly to handle live toggling,
    // but this handler covers the page-reload / reconnect path.
    if (socket.role === 'partner') {
      ;(async () => {
        try {
          const row = await db('partners').where({ user_id: socket.uid })
            .select('is_online', 'primary_work').first()
          if (!row?.is_online) return
          socket.join('partners:online')
          const works = new Set()
          if (row.primary_work) works.add(row.primary_work)
          const pwp = await db('partner_category_prices')
            .where({ partner_id: socket.uid }).pluck('work_name')
          for (const w of pwp) if (w) works.add(w)
          for (const w of works) socket.join(`partners:work:${w}`)
        } catch { /* non-fatal */ }
      })()
    }

    socket.on('join-job', (jobId) => {
      if (jobId) socket.join(`job:${jobId}`)
    })

    socket.on('leave-job', (jobId) => {
      if (jobId) socket.leave(`job:${jobId}`)
    })

    // Live partner-location stream during travelling/arrived. We verify the
    // socket's uid is a party on the job before letting it join — a leaked
    // jobId shouldn't expose another customer's location feed.
    socket.on('join-job-location', async (jobId, cb) => {
      try {
        if (!jobId) return typeof cb === 'function' && cb({ ok: false, error: 'no_job_id' })
        const job = await db('jobs').where({ id: jobId })
          .select('customer_id', 'partner_id').first()
        if (!job) return typeof cb === 'function' && cb({ ok: false, error: 'not_found' })
        if (socket.uid !== job.customer_id && socket.uid !== job.partner_id) {
          return typeof cb === 'function' && cb({ ok: false, error: 'forbidden' })
        }
        socket.join(`job:${jobId}:location`)
        if (typeof cb === 'function') cb({ ok: true })
      } catch {
        if (typeof cb === 'function') cb({ ok: false, error: 'server_error' })
      }
    })

    socket.on('leave-job-location', (jobId) => {
      if (jobId) socket.leave(`job:${jobId}:location`)
    })

    socket.on('partner:online', ({ online, works = [], categories = [] } = {}) => {
      if (socket.role !== 'partner') return
      // `works` is the taxonomy-v2 field; `categories` accepted as legacy alias.
      const list = (works.length ? works : categories) || []
      if (online) {
        socket.join('partners:online')
        list.forEach((w) => socket.join(`partners:work:${w}`))
      } else {
        socket.leave('partners:online')
        list.forEach((w) => socket.leave(`partners:work:${w}`))
      }
    })

    // Auto-offline on disconnect.
    // A partner who closes the browser, loses Wi-Fi, or kills the tab
    // without first toggling offline would otherwise stay `is_online=true`
    // in the DB forever — which is exactly what showed a "Partner 0"
    // card to customers even though nobody was actively connected.
    //
    // We wait a beat so a quick reconnect (e.g. nav between routes that
    // briefly tears down the socket) doesn't false-flag the partner as
    // offline. After the grace window, count how many sockets THIS uid
    // still has open — if zero, flip is_online = false in the DB and
    // broadcast updated category counts so every customer's home page
    // refreshes the "N online" tally without a reload.
    socket.on('disconnect', () => {
      if (socket.role !== 'partner') return
      const uid = socket.uid
      if (!uid) return
      setTimeout(async () => {
        try {
          // Count currently-connected sockets in this partner's user-room.
          // Socket.IO's adapter exposes room sockets via `fetchSockets`.
          const remaining = await io.in(`user:${uid}`).fetchSockets()
          if (remaining.length > 0) return    // they reconnected — leave is_online alone

          const partner = await db('partners')
            .where({ user_id: uid })
            .select('is_online', 'primary_category').first()
          if (!partner?.is_online) return     // already offline — nothing to do

          await db('partners').where({ user_id: uid })
            .update({ is_online: false, online_since: null })
          // Best-effort broadcast — the customer's home updates the
          // "N online" pill without a reload. We don't bother computing
          // exact per-category counts here; the next /api/partners GET
          // (or the existing `categories:counts` emit elsewhere) will.
          getIO().to('partners:online').emit('partner:peer-offline', { uid })
        } catch (err) {
          console.warn('[realtime] auto-offline failed for', uid, err.message)
        }
      }, DISCONNECT_GRACE_MS)   // grace window for short-lived reconnects
    })
  })

  ioInstance = io
  return io
}

function getIO () {
  if (!ioInstance) throw new Error('Socket.IO not initialised')
  return ioInstance
}

// Convenience helpers — controllers call these.
const emitToUser    = (uid, event, payload) => getIO().to(`user:${uid}`).emit(event, payload)
const emitToJob     = (jobId, event, payload) => getIO().to(`job:${jobId}`).emit(event, payload)
// Dedicated location-stream room. High-frequency events (partner lat/lng
// every ~15s) are scoped here so they don't piggy-back on the chat room.
const emitToJobLocation = (jobId, event, payload) => getIO().to(`job:${jobId}:location`).emit(event, payload)
// Broadcast to every online partner who serves a given WORK. Matching +
// request fan-out happen at the work level (taxonomy v2).
const emitToWork = (work, event, payload) => getIO().to(`partners:work:${work}`).emit(event, payload)
// Global — sent to every connected socket. Used for signals that every client
// should see, like the live per-category online count.
const emitGlobal    = (event, payload) => getIO().emit(event, payload)

// Server-authoritative: force every socket belonging to `uid` out of all
// `partners:*` rooms (online + work rooms). Called when a partner goes offline
// so broadcasts to a work room never reach them, even if the client's own
// `partner:online{online:false}` leave emit was missed or carried stale works.
const removePartnerFromRooms = async (uid) => {
  try {
    const sockets = await getIO().in(`user:${uid}`).fetchSockets()
    for (const s of sockets) {
      for (const room of s.rooms) {
        if (room.startsWith('partners:')) s.leave(room)
      }
    }
  } catch { /* non-fatal — best-effort room cleanup */ }
}

module.exports = {
  initRealtime, getIO,
  emitToUser, emitToJob, emitToJobLocation, emitToWork, emitGlobal,
  removePartnerFromRooms,
}
