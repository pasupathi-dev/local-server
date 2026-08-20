const Wallet = require('../models/Wallet')
const ActivityLog = require('../models/ActivityLog')
const { success } = require('../utils/response')
const { wdId, wdRef } = require('../utils/ids')
const { MIN_WITHDRAW, WD_PROCESSING_DELAY_MS } = require('../config/constants')
const { emitToUser } = require('../realtime/io')
const push = require('../services/pushService')
const { getConfigNumber } = require('../utils/appConfig')

module.exports = {
  // GET /api/wallet   (partner)
  summary: async (req, res, next) => {
    try {
      const uid = req.user.uid
      await Wallet.clearEligible(uid)
      const [summary, tx, wd, bank] = await Promise.all([
        Wallet.summarize(uid),
        Wallet.listTx(uid, 50),
        Wallet.listWithdrawals(uid, 50),
        Wallet.getBank(uid),
      ])
      res.json(success('Wallet', { summary, transactions: tx, withdrawals: wd, bank }))
    } catch (err) { next(err) }
  },

  // GET /api/wallet/payout-eligibility   (partner)
  // Drives the "Withdrawal speed" panel on the partner Wallet page. Same
  // trust gate as Wallet.isTrustedForAutoPayout, but returns the full
  // breakdown so the UI can show what's blocking.
  payoutEligibility: async (req, res, next) => {
    try {
      const data = await Wallet.payoutEligibility(req.user.uid)
      res.json(success('Eligibility', data))
    } catch (err) { next(err) }
  },

  // GET /api/wallet/transactions
  transactions: async (req, res, next) => {
    try {
      await Wallet.clearEligible(req.user.uid)
      const tx = await Wallet.listTx(req.user.uid, Number(req.query.limit) || 500)
      res.json(success('Transactions', { transactions: tx }))
    } catch (err) { next(err) }
  },

  // GET /api/wallet/earnings
  //   ?range=7d|1m|1y|all|custom   (default '7d')
  //   &from=ISO&to=ISO             (only honoured when range=custom)
  //
  // Returns a bucketed series (daily or monthly depending on the span) plus
  // summary totals and a top-services breakdown. The front-end never does any
  // local filtering — each filter change is a fresh request.
  earnings: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const range = String(req.query.range || '7d').toLowerCase()
      const now = new Date()
      const toEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)

      const atStartOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
      const minusDays    = (d, n) => { const x = new Date(d); x.setDate(x.getDate() - n); return atStartOfDay(x) }
      const minusMonths  = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() - n); return atStartOfDay(x) }

      let from, to = toEnd
      let granularity = 'day'

      if (range === '7d') {
        from = minusDays(now, 6)           // today + 6 previous = 7 buckets
        granularity = 'day'
      } else if (range === '1m') {
        from = minusDays(now, 29)          // 30 daily buckets
        granularity = 'day'
      } else if (range === '1y') {
        from = minusMonths(now, 11)        // 12 monthly buckets ending this month
        from = new Date(from.getFullYear(), from.getMonth(), 1)
        granularity = 'month'
      } else if (range === 'all') {
        const first = await Wallet.firstCreditAt(uid)
        from = first ? atStartOfDay(new Date(first)) : minusMonths(now, 11)
        // Bucket by month unless the total span is short (<62 days) in which
        // case daily buckets read more naturally.
        const spanDays = Math.max(1, Math.round((to - from) / 86400000))
        granularity = spanDays <= 62 ? 'day' : 'month'
      } else if (range === 'custom') {
        const f = req.query.from ? new Date(req.query.from) : null
        const t = req.query.to   ? new Date(req.query.to)   : null
        if (!f || Number.isNaN(f.getTime()) || !t || Number.isNaN(t.getTime())) {
          return res.status(400).json({ success: false, message: 'Provide from & to (ISO date) for custom range' })
        }
        if (f > t) return res.status(400).json({ success: false, message: '`from` must be before `to`' })
        from = atStartOfDay(f)
        // Make `to` inclusive of the whole day
        to = new Date(t.getFullYear(), t.getMonth(), t.getDate(), 23, 59, 59, 999)
        const spanDays = Math.max(1, Math.round((to - from) / 86400000))
        granularity = spanDays <= 62 ? 'day' : 'month'
      } else {
        return res.status(400).json({ success: false, message: 'Invalid range' })
      }

      const [series, totals, top] = await Promise.all([
        Wallet.earningsSeries(uid, { from, to, granularity }),
        Wallet.earningsTotals(uid, { from, to }),
        Wallet.earningsTopServices(uid, { from, to, limit: 5 }),
      ])

      // Fill missing buckets so the chart has one column per period and an
      // empty day doesn't just collapse out of the x-axis.
      const filled = fillBuckets(from, to, granularity, series)

      res.json(success('Earnings', {
        range,
        from: from.toISOString(),
        to:   to.toISOString(),
        granularity,
        total_earned: totals.total,
        jobs_count:   totals.jobs,
        avg_per_job:  totals.jobs ? Math.round(totals.total / totals.jobs) : 0,
        series: filled,
        top_services: top,
      }))
    } catch (err) { next(err) }
  },

  // GET /api/wallet/withdrawals
  withdrawals: async (req, res, next) => {
    try {
      const wd = await Wallet.listWithdrawals(req.user.uid, Number(req.query.limit) || 500)
      res.json(success('Withdrawals', { withdrawals: wd }))
    } catch (err) { next(err) }
  },

  // POST /api/wallet/withdraw  { amount }
  // Lifecycle:
  //   processing → admin approves in the portal     → completed
  //                admin cancels                    → cancelled (refund)
  //   processing → trusted partner auto-payout      → completed (no admin)
  //
  // Trust gate: jobs_completed > 10, no partner-driven cancellations in the
  // last 7 days, and no disputes in the last 30 days. The previous "in-process
  // setTimeout" auto-complete was removed — it pretended money moved without
  // a real bank transfer happening. Now real funds only move when either an
  // admin or this trust gate confirms the partner's track record.
  withdraw: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const amount = Number(req.body?.amount)
      // Admin-tunable from portal (app_config). Fallback to the constants.js
      // value if the DB row is missing (e.g. fresh test environment).
      const minWithdraw = await getConfigNumber('min_withdrawal_amount', MIN_WITHDRAW)
      if (!Number.isFinite(amount) || amount < minWithdraw) {
        return res.status(400).json({ success: false, message: `Minimum withdrawal is ₹${minWithdraw}` })
      }
      const bank = await Wallet.getBank(uid)
      if (!bank) return res.status(400).json({ success: false, message: 'Link a bank account first' })

      await Wallet.clearEligible(uid)
      const id = wdId()
      let wd
      try {
        wd = await Wallet.withdrawAtomic({
          id, partner_id: uid, amount,
          ref: wdRef(), bank_short: `${bank.bank_name} ••${bank.last4}`,
          complete_at: null,   // admin- or trust-gated; no auto-complete window
        })
      } catch (e) {
        if (e.code === 'INSUFFICIENT') {
          return res.status(400).json({ success: false, message: 'Insufficient balance' })
        }
        throw e
      }

      const trusted = await Wallet.isTrustedForAutoPayout(uid)

      if (trusted) {
        // Auto-payout — flip to completed straight away, log it, fire the
        // same realtime + push notifications the admin approval flow uses
        // so the partner UI doesn't need to special-case the auto path.
        await Wallet.completeWithdrawal(id)
        const completed = await Wallet.findWithdrawal(id)

        await ActivityLog.add({
          partner_id: uid, type: 'withdrawal_initiated',
          title: `Withdrawal ₹${amount} initiated`,
          sub:   `to ${wd.bank_short} · auto-approved (trusted partner)`,
          icon:  '🏦', color: '#2563eb', amount,
        })
        await ActivityLog.add({
          partner_id: uid, type: 'withdrawal_completed',
          title: `Withdrawal ₹${amount} completed`,
          sub:   `to ${wd.bank_short}`,
          icon:  '✅', color: '#059669', amount,
        })

        emitToUser(uid, 'wallet:withdrawal-completed', { id, amount })
        push.sendToUser(uid, {
          title: `Withdrawal completed · ₹${amount}`,
          body:  `Money has been sent to ${wd.bank_short}.`,
          data:  { type: 'withdrawal:completed', route: '/partner/wallet' },
        }).catch(() => {})

        return res.status(201).json(success('Withdrawal completed', {
          withdrawal: completed || { ...wd, status: 'completed' },
          auto: true,
        }))
      }

      // Standard path — sits in `processing` until an admin approves via the
      // portal (or cancels with a wallet refund).
      await ActivityLog.add({
        partner_id: uid, type: 'withdrawal_initiated',
        title: `Withdrawal ₹${amount} requested`,
        sub:   `to ${wd.bank_short} · awaiting admin approval`,
        icon:  '🏦', color: '#2563eb', amount,
      })
      emitToUser(uid, 'wallet:withdrawal-pending', { id, amount, bank_short: wd.bank_short })

      res.status(201).json(success('Withdrawal requested — pending admin approval', {
        withdrawal: wd,
        auto: false,
      }))
    } catch (err) { next(err) }
  },

  // POST /api/wallet/withdraw/:id/cancel
  cancelWithdrawal: async (req, res, next) => {
    try {
      await Wallet.cancelWithdrawal(req.params.id)
      await ActivityLog.add({
        partner_id: req.user.uid, type: 'withdrawal_cancelled',
        title: 'Withdrawal cancelled', icon: '✖️', color: '#dc2626',
      })
      emitToUser(req.user.uid, 'wallet:withdrawal-cancelled', { id: req.params.id })
      res.json(success('Cancelled'))
    } catch (err) { next(err) }
  },

  // Bank -----------------------------------------------------------------
  getBank: async (req, res, next) => {
    try {
      const bank = await Wallet.getBank(req.user.uid)
      res.json(success('Bank', { bank }))
    } catch (err) { next(err) }
  },

  linkBank: async (req, res, next) => {
    try {
      const { holder, bank_name, account_full, ifsc } = req.body || {}
      if (!holder || !bank_name || !account_full || !ifsc) {
        return res.status(400).json({ success: false, message: 'Missing fields' })
      }
      if (!/^\d{9,18}$/.test(account_full)) return res.status(400).json({ success: false, message: 'Invalid account number' })
      if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) return res.status(400).json({ success: false, message: 'Invalid IFSC' })

      const existing = await Wallet.getBank(req.user.uid)
      const bank = await Wallet.upsertBank({ partner_id: req.user.uid, holder, bank_name, account_full, ifsc })
      await ActivityLog.add({
        partner_id: req.user.uid,
        type: existing ? 'bank_updated' : 'bank_linked',
        title: existing ? 'Bank updated' : 'Bank linked',
        sub: `${bank_name} ••${bank.last4}`,
        icon: '🏦', color: '#2563eb',
      })
      res.json(success('Bank linked', { bank }))
    } catch (err) { next(err) }
  },

  removeBank: async (req, res, next) => {
    try {
      await Wallet.removeBank(req.user.uid)
      await ActivityLog.add({
        partner_id: req.user.uid, type: 'bank_removed',
        title: 'Bank removed', icon: '🏦', color: '#dc2626',
      })
      res.json(success('Bank removed'))
    } catch (err) { next(err) }
  },
}

// Expand a sparse [{key,total,jobs}] series into one row per period in the
// [from,to] window so the client can draw a continuous x-axis with empty
// buckets rendered as zeros.
function fillBuckets (from, to, granularity, rows) {
  const byKey = new Map(rows.map((r) => [r.key, r]))
  const pad = (n) => String(n).padStart(2, '0')
  const out = []
  if (granularity === 'day') {
    const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
    const end = new Date(to.getFullYear(), to.getMonth(), to.getDate())
    while (d <= end) {
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
      const hit = byKey.get(key)
      out.push({
        key,
        label: d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
        short: d.toLocaleDateString('en-GB', { weekday: 'short' }).slice(0, 3).toUpperCase(),
        total: hit?.total || 0,
        jobs:  hit?.jobs  || 0,
      })
      d.setDate(d.getDate() + 1)
    }
  } else {
    const d = new Date(from.getFullYear(), from.getMonth(), 1)
    const end = new Date(to.getFullYear(), to.getMonth(), 1)
    while (d <= end) {
      const key = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`
      const hit = byKey.get(key)
      out.push({
        key,
        label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }),
        short: d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase(),
        total: hit?.total || 0,
        jobs:  hit?.jobs  || 0,
      })
      d.setMonth(d.getMonth() + 1)
    }
  }
  return out
}
