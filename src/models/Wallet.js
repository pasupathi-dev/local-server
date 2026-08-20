// Wallet aggregate + wallet_transactions + withdrawals + bank_accounts.

const { db } = require('../config/db')
const { PENDING_CLEAR_DELAY_MS } = require('../config/constants')
const { getConfigNumber } = require('../utils/appConfig')

const TX   = 'wallet_transactions'
const WD   = 'withdrawals'
const BANK = 'bank_accounts'

const Wallet = {

  // ── Credits (transactions) ─────────────────────────
  credit: async ({ id, partner_id, job_id, service, customer_name, amount = 0, tip = 0 }) => {
    const eligible_at = new Date(Date.now() + PENDING_CLEAR_DELAY_MS)
    await db(TX).insert({
      id,
      partner_id,
      job_id:        job_id || null,
      type:          'credit',
      service:       service || null,
      customer_name: customer_name || null,
      amount,
      tip,
      total:         amount + tip,
      cleared:       false,
      eligible_at,
    })
    return db(TX).where({ id }).first()
  },

  listTx: (partner_id, limit = 500) => db(TX).where({ partner_id }).orderBy('created_at', 'desc').limit(limit),

  // ── Earnings analytics ─────────────────────────────
  // Returns bucketed credit totals between [from, to] for a partner.
  // granularity: 'day' groups by DATE(created_at); 'month' groups by YYYY-MM.
  // Only `type = credit` is counted (withdrawals are debits; we exclude them
  // from "earnings").
  earningsSeries: async (partner_id, { from, to, granularity = 'day' } = {}) => {
    const keyExpr = granularity === 'month'
      ? "DATE_FORMAT(created_at, '%Y-%m')"
      : "DATE_FORMAT(created_at, '%Y-%m-%d')"
    const rows = await db(TX)
      .where({ partner_id, type: 'credit' })
      .whereBetween('created_at', [from, to])
      .groupByRaw(keyExpr)
      .select(
        db.raw(`${keyExpr} as \`key\``),
        db.raw('SUM(total) as total'),
        db.raw('COUNT(*) as jobs'),
      )
      .orderByRaw(`${keyExpr} asc`)
    return rows.map((r) => ({ key: r.key, total: Number(r.total || 0), jobs: Number(r.jobs || 0) }))
  },

  earningsTotals: async (partner_id, { from, to } = {}) => {
    const row = await db(TX)
      .where({ partner_id, type: 'credit' })
      .whereBetween('created_at', [from, to])
      .sum({ total: 'total' })
      .count({ jobs: '*' })
      .first()
    return { total: Number(row?.total || 0), jobs: Number(row?.jobs || 0) }
  },

  earningsTopServices: async (partner_id, { from, to, limit = 5 } = {}) => {
    const rows = await db(TX)
      .where({ partner_id, type: 'credit' })
      .whereBetween('created_at', [from, to])
      .whereNotNull('service')
      .groupBy('service')
      .select('service', db.raw('SUM(total) as total'), db.raw('COUNT(*) as jobs'))
      .orderBy('total', 'desc')
      .limit(limit)
    return rows.map((r) => ({ service: r.service, total: Number(r.total || 0), jobs: Number(r.jobs || 0) }))
  },

  firstCreditAt: async (partner_id) => {
    const row = await db(TX).where({ partner_id, type: 'credit' })
      .min({ t: 'created_at' }).first()
    return row?.t || null
  },

  // Move all pending-past-eligible → cleared. Called by a cron tick (or on-demand).
  clearEligible: async (partner_id) => {
    return db(TX)
      .where({ partner_id, cleared: false })
      .where('eligible_at', '<=', db.fn.now())
      .update({ cleared: true })
  },

  summarize: async (partner_id) => {
    const [cleared, pending, month, count, withdrawnWds] = await Promise.all([
      db(TX).where({ partner_id, cleared: true }).sum({ s: 'total' }).first(),
      db(TX).where({ partner_id, cleared: false }).sum({ s: 'total' }).first(),
      db(TX).where({ partner_id })
        .whereRaw('MONTH(created_at) = MONTH(CURRENT_DATE()) AND YEAR(created_at) = YEAR(CURRENT_DATE())')
        .sum({ s: 'total' }).first(),
      db(TX).where({ partner_id }).count({ c: '*' }).first(),
      // Deduct processing + completed withdrawals so the UI balance matches
      // what withdrawAtomic sees — prevents "Insufficient balance" surprise.
      db(WD).where({ partner_id }).whereIn('status', ['processing', 'completed']).sum({ s: 'amount' }).first(),
    ])
    const grossCleared = Number(cleared?.s || 0)
    const withdrawn    = Number(withdrawnWds?.s || 0)
    return {
      balance:         Math.max(0, grossCleared - withdrawn),
      pendingClearance:Number(pending?.s || 0),
      monthEarned:     Number(month?.s || 0),
      jobsCounted:     Number(count?.c || 0),
    }
  },

  // ── Withdrawals ────────────────────────────────────
  createWithdrawal: async ({ id, partner_id, amount, ref, bank_short, complete_at }) => {
    await db(WD).insert({ id, partner_id, amount, status: 'processing', ref, bank_short, complete_at })
    return db(WD).where({ id }).first()
  },

  listWithdrawals: (partner_id, limit = 500) => db(WD).where({ partner_id }).orderBy('created_at', 'desc').limit(limit),

  // Single withdrawal row by id — used by callers that need the post-update
  // shape (e.g. auto-payout returning the completed row to the client).
  findWithdrawal: (id) => db(WD).where({ id }).first(),

  // Auto-payout trust gate. Returns true when the partner has earned the
  // right to skip the admin queue. Criteria (all required):
  //   - jobs_completed > 10                  (proven track record)
  //   - 0 partner-driven cancellations in last 7d
  //   - 0 disputes raised against them in last 30d
  isTrustedForAutoPayout: async (partner_id) => {
    const r = await Wallet.payoutEligibility(partner_id)
    return !!r?.eligible
  },

  // Same logic as isTrustedForAutoPayout but returns the full breakdown so
  // the partner UI can show *why* they're not yet eligible (and what to do).
  // Shape:
  //   {
  //     eligible:        boolean,
  //     jobs_completed:  number,
  //     jobs_threshold:  number,
  //     recent_cancels:  number,           // partner-driven, last 7d
  //     dispute_count:   number,           // last 30d
  //     blockers:        [{ key, label, action }]
  //   }
  payoutEligibility: async (partner_id) => {
    // All three thresholds are admin-tunable from the portal (app_config).
    // Defaults match the original L56 policy.
    const JOBS_THRESHOLD          = await getConfigNumber('trust_min_jobs', 10)
    const CANCEL_LOOKBACK_DAYS    = await getConfigNumber('trust_cancel_lookback_days', 7)
    const DISPUTE_LOOKBACK_DAYS   = await getConfigNumber('trust_dispute_lookback_days', 30)
    const empty = {
      eligible: false,
      jobs_completed: 0,
      jobs_threshold: JOBS_THRESHOLD,
      recent_cancels: 0,
      dispute_count:  0,
      blockers: [{ key: 'no_partner', label: 'Partner profile not found', action: null }],
    }
    if (!partner_id) return empty
    const partner = await db('partners').where({ user_id: partner_id }).first()
    if (!partner) return empty

    const jobs_completed = Number(partner.jobs_completed || 0)

    const cancelRow = await db('jobs')
      .where({ partner_id, state: 'cancelled', cancelled_by: 'partner' })
      .where('updated_at', '>=', db.raw(`DATE_SUB(NOW(), INTERVAL ${CANCEL_LOOKBACK_DAYS} DAY)`))
      .count({ n: '*' }).first()
    const recent_cancels = Number(cancelRow?.n || 0)

    let dispute_count = 0
    try {
      if (await db.schema.hasTable('disputes')) {
        const dispRow = await db('disputes')
          .where({ partner_id })
          .where('created_at', '>=', db.raw(`DATE_SUB(NOW(), INTERVAL ${DISPUTE_LOOKBACK_DAYS} DAY)`))
          .count({ n: '*' }).first()
        dispute_count = Number(dispRow?.n || 0)
      }
    } catch { /* table missing — treat as zero */ }

    const blockers = []
    if (jobs_completed <= JOBS_THRESHOLD) {
      const left = JOBS_THRESHOLD + 1 - jobs_completed
      blockers.push({
        key:    'jobs_threshold',
        label:  `Complete ${left} more job${left === 1 ? '' : 's'}`,
        action: `${jobs_completed} of ${JOBS_THRESHOLD + 1} required`,
      })
    }
    if (recent_cancels > 0) {
      blockers.push({
        key:    'recent_cancels',
        label:  `Avoid partner cancellations for ${CANCEL_LOOKBACK_DAYS} more days`,
        action: `${recent_cancels} cancellation${recent_cancels === 1 ? '' : 's'} in the last ${CANCEL_LOOKBACK_DAYS} days`,
      })
    }
    if (dispute_count > 0) {
      blockers.push({
        key:    'dispute_count',
        label:  'Resolve open disputes',
        action: `${dispute_count} dispute${dispute_count === 1 ? '' : 's'} in the last ${DISPUTE_LOOKBACK_DAYS} days`,
      })
    }

    return {
      eligible: blockers.length === 0,
      jobs_completed,
      jobs_threshold: JOBS_THRESHOLD,
      recent_cancels,
      dispute_count,
      blockers,
    }
  },

  completeWithdrawal: (id) => db(WD).where({ id, status: 'processing' }).update({
    status: 'completed', complete_at: db.fn.now(),
  }),
  // Bug #34: only cancel if still 'processing' — prevents race where a just-
  // completed withdrawal gets flipped back to cancelled.
  cancelWithdrawal: (id) => db(WD).where({ id, status: 'processing' }).update({ status: 'cancelled' }),

  // Bug #4: atomically check available balance (credits - completed withdrawals)
  // and insert a withdrawal in one transaction, preventing double-withdrawal races.
  withdrawAtomic: async ({ id, partner_id, amount, ref, bank_short, complete_at }) => {
    return db.transaction(async (trx) => {
      const [cleared, completedWds] = await Promise.all([
        trx('wallet_transactions').where({ partner_id, cleared: true }).sum({ s: 'total' }).first(),
        trx(WD).where({ partner_id }).whereIn('status', ['processing', 'completed']).sum({ s: 'amount' }).first(),
      ])
      const balance = Number(cleared?.s || 0) - Number(completedWds?.s || 0)
      if (balance < amount) throw Object.assign(new Error('Insufficient balance'), { code: 'INSUFFICIENT' })
      await trx(WD).insert({ id, partner_id, amount, status: 'processing', ref, bank_short, complete_at })
      return trx(WD).where({ id }).first()
    })
  },

  // Recover withdrawals that passed their complete_at but never completed
  // (e.g. server was down during the setTimeout). Bug #33.
  recoverStuckWithdrawals: () => db(WD)
    .where({ status: 'processing' })
    .where('complete_at', '<', db.fn.now())
    .update({ status: 'completed' }),

  // ── Bank account ──────────────────────────────────
  getBank: (partner_id) => db(BANK).where({ partner_id }).first(),
  upsertBank: async ({ partner_id, holder, bank_name, account_full, ifsc }) => {
    const last4 = String(account_full).slice(-4)
    const row = { partner_id, holder, bank_name, account_full, ifsc, last4 }
    await db(BANK).insert(row).onConflict('partner_id').merge({
      holder, bank_name, account_full, ifsc, last4,
      updated_at: db.fn.now(),
    })
    return db(BANK).where({ partner_id }).first()
  },
  removeBank: (partner_id) => db(BANK).where({ partner_id }).del(),
}

module.exports = Wallet
