// M95 — Daily ops digest. Runs once a day, computes a summary of the last
// 24 hours, and either emails ops (when SMTP is configured) or writes a
// markdown copy to stdout so a Cloud Run job / docker logs can still pick
// it up.
//
// Schedule: server.js triggers `maybeRun()` every hour. The worker checks
// the `app_config` row `last_ops_digest_at`; if it's been more than ~23h,
// it computes + sends + updates that row. This keeps the cron simple
// (no separate scheduler) and idempotent across process restarts.
//
// Email: uses nodemailer when ENV has SMTP_HOST + SMTP_USER + SMTP_PASS +
// OPS_EMAIL. Otherwise we log the markdown and return — the digest is
// still observable in the server logs and the GET endpoint below.

const { db } = require('../config/db')

const CONFIG_KEY = 'last_ops_digest_at'
// Override via env if you want the digest at a different local hour
// (e.g. OPS_DIGEST_HOUR_IST=9 for 9 AM IST).
const TARGET_HOUR_IST = Number(process.env.OPS_DIGEST_HOUR_IST) || 7
const MIN_SPACING_MS  = 22 * 60 * 60 * 1000   // never run twice in <22h

// ─── Computation ───────────────────────────────────────────────────────────
async function compute () {
  const since = `DATE_SUB(NOW(), INTERVAL 24 HOUR)`
  const [
    jobsDone, disputesNew, refunds, partnersUnverified, withdrawalsFailed,
    cancellations, payments,
  ] = await Promise.all([
    db('jobs').where('state', 'paid').whereRaw(`paid_at >= ${since}`)
      .count({ n: '*' }).first(),
    db('disputes').whereRaw(`created_at >= ${since}`)
      .count({ n: '*' }).first(),
    db('disputes').where('resolution', 'refund').whereRaw(`resolved_at >= ${since}`)
      .sum({ total: 'refund_amount' }).count({ n: '*' }).first(),
    // Collation cast — see note in adminController.listPartners.
    db('users as u')
      .join('partners as p', function () {
        this.on(db.raw('p.user_id COLLATE utf8mb4_unicode_ci = u.user_id COLLATE utf8mb4_unicode_ci'))
      })
      .where('p.is_verified', false).whereNull('u.deleted_at')
      .where('u.status', 'active')
      .count({ n: '*' }).first(),
    db('withdrawals').where('status', 'cancelled').whereRaw(`updated_at >= ${since}`)
      .count({ n: '*' }).first(),
    db('jobs').where('state', 'cancelled').whereRaw(`updated_at >= ${since}`)
      .count({ n: '*' }).first(),
    db('payments').where('status', 'completed').whereRaw(`paid_at >= ${since}`)
      .sum({ total: 'total' }).count({ n: '*' }).first(),
  ])

  return {
    window_hours: 24,
    generated_at: new Date().toISOString(),
    jobs_done:               Number(jobsDone?.n      || 0),
    job_cancellations:       Number(cancellations?.n || 0),
    payments_count:          Number(payments?.n      || 0),
    payments_total_rupees:   Number(payments?.total  || 0),
    disputes_new:            Number(disputesNew?.n   || 0),
    refunds_count:           Number(refunds?.n       || 0),
    refunds_total_rupees:    Number(refunds?.total   || 0),
    partners_awaiting_verification: Number(partnersUnverified?.n || 0),
    withdrawal_failures:     Number(withdrawalsFailed?.n || 0),
  }
}

function toMarkdown (d) {
  return [
    `# ServiceLink — Ops Digest`,
    ``,
    `_Last 24 hours · generated ${d.generated_at}_`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Jobs paid                       | ${d.jobs_done} |`,
    `| Payments (₹)                    | ₹${d.payments_total_rupees.toLocaleString('en-IN')} (${d.payments_count}) |`,
    `| Jobs cancelled                  | ${d.job_cancellations} |`,
    `| New disputes                    | ${d.disputes_new} |`,
    `| Refunds issued                  | ${d.refunds_count} (₹${d.refunds_total_rupees.toLocaleString('en-IN')}) |`,
    `| Partners awaiting verification  | ${d.partners_awaiting_verification} |`,
    `| Withdrawal failures             | ${d.withdrawal_failures} |`,
    ``,
  ].join('\n')
}

// ─── Email (optional) ──────────────────────────────────────────────────────
let nodemailerRef = null
async function getTransporter () {
  if (nodemailerRef === false) return null    // tried and failed in this process
  if (nodemailerRef) return nodemailerRef
  const need = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'OPS_EMAIL']
  if (need.some((k) => !process.env[k])) return null
  try {
    const nodemailer = require('nodemailer')
    nodemailerRef = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
    return nodemailerRef
  } catch (err) {
    console.warn('[opsDigest] nodemailer unavailable —', err.message)
    nodemailerRef = false
    return null
  }
}

async function emailIfPossible (digest, markdown) {
  const transport = await getTransporter()
  if (!transport) {
    console.log('[opsDigest] SMTP not configured — skipping email send.')
    return { sent: false, reason: 'smtp_not_configured' }
  }
  const subject = `ServiceLink ops · ${digest.jobs_done} jobs · ${digest.disputes_new} disputes (24h)`
  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to:   process.env.OPS_EMAIL,
      subject,
      text: markdown,
    })
    return { sent: true }
  } catch (err) {
    console.warn('[opsDigest] email send failed:', err.message)
    return { sent: false, reason: err.message }
  }
}

// ─── Single-flight orchestrator ────────────────────────────────────────────
async function lastRunAt () {
  try {
    const row = await db('app_config').where({ key: CONFIG_KEY }).first()
    if (!row) return null
    const value = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
    return value ? new Date(value) : null
  } catch { return null }
}

async function markRan () {
  const value = JSON.stringify(new Date().toISOString())
  await db('app_config').insert({
    key: CONFIG_KEY, value, label: 'Last ops digest run', type: 'string',
  }).onConflict('key').merge({ value })
}

// Run the digest now. Always idempotent — fine to call multiple times.
async function runNow () {
  const digest = await compute()
  const markdown = toMarkdown(digest)
  console.log('\n' + markdown + '\n')
  const sendResult = await emailIfPossible(digest, markdown)
  await markRan()
  return { digest, markdown, ...sendResult }
}

// Called from server.js every hour. Sends if it's been >22h AND the local
// hour is within the target window (or if we've never sent).
async function maybeRun () {
  const last = await lastRunAt()
  const now = Date.now()
  if (last && (now - last.getTime()) < MIN_SPACING_MS) return null
  // Compute the local IST hour without an extra library.
  const istHour = Number(new Intl.DateTimeFormat('en-IN', {
    hour: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  }).format(new Date()))
  // Allow a 2-hour window so we don't miss a tick if the server was down
  // exactly at 7 AM IST.
  if (Number.isNaN(istHour) || istHour < TARGET_HOUR_IST || istHour > TARGET_HOUR_IST + 2) return null
  return runNow()
}

module.exports = { compute, runNow, maybeRun, toMarkdown }
