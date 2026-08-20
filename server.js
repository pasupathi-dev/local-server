require('dotenv').config()

const http               = require('http')
const os                 = require('os')
const app                = require('./src/app')
const { testConnection } = require('./src/config/db')
const { runMigrations }  = require('./src/models/schema')
const { initRealtime }   = require('./src/realtime/io')
const Wallet             = require('./src/models/Wallet')
const { expireOverdueAndNotify } = require('./src/controllers/requestController')
const { fireScheduleAlerts }    = require('./src/controllers/scheduledJobController')
const { expireStaleJobs }       = require('./src/controllers/jobController')
const { finalizePendingDeletions } = require('./src/controllers/authController')
const { maybeRun: maybeRunOpsDigest } = require('./src/workers/opsDigest')

const PORT = process.env.PORT || 5000
const HOST = process.env.HOST || '0.0.0.0'   // bind to all interfaces → LAN access

// Helper: enumerate all IPv4 addresses so we can print them on boot
function getLocalIPv4s () {
  const out = []
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const info of nets[name] || []) {
      if (info.family === 'IPv4' && !info.internal) out.push({ iface: name, ip: info.address })
    }
  }
  return out
}

async function start () {
  await testConnection()
  await runMigrations()

  const server = http.createServer(app)
  initRealtime(server)

  // Bug #33: recover withdrawals whose complete_at passed while server was down.
  Wallet.recoverStuckWithdrawals().then((n) => {
    if (n) console.log(`♻️  Recovered ${n} stuck withdrawal(s) to completed`)
  }).catch(() => {})

  // Bug #36/#8/#10: expire any overdue requests and emit socket events so
  // waiting customers and partner toasts update immediately on boot.
  // Then repeat every 60 seconds for ongoing expiry.
  expireOverdueAndNotify().then((n) => {
    if (n) console.log(`⏱  Expired ${n} overdue request(s) on boot`)
  }).catch(() => {})
  setInterval(() => expireOverdueAndNotify().catch(() => {}), 60_000)

  // Scheduling alert cron: fires T-24h, T-1h, T-15m, T=0, and overdue alerts.
  fireScheduleAlerts().catch(() => {})
  setInterval(() => fireScheduleAlerts().catch(() => {}), 60_000)

  // Stale-job cron: auto-cancels non-terminal jobs untouched > 48h with
  // cancel_reason='auto-abandoned'. Run on boot then every 10 minutes.
  expireStaleJobs().then((n) => {
    if (n) console.log(`🧹 Auto-cancelled ${n} stale job(s) on boot`)
  }).catch(() => {})
  setInterval(() => expireStaleJobs().catch(() => {}), 10 * 60_000)

  // L79 — Account deletion worker. Finalises any deletion_requested_at
  // older than the 7-day grace window. Runs on boot then once per hour
  // (cheap query, idempotent — picks up only fresh-to-cutoff rows).
  finalizePendingDeletions().then((n) => {
    if (n) console.log(`🗑️  Finalised ${n} account deletion(s) on boot`)
  }).catch(() => {})
  setInterval(() => finalizePendingDeletions().catch(() => {}), 60 * 60_000)

  // M95 — Daily ops digest. Worker self-gates on (a) IST clock hour
  // 07:00–09:00 and (b) 22h since the last send, so this hourly tick is
  // safe to run on every boot.
  maybeRunOpsDigest().catch(() => {})
  setInterval(() => maybeRunOpsDigest().catch(() => {}), 60 * 60_000)

  server.listen(PORT, HOST, () => {
    console.log(`\n🚀 Server running on ${HOST}:${PORT}`)
    console.log(`📦 Environment   → ${process.env.NODE_ENV || 'development'}`)
    console.log(`   Local          → http://localhost:${PORT}`)
    for (const { iface, ip } of getLocalIPv4s()) {
      console.log(`   LAN (${iface})  → http://${ip}:${PORT}`)
    }
    console.log(`🔌 Socket.IO ready on same host`)
    console.log(`🛡️  Admin Portal  → http://localhost:${PORT}/portal\n`)
  })
}

start().catch((err) => {
  console.error('❌ Failed to start server:', err)
  process.exit(1)
})
