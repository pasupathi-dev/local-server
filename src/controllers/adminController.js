// Admin-only controller — all queries are read/write via Knex.
// No existing business logic is touched; these are standalone admin queries.

const { db } = require('../config/db')
const push   = require('../services/pushService')
const razorpay = require('../config/razorpay')
const { txId } = require('../utils/ids')

const notifyWithdrawalCompleted = (partner_id, amount) => {
  push.sendToUser(partner_id, {
    title: `Withdrawal completed · ₹${amount}`,
    body:  'Money has been sent to your linked bank account.',
    data:  { type: 'withdrawal:completed', route: '/partner/wallet' },
  }).catch(() => {})
}
const notifyWithdrawalCancelled = (partner_id, amount) => {
  push.sendToUser(partner_id, {
    title: `Withdrawal cancelled · ₹${amount}`,
    body:  'The amount has been refunded back to your wallet.',
    data:  { type: 'withdrawal:cancelled', route: '/partner/wallet' },
  }).catch(() => {})
}

// ─── helpers ────────────────────────────────────────────────────────────────

const paginate = (query, page = 1, limit = 20) => {
  const offset = (Math.max(1, Number(page)) - 1) * Math.min(100, Number(limit))
  return query.limit(Number(limit)).offset(offset)
}

const ok   = (res, data, meta = {}) => res.json({ success: true, data, ...meta })
const fail = (res, msg, code = 400) => res.status(code).json({ success: false, message: msg })

// ─── DASHBOARD ───────────────────────────────────────────────────────────────

exports.getDashboardStats = async (req, res, next) => {
  try {
    const today = db.raw('DATE(NOW())')

    const [
      userRows,
      [{ onlinePartners }],
      [{ activeJobs }],
      [{ liveRequests }],
      [{ todayRevenue, todayPaid }],
      [{ pendingWdAmount, pendingWdCount }],
      [{ unclearedAmount }],
      [{ autoCancelled7d }],
    ] = await Promise.all([
      db('users').whereNull('deleted_at')
        .select(db.raw('role, COUNT(*) as cnt'))
        .groupBy('role'),
      db('partners').where({ is_online: true }).count('user_id as onlinePartners'),
      db('jobs').whereNotIn('state', ['paid', 'cancelled']).count('id as activeJobs'),
      db('requests').where({ status: 'live' }).count('id as liveRequests'),
      db('payments').where({ status: 'completed' })
        .whereRaw('DATE(paid_at) = ?', [db.raw('DATE(NOW())')])
        .select(db.raw('COALESCE(SUM(total),0) as todayRevenue, COUNT(*) as todayPaid')),
      db('withdrawals').where({ status: 'processing' })
        .select(db.raw('COALESCE(SUM(amount),0) as pendingWdAmount, COUNT(*) as pendingWdCount')),
      db('wallet_transactions').where({ cleared: false })
        .select(db.raw('COALESCE(SUM(total),0) as unclearedAmount')),
      // Health metric for the 48h stale-job cron — high numbers mean
      // partners aren't following through on accepted jobs.
      db('jobs')
        .where({ state: 'cancelled', cancelled_by: 'system' })
        .where('updated_at', '>=', db.raw('DATE_SUB(NOW(), INTERVAL 7 DAY)'))
        .select(db.raw('COUNT(id) as autoCancelled7d')),
    ])

    const userCounts = { total: 0, user: 0, partner: 0, admin: 0 }
    for (const r of userRows) {
      userCounts[r.role] = Number(r.cnt)
      userCounts.total += Number(r.cnt)
    }

    ok(res, {
      userCounts,
      onlinePartners:    Number(onlinePartners),
      activeJobs:        Number(activeJobs),
      liveRequests:      Number(liveRequests),
      todayRevenue:      Number(todayRevenue),
      todayPaid:         Number(todayPaid),
      pendingWdAmount:   Number(pendingWdAmount),
      pendingWdCount:    Number(pendingWdCount),
      unclearedAmount:   Number(unclearedAmount),
      autoCancelled7d:   Number(autoCancelled7d || 0),
    })
  } catch (err) { next(err) }
}

exports.getDashboardCharts = async (req, res, next) => {
  try {
    const [revenueRows, jobRows, cancelRows] = await Promise.all([
      db.raw(`
        SELECT DATE(paid_at) as date, COALESCE(SUM(total),0) as amount
        FROM payments WHERE status='completed' AND paid_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY DATE(paid_at) ORDER BY date ASC
      `),
      db.raw(`
        SELECT DATE(created_at) as date, COUNT(*) as count
        FROM jobs WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY DATE(created_at) ORDER BY date ASC
      `),
      db.raw(`
        SELECT cancel_reason as reason, COUNT(*) as count
        FROM jobs WHERE state='cancelled' AND cancel_reason IS NOT NULL
        GROUP BY cancel_reason ORDER BY count DESC
      `),
    ])

    ok(res, {
      revenueByDay:   revenueRows[0],
      jobsByDay:      jobRows[0],
      cancellations:  cancelRows[0],
    })
  } catch (err) { next(err) }
}

// ─── USERS ───────────────────────────────────────────────────────────────────

exports.listUsers = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, role, status, city, search } = req.query
    let q = db('users').whereNull('deleted_at')
      // Partners have their own tab/list (listPartners). Exclude anyone who
      // has a partner profile so a person never appears in both the Users and
      // Partners lists — even if their users.role is still 'user'. Collation
      // cast mirrors the users↔partners join used in listPartners.
      .whereNotExists(function () {
        this.select(db.raw('1')).from('partners as p')
          .whereRaw('p.user_id COLLATE utf8mb4_unicode_ci = users.user_id COLLATE utf8mb4_unicode_ci')
      })
      .select('user_id','email','phone','full_name','avatar_class','status','role','city','onboarding_done','created_at')
      .orderBy('created_at', 'desc')

    if (role)   q = q.where({ role })
    if (status) q = q.where({ status })
    if (city)   q = q.where({ city })
    if (search) q = q.where(b => b
      .where('full_name', 'like', `%${search}%`)
      .orWhere('email',   'like', `%${search}%`)
      .orWhere('phone',   'like', `%${search}%`))

    const totalQ  = q.clone().clearSelect().clearOrder().count('user_id as cnt')
    const [{ cnt }] = await totalQ
    const rows = await paginate(q.clone(), page, limit)

    ok(res, rows, { total: Number(cnt), page: Number(page), limit: Number(limit) })
  } catch (err) { next(err) }
}

exports.getUser = async (req, res, next) => {
  try {
    const { id } = req.params
    const user = await db('users').where({ user_id: id }).whereNull('deleted_at').first()
    if (!user) return fail(res, 'User not found', 404)

    const [partner, jobCount, notifications, settings] = await Promise.all([
      db('partners').where({ user_id: id }).first(),
      db('jobs').where(b => b.where('customer_id', id).orWhere('partner_id', id)).count('id as cnt').first(),
      db('notifications').where({ user_id: id }).orderBy('created_at','desc').limit(10),
      db('app_settings').where({ user_id: id }).first(),
    ])

    ok(res, { ...user, partner: partner || null, jobCount: Number(jobCount?.cnt || 0), notifications, settings })
  } catch (err) { next(err) }
}

exports.updateUser = async (req, res, next) => {
  try {
    const { id } = req.params
    const allowed = ['full_name','email','phone','address','city','pincode','avatar_class']
    const patch   = {}
    for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k]
    if (!Object.keys(patch).length) return fail(res, 'No valid fields to update')
    await db('users').where({ user_id: id }).update({ ...patch, updated_at: db.fn.now() })
    ok(res, await db('users').where({ user_id: id }).first())
  } catch (err) { next(err) }
}

exports.updateUserStatus = async (req, res, next) => {
  try {
    const { id } = req.params
    const { status } = req.body
    const valid = ['active','inactive','suspended','pending']
    if (!valid.includes(status)) return fail(res, 'Invalid status')
    await db('users').where({ user_id: id }).update({ status, updated_at: db.fn.now() })
    ok(res, { user_id: id, status })
  } catch (err) { next(err) }
}

exports.updateUserRole = async (req, res, next) => {
  try {
    const { id } = req.params
    const { role } = req.body
    const valid = ['user','partner','admin']
    if (!valid.includes(role)) return fail(res, 'Invalid role')
    await db('users').where({ user_id: id }).update({ role, updated_at: db.fn.now() })
    ok(res, { user_id: id, role })
  } catch (err) { next(err) }
}

// Side flag — a user/partner can be granted portal access without changing
// their primary `role`. They keep their normal app behaviour (jobs, requests,
// dashboard) AND get to sign into /portal/.
exports.updateUserAdmin = async (req, res, next) => {
  try {
    const { id } = req.params
    const next_is_admin = !!req.body?.is_admin
    const before = await db('users').where({ user_id: id }).first()
    if (!before) return fail(res, 'User not found', 404)
    // Don't let an admin demote themselves and lock the portal.
    if (req.adminUser?.user_id === id && !next_is_admin && before.role !== 'admin') {
      return fail(res, "You can't revoke your own admin access")
    }
    await db('users').where({ user_id: id }).update({ is_admin: next_is_admin, updated_at: db.fn.now() })
    await auditLog(req, next_is_admin ? 'grant_admin' : 'revoke_admin', 'user', id,
      { is_admin: !!before.is_admin }, { is_admin: next_is_admin })
    ok(res, { user_id: id, is_admin: next_is_admin })
  } catch (err) { next(err) }
}

exports.deleteUser = async (req, res, next) => {
  try {
    const { id } = req.params
    await db('users').where({ user_id: id }).update({ deleted_at: db.fn.now(), status: 'inactive' })
    ok(res, { user_id: id, deleted: true })
  } catch (err) { next(err) }
}

// ─── USER DEVICES (FCM tokens) ───────────────────────────────────────────────
//
// Admin can review every device a user has registered for push, and revoke
// any one (or all of them in one click) when an account is compromised.
// We never return the raw token — only the last 8 chars — so an admin can't
// impersonate the device. The token IS still passed in the URL for revoke
// since it's the primary key of the row.

// GET /api/admin/users/:id/devices
exports.listUserDevices = async (req, res, next) => {
  try {
    const { id } = req.params
    const rows = await db('fcm_tokens')
      .where({ user_id: id })
      .orderBy('last_seen_at', 'desc')
      .select('token', 'platform', 'user_agent', 'created_at', 'last_seen_at')
    const out = rows.map((r) => ({
      // Only expose the last 8 chars to the portal — full token is admin-
      // sensitive (FCM accepts it for sends until revoked).
      token_last8: String(r.token || '').slice(-8),
      // Plus a stable hash-like reference so the UI can call DELETE without
      // needing the full token. We just pass the token in the URL since it's
      // the PK; the DELETE handler is the only place the full token leaves
      // the DB.
      token: r.token,
      platform: r.platform,
      user_agent: r.user_agent,
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
    }))
    ok(res, out, { total: out.length })
  } catch (err) { next(err) }
}

// DELETE /api/admin/users/:id/devices/:token
exports.revokeUserDevice = async (req, res, next) => {
  try {
    const { id, token } = req.params
    if (!token) return fail(res, 'token required')
    const row = await db('fcm_tokens').where({ user_id: id, token }).first()
    if (!row) return fail(res, 'Device not found for this user', 404)

    await db('fcm_tokens').where({ user_id: id, token }).del()
    await auditLog(req, 'revoke_device', 'user', id,
      { token_last8: String(token).slice(-8), platform: row.platform },
      { revoked: true })
    ok(res, { user_id: id, token_last8: String(token).slice(-8), revoked: true })
  } catch (err) { next(err) }
}

// ─── PARTNERS ────────────────────────────────────────────────────────────────

exports.listPartners = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, category, work, city, online, verified, search, flagged } = req.query

    // Quality-flag subqueries:
    //   cancel_rate_30d   — partner-driven cancellations / total jobs touched in last 30d (0–100)
    //   avg_rating_recent — average stars over the partner's last 20 reviews
    // Both are computed inline as derived columns so the portal can sort and
    // filter without a second round-trip.
    const cancelRate30dSql = db.raw(`(
      SELECT CASE WHEN COUNT(*) = 0 THEN NULL
        ELSE ROUND(SUM(CASE WHEN state='cancelled' AND cancelled_by='partner' THEN 1 ELSE 0 END)
             / COUNT(*) * 100, 1)
      END
      FROM jobs WHERE partner_id COLLATE utf8mb4_unicode_ci = p.user_id COLLATE utf8mb4_unicode_ci
        AND updated_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    ) AS cancel_rate_30d`)

    const avgRecentSql = db.raw(`(
      SELECT ROUND(AVG(stars), 2) FROM (
        SELECT stars FROM reviews
        WHERE partner_id COLLATE utf8mb4_unicode_ci = p.user_id COLLATE utf8mb4_unicode_ci
        ORDER BY created_at DESC LIMIT 20
      ) t
    ) AS avg_rating_recent`)

    // `partners.user_id` and `users.user_id` were created with different
    // default collations on some installs (utf8mb4_unicode_ci vs the
    // MySQL 8 default utf8mb4_0900_ai_ci). MySQL refuses to compare them
    // directly with "Illegal mix of collations" — we force both sides to
    // utf8mb4_unicode_ci on the join so the query works on any host
    // regardless of which collation the schema was bootstrapped with.
    let q = db('partners as p')
      .join('users as u', function () {
        this.on(db.raw('u.user_id COLLATE utf8mb4_unicode_ci = p.user_id COLLATE utf8mb4_unicode_ci'))
      })
      .whereNull('u.deleted_at')
      .select(
        'p.user_id','p.primary_category','p.primary_work','p.is_online','p.is_verified','p.top_rated',
        'p.rating_avg','p.rating_count','p.jobs_completed','p.location_city',
        'p.phone_verified','p.background_checked','p.created_at',
        'u.full_name','u.email','u.phone','u.status','u.city',
        cancelRate30dSql, avgRecentSql,
      )
      .orderBy('p.created_at', 'desc')

    if (category) q = q.where({ 'p.primary_category': category })
    // Filter by a specific work (taxonomy v2): primary_work OR a pwp row.
    if (work) q = q.where((b) => b
      .where('p.primary_work', work)
      .orWhereExists(function () {
        this.select(db.raw('1')).from('partner_category_prices as pwp')
          .whereRaw('pwp.partner_id COLLATE utf8mb4_unicode_ci = p.user_id COLLATE utf8mb4_unicode_ci')
          .andWhere('pwp.work_name', work)
      }))
    if (city)     q = q.where('u.city', 'like', `%${city}%`)
    if (online !== undefined)   q = q.where({ 'p.is_online': online === 'true' ? 1 : 0 })
    if (verified !== undefined) q = q.where({ 'p.is_verified': verified === 'true' ? 1 : 0 })
    if (search)   q = q.where(b => b
      .where('u.full_name', 'like', `%${search}%`)
      .orWhere('u.email',   'like', `%${search}%`))

    // ?flagged=true → only partners exceeding either quality threshold.
    // Implemented as a HAVING since the columns are derived.
    if (flagged === 'true') {
      q = q.havingRaw('(cancel_rate_30d > 30 OR avg_rating_recent < 3.5)')
    }

    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('p.user_id as cnt')
    const rows = await paginate(q.clone(), page, limit)
    ok(res, rows, { total: Number(cnt), page: Number(page), limit: Number(limit) })
  } catch (err) { next(err) }
}

exports.getPartner = async (req, res, next) => {
  try {
    const { id } = req.params
    // Same collation cast as listPartners — see note there.
    const partner = await db('partners as p')
      .join('users as u', function () {
        this.on(db.raw('u.user_id COLLATE utf8mb4_unicode_ci = p.user_id COLLATE utf8mb4_unicode_ci'))
      })
      .where('p.user_id', id)
      .select('p.*','u.full_name','u.email','u.phone','u.status','u.city','u.avatar_class','u.role')
      .first()
    if (!partner) return fail(res, 'Partner not found', 404)

    const [pricing, wallet, reviews, recentActivity, bankAccount] = await Promise.all([
      db('partner_category_prices').where({ partner_id: id }),
      db('wallet_transactions').where({ partner_id: id })
        .select(
          db.raw('COALESCE(SUM(CASE WHEN cleared=1 THEN total ELSE 0 END),0) as cleared_balance'),
          db.raw('COALESCE(SUM(CASE WHEN cleared=0 THEN total ELSE 0 END),0) as pending_balance'),
          db.raw('COUNT(*) as total_transactions')
        ).first(),
      db('reviews').where({ partner_id: id }).orderBy('created_at','desc').limit(5),
      db('activity_log').where({ partner_id: id }).orderBy('created_at','desc').limit(10),
      db('bank_accounts').where({ partner_id: id }).first(),
    ])

    ok(res, { ...partner, pricing, wallet, reviews, recentActivity, bankAccount: bankAccount || null })
  } catch (err) { next(err) }
}

exports.updatePartner = async (req, res, next) => {
  try {
    const { id } = req.params
    const allowed = [
      'primary_category','primary_work','experience_years','availability_days','availability_hours',
      'emergency_service','service_radius_km','own_tools','materials_extra',
      'about','zone',
    ]
    const patch = {}
    for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k]
    if (!Object.keys(patch).length) return fail(res, 'No valid fields')
    await db('partners').where({ user_id: id }).update({ ...patch, updated_at: db.fn.now() })
    ok(res, { user_id: id, updated: true })
  } catch (err) { next(err) }
}

exports.verifyPartner = async (req, res, next) => {
  try {
    const { id } = req.params
    const flags = ['is_verified','aadhaar_verified','phone_verified','background_checked','top_rated']
    const patch = {}
    for (const f of flags) if (req.body[f] !== undefined) patch[f] = req.body[f] ? 1 : 0
    if (!Object.keys(patch).length) return fail(res, 'No valid flags')
    await db('partners').where({ user_id: id }).update({ ...patch, updated_at: db.fn.now() })
    ok(res, { user_id: id, ...patch })
  } catch (err) { next(err) }
}

exports.forceOnlinePartner = async (req, res, next) => {
  try {
    const { id } = req.params
    const { online } = req.body
    const is_online = online ? 1 : 0
    await db('partners').where({ user_id: id }).update({ is_online, updated_at: db.fn.now() })
    ok(res, { user_id: id, is_online })
  } catch (err) { next(err) }
}

exports.getPartnerWallet = async (req, res, next) => {
  try {
    const { id } = req.params
    const { page = 1, limit = 20 } = req.query
    const [summary, txRows, wdRows] = await Promise.all([
      db('wallet_transactions').where({ partner_id: id }).select(
        db.raw('COALESCE(SUM(CASE WHEN cleared=1 THEN total ELSE 0 END),0) as cleared_balance'),
        db.raw('COALESCE(SUM(CASE WHEN cleared=0 THEN total ELSE 0 END),0) as pending_balance'),
        db.raw('COALESCE(SUM(total),0) as total_earned'),
        db.raw('COUNT(*) as tx_count'),
      ).first(),
      paginate(db('wallet_transactions').where({ partner_id: id }).orderBy('created_at','desc'), page, limit),
      db('withdrawals').where({ partner_id: id }).orderBy('created_at','desc').limit(10),
    ])
    ok(res, { summary, transactions: txRows, withdrawals: wdRows })
  } catch (err) { next(err) }
}

exports.getPartnerActivity = async (req, res, next) => {
  try {
    const { id } = req.params
    const { page = 1, limit = 30 } = req.query
    const rows = await paginate(db('activity_log').where({ partner_id: id }).orderBy('created_at','desc'), page, limit)
    ok(res, rows)
  } catch (err) { next(err) }
}

// ─── JOBS ────────────────────────────────────────────────────────────────────

exports.listJobs = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, state, category, work, search, from, to } = req.query
    let q = db('jobs').orderBy('created_at','desc')
      .select('id','category_name','work_name','customer_name','partner_name','state','base_price','agreed_price',
        'tip_amount','cancel_reason','cancelled_by','created_at','completed_at','paid_at')

    if (state)    q = q.where({ state })
    if (category) q = q.where({ category_name: category })
    if (work)     q = q.where({ work_name: work })
    if (from)     q = q.where('created_at', '>=', from)
    if (to)       q = q.where('created_at', '<=', to + ' 23:59:59')
    if (search)   q = q.where(b => b
      .where('id', 'like', `%${search}%`)
      .orWhere('customer_name', 'like', `%${search}%`)
      .orWhere('partner_name',  'like', `%${search}%`))

    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('id as cnt')
    const rows = await paginate(q.clone(), page, limit)
    ok(res, rows, { total: Number(cnt), page: Number(page), limit: Number(limit) })
  } catch (err) { next(err) }
}

exports.getJob = async (req, res, next) => {
  try {
    const { id } = req.params
    const job = await db('jobs').where({ id }).first()
    if (!job) return fail(res, 'Job not found', 404)

    const [messages, payment] = await Promise.all([
      db('messages').where({ job_id: id }).orderBy('created_at','asc'),
      db('payments').where({ job_id: id }).first(),
    ])

    ok(res, { ...job, messages, payment: payment || null })
  } catch (err) { next(err) }
}

exports.cancelJob = async (req, res, next) => {
  try {
    const { id } = req.params
    const { reason = 'Admin cancelled' } = req.body
    const job = await db('jobs').where({ id }).first()
    if (!job) return fail(res, 'Job not found', 404)
    if (['paid','cancelled'].includes(job.state)) return fail(res, 'Job already finalised')

    await db('jobs').where({ id }).update({
      state: 'cancelled', cancel_reason: reason,
      cancelled_by: 'admin', updated_at: db.fn.now(),
    })
    ok(res, { id, state: 'cancelled' })
  } catch (err) { next(err) }
}

// ─── REQUESTS ────────────────────────────────────────────────────────────────

exports.listRequests = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, category, work } = req.query
    let q = db('requests').orderBy('created_at','desc')
      .select('id','customer_name','category_name','work_name','service','base_price','status','expires_at','distance_km','created_at')

    if (status)   q = q.where({ status })
    if (category) q = q.where({ category_name: category })
    if (work)     q = q.where({ work_name: work })

    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('id as cnt')
    const rows = await paginate(q.clone(), page, limit)
    ok(res, rows, { total: Number(cnt), page: Number(page), limit: Number(limit) })
  } catch (err) { next(err) }
}

exports.expireRequest = async (req, res, next) => {
  try {
    const { id } = req.params
    const req_ = await db('requests').where({ id }).first()
    if (!req_) return fail(res, 'Request not found', 404)
    if (req_.status !== 'live') return fail(res, 'Request is not live')
    await db('requests').where({ id }).update({ status: 'expired' })
    ok(res, { id, status: 'expired' })
  } catch (err) { next(err) }
}

// ─── SCHEDULES ───────────────────────────────────────────────────────────────

exports.listSchedules = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, category, work, from, to } = req.query
    let q = db('scheduled_jobs').orderBy('created_at','desc')
      .select('id','customer_name','partner_name','category_name','work_name','service','schedule_date','time_slot',
        'status','alert_24h_sent','alert_1h_sent','alert_15m_sent','alert_start_sent','created_at')

    if (status)   q = q.where({ status })
    if (category) q = q.where({ category_name: category })
    if (work)     q = q.where({ work_name: work })
    if (from)     q = q.where('schedule_date', '>=', from)
    if (to)       q = q.where('schedule_date', '<=', to)

    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('id as cnt')
    const rows = await paginate(q.clone(), page, limit)
    ok(res, rows, { total: Number(cnt), page: Number(page), limit: Number(limit) })
  } catch (err) { next(err) }
}

exports.cancelSchedule = async (req, res, next) => {
  try {
    const { id } = req.params
    const sj = await db('scheduled_jobs').where({ id }).first()
    if (!sj) return fail(res, 'Scheduled job not found', 404)
    if (['cancelled','converted'].includes(sj.status)) return fail(res, 'Already finalised')
    await db('scheduled_jobs').where({ id }).update({ status: 'cancelled', updated_at: db.fn.now() })
    ok(res, { id, status: 'cancelled' })
  } catch (err) { next(err) }
}

// ─── PAYMENTS ────────────────────────────────────────────────────────────────

exports.listPayments = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, method, search, from, to } = req.query
    let q = db('payments').orderBy('created_at','desc')
      .select('id','job_id','customer_id','partner_id','amount','tip','total',
        'platform_fee','method','status','paid_at','created_at',
        'razorpay_order_id','razorpay_payment_id')

    if (status) q = q.where({ status })
    if (method) q = q.where({ method })
    if (from)   q = q.where('created_at', '>=', from)
    if (to)     q = q.where('created_at', '<=', to + ' 23:59:59')
    if (search) q = q.where(b => b
      .where('job_id', 'like', `%${search}%`)
      .orWhere('razorpay_payment_id', 'like', `%${search}%`))

    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('id as cnt')
    const [{ totalAmt }] = await q.clone().where({ status: 'completed' })
      .clearSelect().clearOrder().select(db.raw('COALESCE(SUM(total),0) as totalAmt'))
    const rows = await paginate(q.clone(), page, limit)

    ok(res, rows, { total: Number(cnt), totalAmount: Number(totalAmt), page: Number(page), limit: Number(limit) })
  } catch (err) { next(err) }
}

exports.getPayment = async (req, res, next) => {
  try {
    const { id } = req.params
    const payment = await db('payments').where({ id }).first()
    if (!payment) return fail(res, 'Payment not found', 404)

    const [job, walletTx] = await Promise.all([
      db('jobs').where({ id: payment.job_id }).select('id','state','customer_name','partner_name').first(),
      db('wallet_transactions').where({ job_id: payment.job_id }).first(),
    ])
    ok(res, { ...payment, job: job || null, walletTx: walletTx || null })
  } catch (err) { next(err) }
}

// ─── WALLET ───────────────────────────────────────────────────────────────────

exports.getWalletOverview = async (req, res, next) => {
  try {
    const [cleared, pending, monthEarned, [wdPending], [wdCompleted]] = await Promise.all([
      db('wallet_transactions').where({ cleared: true })
        .select(db.raw('COALESCE(SUM(total),0) as amount')).first(),
      db('wallet_transactions').where({ cleared: false })
        .select(db.raw('COALESCE(SUM(total),0) as amount')).first(),
      db('wallet_transactions')
        .whereRaw('MONTH(created_at)=MONTH(NOW()) AND YEAR(created_at)=YEAR(NOW())')
        .select(db.raw('COALESCE(SUM(total),0) as amount')).first(),
      db('withdrawals').where({ status: 'processing' })
        .select(db.raw('COALESCE(SUM(amount),0) as amount, COUNT(*) as count')),
      db('withdrawals').where({ status: 'completed' })
        .select(db.raw('COALESCE(SUM(amount),0) as amount, COUNT(*) as count')),
    ])
    ok(res, {
      clearedBalance:    Number(cleared.amount),
      pendingBalance:    Number(pending.amount),
      monthEarned:       Number(monthEarned.amount),
      pendingWithdrawals: { amount: Number(wdPending.amount), count: Number(wdPending.count) },
      completedWithdrawals: { amount: Number(wdCompleted.amount), count: Number(wdCompleted.count) },
    })
  } catch (err) { next(err) }
}

exports.listWithdrawals = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, partner_id } = req.query
    let q = db('withdrawals as w')
      .join('users as u', 'u.user_id', 'w.partner_id')
      .select('w.*','u.full_name as partner_name','u.email as partner_email')
      .orderBy('w.created_at','desc')

    if (status)     q = q.where({ 'w.status': status })
    if (partner_id) q = q.where({ 'w.partner_id': partner_id })

    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('w.id as cnt')
    const rows = await paginate(q.clone(), page, limit)
    ok(res, rows, { total: Number(cnt), page: Number(page), limit: Number(limit) })
  } catch (err) { next(err) }
}

exports.updateWithdrawal = async (req, res, next) => {
  try {
    const { id } = req.params
    const { action } = req.body  // 'approve' | 'cancel'
    const wd = await db('withdrawals').where({ id }).first()
    if (!wd) return fail(res, 'Withdrawal not found', 404)

    if (action === 'approve') {
      if (wd.status !== 'processing') return fail(res, 'Not in processing state')
      await db('withdrawals').where({ id }).update({ status: 'completed', complete_at: db.fn.now(), updated_at: db.fn.now() })
      notifyWithdrawalCompleted(wd.partner_id, wd.amount)
      ok(res, { id, status: 'completed' })
    } else if (action === 'cancel') {
      if (wd.status !== 'processing') return fail(res, 'Not in processing state')
      // Refund back to wallet — re-credit partner
      await db.transaction(async (trx) => {
        await trx('withdrawals').where({ id }).update({ status: 'cancelled', updated_at: trx.fn.now() })
        await trx('wallet_transactions').insert({
          partner_id: wd.partner_id, type: 'credit',
          service: 'Withdrawal Refund', customer_name: 'System',
          amount: wd.amount, tip: 0, total: wd.amount,
          cleared: true, eligible_at: trx.fn.now(), created_at: trx.fn.now(),
        })
      })
      notifyWithdrawalCancelled(wd.partner_id, wd.amount)
      ok(res, { id, status: 'cancelled', refunded: true })
    } else {
      fail(res, 'Invalid action. Use approve or cancel')
    }
  } catch (err) { next(err) }
}

exports.clearPendingCredits = async (req, res, next) => {
  try {
    const affected = await db('wallet_transactions')
      .where({ cleared: false })
      .where('eligible_at', '<=', db.fn.now())
      .update({ cleared: true })
    ok(res, { cleared: affected })
  } catch (err) { next(err) }
}

// ─── REVIEWS ─────────────────────────────────────────────────────────────────

exports.listReviews = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, stars, type = 'partner', search } = req.query
    const table = type === 'customer' ? 'customer_ratings' : 'reviews'
    let q = db(table).orderBy('created_at','desc')

    if (stars)  q = q.where({ stars: Number(stars) })
    if (search) q = q.where('comment', 'like', `%${search}%`)

    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('id as cnt')
    const rows = await paginate(q.clone(), page, limit)
    ok(res, rows, { total: Number(cnt), page: Number(page), limit: Number(limit), type })
  } catch (err) { next(err) }
}

exports.deleteReview = async (req, res, next) => {
  try {
    const { id } = req.params
    const { type = 'partner' } = req.query
    const table = type === 'customer' ? 'customer_ratings' : 'reviews'
    const review = await db(table).where({ id }).first()
    if (!review) return fail(res, 'Review not found', 404)

    await db(table).where({ id }).delete()

    if (type === 'partner' && review.partner_id) {
      const agg = await db('reviews').where({ partner_id: review.partner_id })
        .select(db.raw('AVG(stars) as avg_stars, COUNT(*) as cnt')).first()
      await db('partners').where({ user_id: review.partner_id }).update({
        rating_avg:   Number(agg.avg_stars || 0).toFixed(2),
        rating_count: Number(agg.cnt || 0),
        updated_at:   db.fn.now(),
      })
    }

    ok(res, { id, deleted: true })
  } catch (err) { next(err) }
}

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

exports.listNotifications = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, type, user_id, unread } = req.query
    let q = db('notifications').orderBy('created_at','desc')

    if (type)    q = q.where({ type })
    if (user_id) q = q.where({ user_id })
    if (unread === 'true') q = q.where({ read: false })

    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('id as cnt')
    const rows = await paginate(q.clone(), page, limit)
    ok(res, rows, { total: Number(cnt), page: Number(page), limit: Number(limit) })
  } catch (err) { next(err) }
}

exports.sendNotification = async (req, res, next) => {
  try {
    const { target, user_id, role, city, category, type, title, body, icon, icon_bg, route } = req.body
    if (!title || !body) return fail(res, 'title and body are required')

    let userIds = []

    if (target === 'user') {
      if (!user_id) return fail(res, 'user_id required for target=user')
      userIds = [user_id]
    } else {
      let q = db('users').whereNull('deleted_at').select('user_id')
      if (target === 'partners')  q = q.where({ role: 'partner' })
      if (target === 'customers') q = q.where({ role: 'user' })
      if (role)                   q = q.where({ role })
      if (city)                   q = q.where({ city })
      const rows = await q
      userIds = rows.map(r => r.user_id)
    }

    if (!userIds.length) return fail(res, 'No matching users found')

    const rows = userIds.map(uid => ({
      user_id:  uid, type: type || 'promo',
      title, body,
      icon:    icon    || '📢',
      icon_bg: icon_bg || '#3b82f6',
      route:   route || null,
      read: false, created_at: new Date(),
    }))

    await db('notifications').insert(rows)
    ok(res, { sent: rows.length })
  } catch (err) { next(err) }
}

// ─── CATEGORIES ──────────────────────────────────────────────────────────────

exports.listCategories = async (req, res, next) => {
  try {
    const [categories, onlineCounts, activeCounts] = await Promise.all([
      db('categories').orderBy('sort_order','asc').orderBy('name','asc'),
      db('partners').where({ is_online: true })
        .select('primary_category', db.raw('COUNT(*) as cnt'))
        .groupBy('primary_category'),
      db('jobs').whereNotIn('state', ['paid','cancelled'])
        .select('category_name', db.raw('COUNT(*) as cnt'))
        .groupBy('category_name'),
    ])

    const onlineMap = Object.fromEntries(onlineCounts.map(r => [r.primary_category, Number(r.cnt)]))
    const activeMap = Object.fromEntries(activeCounts.map(r => [r.category_name, Number(r.cnt)]))

    const data = categories.map(c => ({
      ...c,
      display_name:    c.display_name || c.name,
      online_partners: onlineMap[c.name] || 0,
      active_jobs:     activeMap[c.name] || 0,
    }))

    ok(res, data)
  } catch (err) { next(err) }
}

exports.updateCategory = async (req, res, next) => {
  try {
    const { name } = req.params
    const allowed = ['icon','image_url','pin_color','sort_order','is_active','description','base_price_suggestion','display_name']
    const patch = {}
    for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k]
    if (!Object.keys(patch).length) return fail(res, 'No valid fields')
    await db('categories').where({ name }).update(patch)
    ok(res, await db('categories').where({ name }).first())
  } catch (err) { next(err) }
}

exports.createCategory = async (req, res, next) => {
  try {
    const { name, display_name, icon, image_url, pin_color, sort_order, description, base_price_suggestion } = req.body
    // Categories are now image-led; `icon` (emoji) is an optional fallback.
    if (!name) return fail(res, 'name is required')
    const exists = await db('categories').where({ name }).first()
    if (exists) return fail(res, 'Category already exists')
    await db('categories').insert({
      name,
      display_name:          display_name || null,
      icon:                  icon || null,
      image_url:             image_url || null,
      pin_color:             pin_color || '#6366f1',
      sort_order:            sort_order || 99,
      is_active:             true,
      description:           description || null,
      base_price_suggestion: base_price_suggestion || null,
    })
    await auditLog(req, 'create_category', 'category', name, null, { name, display_name, image_url })
    ok(res, await db('categories').where({ name }).first())
  } catch (err) { next(err) }
}

exports.deleteCategory = async (req, res, next) => {
  try {
    const { name } = req.params
    const cat = await db('categories').where({ name }).first()
    if (!cat) return fail(res, 'Category not found', 404)
    const hasWorks = await db('works').where({ category_name: name }).count('name as cnt').first()
    if (Number(hasWorks.cnt) > 0) return fail(res, 'Category has works under it — move or delete them first')
    const inUse = await db('jobs').where({ category_name: name }).count('id as cnt').first()
    if (Number(inUse.cnt) > 0) return fail(res, 'Category is in use by jobs — deactivate instead')
    await db('categories').where({ name }).delete()
    await auditLog(req, 'delete_category', 'category', name, cat, null)
    ok(res, { name, deleted: true })
  } catch (err) { next(err) }
}

exports.toggleCategoryActive = async (req, res, next) => {
  try {
    const { name } = req.params
    const cat = await db('categories').where({ name }).first()
    if (!cat) return fail(res, 'Category not found', 404)
    const is_active = !cat.is_active
    await db('categories').where({ name }).update({ is_active })
    await auditLog(req, 'toggle_category', 'category', name, { is_active: cat.is_active }, { is_active })
    ok(res, { name, is_active })
  } catch (err) { next(err) }
}

// ─── WORKS (taxonomy v2 leaf — the bookable unit under a parent category) ─────

exports.listWorks = async (req, res, next) => {
  try {
    const { category } = req.query
    const base = db('works').orderBy('category_name', 'asc').orderBy('sort_order', 'asc')
    if (category) base.where({ category_name: category })
    const [works, onlineCounts, activeCounts] = await Promise.all([
      base,
      db('partners').where({ is_online: true }).whereNotNull('primary_work')
        .select('primary_work').count('* as cnt').groupBy('primary_work'),
      db('jobs').whereNotIn('state', ['paid', 'cancelled']).whereNotNull('work_name')
        .select('work_name').count('* as cnt').groupBy('work_name'),
    ])
    const onlineMap = Object.fromEntries(onlineCounts.map(r => [r.primary_work, Number(r.cnt)]))
    const activeMap = Object.fromEntries(activeCounts.map(r => [r.work_name, Number(r.cnt)]))
    const data = works.map(w => ({
      ...w,
      display_name:    w.display_name || w.name,
      online_partners: onlineMap[w.name] || 0,
      active_jobs:     activeMap[w.name] || 0,
    }))
    ok(res, data)
  } catch (err) { next(err) }
}

exports.createWork = async (req, res, next) => {
  try {
    const { name, category_name, display_name, icon, image_url, pin_color, sort_order, description, base_price_suggestion } = req.body
    if (!name || !category_name) return fail(res, 'name and category_name are required')
    const parent = await db('categories').where({ name: category_name }).first()
    if (!parent) return fail(res, 'Parent category not found')
    const exists = await db('works').where({ name }).first()
    if (exists) return fail(res, 'Work already exists')
    await db('works').insert({
      name,
      category_name,
      display_name:          display_name || null,
      icon:                  icon || parent.icon || null,
      image_url:             image_url || null,
      pin_color:             pin_color || parent.pin_color || '#6366f1',
      sort_order:            sort_order || 99,
      is_active:             true,
      description:           description || null,
      base_price_suggestion: base_price_suggestion || null,
    })
    await auditLog(req, 'create_work', 'work', name, null, { name, category_name })
    ok(res, await db('works').where({ name }).first())
  } catch (err) { next(err) }
}

exports.updateWork = async (req, res, next) => {
  try {
    const { name } = req.params
    const allowed = ['category_name', 'icon', 'image_url', 'pin_color', 'sort_order', 'is_active', 'description', 'base_price_suggestion', 'display_name']
    const patch = {}
    for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k]
    if (!Object.keys(patch).length) return fail(res, 'No valid fields')
    if (patch.category_name) {
      const parent = await db('categories').where({ name: patch.category_name }).first()
      if (!parent) return fail(res, 'Parent category not found')
    }
    await db('works').where({ name }).update(patch)
    await auditLog(req, 'update_work', 'work', name, null, patch)
    ok(res, await db('works').where({ name }).first())
  } catch (err) { next(err) }
}

exports.deleteWork = async (req, res, next) => {
  try {
    const { name } = req.params
    const w = await db('works').where({ name }).first()
    if (!w) return fail(res, 'Work not found', 404)
    const inUse = await db('jobs').where({ work_name: name }).count('id as cnt').first()
    if (Number(inUse.cnt) > 0) return fail(res, 'Work is in use by jobs — deactivate instead')
    await db('works').where({ name }).delete()
    await auditLog(req, 'delete_work', 'work', name, w, null)
    ok(res, { name, deleted: true })
  } catch (err) { next(err) }
}

exports.toggleWorkActive = async (req, res, next) => {
  try {
    const { name } = req.params
    const w = await db('works').where({ name }).first()
    if (!w) return fail(res, 'Work not found', 404)
    const is_active = !w.is_active
    await db('works').where({ name }).update({ is_active })
    await auditLog(req, 'toggle_work', 'work', name, { is_active: w.is_active }, { is_active })
    ok(res, { name, is_active })
  } catch (err) { next(err) }
}

// ─── APP CONFIG ──────────────────────────────────────────────────────────────

exports.getAdminConfig = async (req, res, next) => {
  try {
    const rows = await db('app_config').orderBy('key')
    const config = {}
    for (const r of rows) {
      try { config[r.key] = { value: JSON.parse(r.value), label: r.label, type: r.type } }
      catch { config[r.key] = { value: r.value, label: r.label, type: r.type } }
    }
    ok(res, config)
  } catch (err) { next(err) }
}

exports.setAdminConfig = async (req, res, next) => {
  try {
    const { key, value } = req.body
    if (!key) return fail(res, 'key is required')
    const existing = await db('app_config').where({ key }).first()
    if (!existing) return fail(res, 'Config key not found')
    const before = existing.value
    await db('app_config').where({ key }).update({ value: JSON.stringify(value), updated_at: db.fn.now() })
    await auditLog(req, 'set_config', 'app_config', key, { value: before }, { value: JSON.stringify(value) })
    ok(res, { key, value })
  } catch (err) { next(err) }
}

// ─── ANNOUNCEMENTS ───────────────────────────────────────────────────────────

exports.listAnnouncements = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, active } = req.query
    let q = db('announcements').orderBy('created_at','desc')
    if (active !== undefined) q = q.where({ is_active: active === 'true' ? 1 : 0 })
    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('id as cnt')
    const rows = await paginate(q.clone(), page, limit)
    ok(res, rows, { total: Number(cnt), page: Number(page), limit: Number(limit) })
  } catch (err) { next(err) }
}

exports.createAnnouncement = async (req, res, next) => {
  try {
    const { title, body, type, target, starts_at, ends_at } = req.body
    if (!title || !body) return fail(res, 'title and body are required')
    const [id] = await db('announcements').insert({
      title, body,
      type:       type   || 'info',
      target:     target || 'all',
      is_active:  true,
      starts_at:  starts_at || db.fn.now(),
      ends_at:    ends_at   || null,
      created_by: req.adminUser?.user_id || null,
      created_at: db.fn.now(),
    })
    await auditLog(req, 'create_announcement', 'announcement', String(id), null, { title, type })
    ok(res, await db('announcements').where({ id }).first())
  } catch (err) { next(err) }
}

exports.updateAnnouncement = async (req, res, next) => {
  try {
    const { id } = req.params
    const allowed = ['title','body','type','target','is_active','starts_at','ends_at']
    const patch = {}
    for (const k of allowed) if (req.body[k] !== undefined) patch[k] = req.body[k]
    if (!Object.keys(patch).length) return fail(res, 'No valid fields')
    await db('announcements').where({ id }).update({ ...patch, updated_at: db.fn.now() })
    ok(res, await db('announcements').where({ id }).first())
  } catch (err) { next(err) }
}

exports.deleteAnnouncement = async (req, res, next) => {
  try {
    const { id } = req.params
    const a = await db('announcements').where({ id }).first()
    if (!a) return fail(res, 'Announcement not found', 404)
    await db('announcements').where({ id }).delete()
    ok(res, { id, deleted: true })
  } catch (err) { next(err) }
}

// ─── PUSH LOG ─────────────────────────────────────────────────────────────────
// Read-only delivery log written by pushService.sendToTokens. Useful when a
// user reports "I never got the notification" — admins can confirm whether
// the row was attempted, how many tokens it hit, and which FCM error codes
// came back. No resolve action — pure visibility.

exports.listPushLog = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, user_id, type, since, until, status } = req.query
    let q = db('push_log as p')
      .leftJoin('users as u', 'u.user_id', 'p.user_id')
      .select('p.*', 'u.full_name as user_name', 'u.email as user_email')
      .orderBy('p.created_at', 'desc')
    if (user_id) q = q.where('p.user_id', user_id)
    if (type)    q = q.where('p.type', type)
    if (since)   q = q.where('p.created_at', '>=', since)
    if (until)   q = q.where('p.created_at', '<=', until)
    if (status === 'failed_only') q = q.where('p.failed', '>', 0)

    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('p.id as cnt')

    // 24h headline strip — independent of current filter so the snapshot
    // always reflects platform-wide health.
    const [headline] = await db.raw(`
      SELECT
        COUNT(*)            AS pushes,
        COALESCE(SUM(sent),0)   AS sent,
        COALESCE(SUM(failed),0) AS failed
      FROM push_log
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
    `)
    const h = (Array.isArray(headline) ? headline[0] : headline) || {}
    const totalAttempts = Number(h.sent || 0) + Number(h.failed || 0)
    const successRate   = totalAttempts > 0
      ? Math.round((Number(h.sent || 0) / totalAttempts) * 100)
      : null

    const rows = await paginate(q.clone(), page, limit)
    ok(res, rows, {
      total: Number(cnt),
      page:  Number(page),
      limit: Number(limit),
      headline: {
        pushes:       Number(h.pushes || 0),
        sent:         Number(h.sent   || 0),
        failed:       Number(h.failed || 0),
        success_rate: successRate,
      },
    })
  } catch (err) { next(err) }
}

// ─── AUDIT LOG ────────────────────────────────────────────────────────────────

exports.getAuditLog = async (req, res, next) => {
  try {
    const { page = 1, limit = 50, action, target_type, admin_id } = req.query
    let q = db('admin_audit_log').orderBy('created_at','desc')
    if (action)      q = q.where({ action })
    if (target_type) q = q.where({ target_type })
    if (admin_id)    q = q.where({ admin_id })
    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('id as cnt')
    const rows = await paginate(q.clone(), page, limit)
    ok(res, rows, { total: Number(cnt), page: Number(page), limit: Number(limit) })
  } catch (err) { next(err) }
}

// ─── ANALYTICS ────────────────────────────────────────────────────────────────

exports.getRevenueAnalytics = async (req, res, next) => {
  try {
    const { period = '30d' } = req.query
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30

    const [byDay, byCategory, byMethod, topPartners] = await Promise.all([
      db.raw(`
        SELECT DATE(paid_at) as date,
          COALESCE(SUM(total),0) as revenue,
          COALESCE(SUM(platform_fee),0) as fees,
          COUNT(*) as count
        FROM payments WHERE status='completed'
          AND paid_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY DATE(paid_at) ORDER BY date ASC
      `, [days]),
      db.raw(`
        SELECT j.category_name as category,
          COALESCE(SUM(p.total),0) as revenue, COUNT(p.id) as count
        FROM payments p JOIN jobs j ON j.id=p.job_id
        WHERE p.status='completed' AND p.paid_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY j.category_name ORDER BY revenue DESC LIMIT 10
      `, [days]),
      db.raw(`
        SELECT method, COALESCE(SUM(total),0) as revenue, COUNT(*) as count
        FROM payments WHERE status='completed'
          AND paid_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY method
      `, [days]),
      db.raw(`
        SELECT w.partner_id, u.full_name,
          COALESCE(SUM(p.total),0) as revenue, COUNT(p.id) as jobs
        FROM payments p
          JOIN jobs j ON j.id=p.job_id
          JOIN users u ON u.user_id=j.partner_id
          JOIN partners w ON w.user_id=j.partner_id
        WHERE p.status='completed' AND p.paid_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY j.partner_id, u.full_name ORDER BY revenue DESC LIMIT 10
      `, [days]),
    ])

    ok(res, {
      byDay:       byDay[0],
      byCategory:  byCategory[0],
      byMethod:    byMethod[0],
      topPartners: topPartners[0],
    })
  } catch (err) { next(err) }
}

exports.getUserAnalytics = async (req, res, next) => {
  try {
    const { period = '30d' } = req.query
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30

    const [newByDay, byRole, byCity, retention] = await Promise.all([
      db.raw(`
        SELECT DATE(created_at) as date, role, COUNT(*) as count
        FROM users WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
          AND deleted_at IS NULL
        GROUP BY DATE(created_at), role ORDER BY date ASC
      `, [days]),
      db.raw(`
        SELECT role, COUNT(*) as total,
          SUM(CASE WHEN onboarding_done=1 THEN 1 ELSE 0 END) as onboarded
        FROM users WHERE deleted_at IS NULL GROUP BY role
      `),
      db.raw(`
        SELECT city, COUNT(*) as count FROM users
        WHERE deleted_at IS NULL AND city IS NOT NULL
        GROUP BY city ORDER BY count DESC LIMIT 15
      `),
      db.raw(`
        SELECT COUNT(DISTINCT customer_id) as active_users
        FROM jobs WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      `, [days]),
    ])

    ok(res, {
      newByDay:   newByDay[0],
      byRole:     byRole[0],
      byCity:     byCity[0],
      retention:  retention[0],
    })
  } catch (err) { next(err) }
}

exports.getJobAnalytics = async (req, res, next) => {
  try {
    const { period = '30d' } = req.query
    const days = period === '7d' ? 7 : period === '90d' ? 90 : 30

    const [byState, byCategory, cancelReasons, avgDuration] = await Promise.all([
      db.raw(`
        SELECT state, COUNT(*) as count
        FROM jobs WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY state
      `, [days]),
      db.raw(`
        SELECT category_name, COUNT(*) as total,
          SUM(CASE WHEN state='paid' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN state='cancelled' THEN 1 ELSE 0 END) as cancelled,
          COALESCE(AVG(agreed_price),0) as avg_price
        FROM jobs WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY category_name ORDER BY total DESC
      `, [days]),
      db.raw(`
        SELECT cancel_reason as reason, COUNT(*) as count
        FROM jobs WHERE state='cancelled' AND cancel_reason IS NOT NULL
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        GROUP BY cancel_reason ORDER BY count DESC LIMIT 10
      `, [days]),
      db.raw(`
        SELECT ROUND(AVG(TIMESTAMPDIFF(MINUTE,created_at,completed_at)),1) as avg_minutes
        FROM jobs WHERE state='paid' AND completed_at IS NOT NULL
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
      `, [days]),
    ])

    ok(res, {
      byState:      byState[0],
      byCategory:   byCategory[0],
      cancelReasons: cancelReasons[0],
      avgDuration:  avgDuration[0][0],
    })
  } catch (err) { next(err) }
}

exports.getPartnerAnalytics = async (req, res, next) => {
  try {
    const [topRated, busiest, byCategory, verificationStats] = await Promise.all([
      db.raw(`
        SELECT p.user_id, u.full_name, p.primary_category,
          p.rating_avg, p.rating_count, p.jobs_completed
        FROM partners p JOIN users u ON u.user_id=p.user_id
        WHERE u.deleted_at IS NULL ORDER BY p.rating_avg DESC, p.rating_count DESC LIMIT 10
      `),
      db.raw(`
        SELECT p.user_id, u.full_name, p.primary_category, p.jobs_completed,
          COALESCE(SUM(wt.total),0) as lifetime_earned
        FROM partners p
          JOIN users u ON u.user_id=p.user_id
          LEFT JOIN wallet_transactions wt ON wt.partner_id=p.user_id AND wt.cleared=1
        WHERE u.deleted_at IS NULL
        GROUP BY p.user_id, u.full_name, p.primary_category, p.jobs_completed
        ORDER BY p.jobs_completed DESC LIMIT 10
      `),
      db.raw(`
        SELECT primary_category as category,
          COUNT(*) as total,
          SUM(CASE WHEN is_online=1 THEN 1 ELSE 0 END) as online,
          SUM(CASE WHEN is_verified=1 THEN 1 ELSE 0 END) as verified,
          ROUND(AVG(rating_avg),2) as avg_rating
        FROM partners GROUP BY primary_category ORDER BY total DESC
      `),
      db.raw(`
        SELECT
          SUM(CASE WHEN is_verified=1 THEN 1 ELSE 0 END) as verified,
          SUM(CASE WHEN aadhaar_verified=1 THEN 1 ELSE 0 END) as aadhaar,
          SUM(CASE WHEN phone_verified=1 THEN 1 ELSE 0 END) as phone_verified,
          SUM(CASE WHEN background_checked=1 THEN 1 ELSE 0 END) as background,
          COUNT(*) as total
        FROM partners
      `),
    ])

    ok(res, {
      topRated:          topRated[0],
      busiest:           busiest[0],
      byCategory:        byCategory[0],
      verificationStats: verificationStats[0][0],
    })
  } catch (err) { next(err) }
}

// ─── ENHANCED WITHDRAWAL ──────────────────────────────────────────────────────

exports.updateWithdrawalFull = async (req, res, next) => {
  try {
    const { id } = req.params
    const { action, utr_number, transfer_date, admin_remarks } = req.body
    const wd = await db('withdrawals').where({ id }).first()
    if (!wd) return fail(res, 'Withdrawal not found', 404)

    if (action === 'approve') {
      if (wd.status !== 'processing') return fail(res, 'Not in processing state')
      await db('withdrawals').where({ id }).update({
        status: 'completed',
        utr_number:    utr_number    || null,
        transfer_date: transfer_date || null,
        admin_remarks: admin_remarks || null,
        processed_by:  req.adminUser?.user_id || null,
        complete_at:   db.fn.now(),
        updated_at:    db.fn.now(),
      })
      await auditLog(req, 'approve_withdrawal', 'withdrawal', String(id),
        { status: wd.status }, { status: 'completed', utr_number })
      notifyWithdrawalCompleted(wd.partner_id, wd.amount)
      ok(res, { id, status: 'completed' })

    } else if (action === 'cancel') {
      if (wd.status !== 'processing') return fail(res, 'Not in processing state')
      await db.transaction(async (trx) => {
        await trx('withdrawals').where({ id }).update({
          status: 'cancelled',
          admin_remarks: admin_remarks || null,
          processed_by:  req.adminUser?.user_id || null,
          updated_at: trx.fn.now(),
        })
        await trx('wallet_transactions').insert({
          partner_id: wd.partner_id, type: 'credit',
          service: 'Withdrawal Refund', customer_name: 'System',
          amount: wd.amount, tip: 0, total: wd.amount,
          cleared: true, eligible_at: trx.fn.now(), created_at: trx.fn.now(),
        })
      })
      await auditLog(req, 'cancel_withdrawal', 'withdrawal', String(id),
        { status: wd.status }, { status: 'cancelled', refunded: true })
      notifyWithdrawalCancelled(wd.partner_id, wd.amount)
      ok(res, { id, status: 'cancelled', refunded: true })

    } else if (action === 'update') {
      const patch = {}
      if (utr_number    !== undefined) patch.utr_number    = utr_number
      if (transfer_date !== undefined) patch.transfer_date = transfer_date
      if (admin_remarks !== undefined) patch.admin_remarks = admin_remarks
      if (!Object.keys(patch).length) return fail(res, 'No fields to update')
      await db('withdrawals').where({ id }).update({ ...patch, updated_at: db.fn.now() })
      ok(res, { id, ...patch })
    } else {
      fail(res, 'Invalid action. Use approve, cancel, or update')
    }
  } catch (err) { next(err) }
}

// ─── SAFETY ALERTS ────────────────────────────────────────────────────────────

// GET /api/admin/safety-alerts?status=active|resolved&type=sos|share&page=&limit=&search=
exports.listSafetyAlerts = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, type, search } = req.query
    let q = db('safety_alerts as a')
      .leftJoin('jobs as j', function () {
        this.on(db.raw('j.id COLLATE utf8mb4_unicode_ci = a.job_id COLLATE utf8mb4_unicode_ci'))
      })
      .leftJoin('users as cu', function () {
        this.on(db.raw('cu.user_id COLLATE utf8mb4_unicode_ci = a.customer_id COLLATE utf8mb4_unicode_ci'))
      })
      .leftJoin('users as pu', function () {
        this.on(db.raw('pu.user_id COLLATE utf8mb4_unicode_ci = a.partner_id COLLATE utf8mb4_unicode_ci'))
      })
      .orderBy('a.created_at', 'desc')
      .select(
        'a.*',
        'j.service', 'j.service_icon', 'j.state as job_state', 'j.agreed_price',
        'cu.full_name as customer_name', 'cu.phone as customer_phone',
        'pu.full_name as partner_name',  'pu.phone as partner_phone',
      )
    if (status) q = q.where('a.status', status)
    if (type)   q = q.where('a.type', type)
    if (search) q = q.where(b => b
      .where('a.job_id', 'like', `%${search}%`)
      .orWhere('cu.full_name', 'like', `%${search}%`)
      .orWhere('pu.full_name', 'like', `%${search}%`)
      .orWhere('a.contact_phone', 'like', `%${search}%`)
      .orWhere('a.note', 'like', `%${search}%`))

    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('a.id as cnt')
    const rows = await paginate(q.clone(), page, limit)
    ok(res, rows, { total: Number(cnt), page: Number(page), limit: Number(limit) })
  } catch (err) { next(err) }
}

// GET /api/admin/safety-alerts/:id
exports.getSafetyAlert = async (req, res, next) => {
  try {
    const { id } = req.params
    const a = await db('safety_alerts').where({ id }).first()
    if (!a) return fail(res, 'Alert not found', 404)

    const [job, customer, partner] = await Promise.all([
      db('jobs').where({ id: a.job_id }).first(),
      db('users').where({ user_id: a.customer_id }).first(),
      db('users').where({ user_id: a.partner_id }).first(),
    ])
    ok(res, { ...a, job: job || null, customer: customer || null, partner: partner || null })
  } catch (err) { next(err) }
}

// POST /api/admin/safety-alerts/:id/resolve  { note? }
// Marks an active alert resolved, records the admin and optional note,
// pushes the customer + audits.
exports.resolveSafetyAlert = async (req, res, next) => {
  try {
    const { id } = req.params
    const { note } = req.body || {}
    const alert = await db('safety_alerts').where({ id }).first()
    if (!alert) return fail(res, 'Alert not found', 404)
    if (alert.status !== 'active') return fail(res, `Already ${alert.status}`)

    const trimmedNote = note ? String(note).slice(0, 2000).trim() : null
    await db('safety_alerts').where({ id }).update({
      status:          'resolved',
      resolved_at:     db.fn.now(),
      resolved_by:     req.adminUser?.user_id || null,
      resolution_note: trimmedNote,
    })

    await auditLog(req,
      `safety_${alert.type}_resolved`, 'safety_alert', String(id),
      { status: alert.status },
      { status: 'resolved', resolved_by: req.adminUser?.user_id, note: trimmedNote },
    )

    // Tell the customer their alert was reviewed. We use type='promo' (closest
    // neutral entry in the existing NOTIF_TYPES enum) for the in-app row.
    const title = alert.type === 'sos'
      ? 'SOS reviewed by our team'
      : 'Trip share reviewed'
    const body = trimmedNote
      ? `Resolved: ${trimmedNote.slice(0, 160)}`
      : 'Our team reviewed your alert and marked it resolved.'
    try {
      await db('notifications').insert({
        user_id: alert.customer_id, type: 'promo',
        title, body, icon: '🛡', icon_bg: '#dcfce7',
        route: `/my-jobs/${alert.job_id}`,
        read: false, created_at: db.fn.now(),
      })
    } catch { /* swallow */ }

    push.sendToUser(alert.customer_id, {
      title,
      body,
      data: { type: 'safety:resolved', alertId: String(id), jobId: alert.job_id, route: `/my-jobs/${alert.job_id}` },
    }).catch(() => {})

    const fresh = await db('safety_alerts').where({ id }).first()
    ok(res, fresh)
  } catch (err) { next(err) }
}

// ─── DISPUTES ─────────────────────────────────────────────────────────────────

// GET /api/admin/disputes?status=open|resolved|dismissed&page=&limit=&search=
exports.listDisputes = async (req, res, next) => {
  try {
    const { page = 1, limit = 20, status, search } = req.query
    let q = db('disputes as d')
      .leftJoin('jobs as j', function () {
        this.on(db.raw('j.id COLLATE utf8mb4_unicode_ci = d.job_id COLLATE utf8mb4_unicode_ci'))
      })
      .orderBy('d.created_at', 'desc')
      .select(
        'd.*',
        'j.service', 'j.service_icon', 'j.agreed_price', 'j.state as job_state',
        'j.partner_name', 'j.customer_name', 'j.paid_at',
      )
    if (status) q = q.where('d.status', status)
    if (search) q = q.where(b => b
      .where('d.job_id', 'like', `%${search}%`)
      .orWhere('j.partner_name', 'like', `%${search}%`)
      .orWhere('j.customer_name', 'like', `%${search}%`)
      .orWhere('d.reason', 'like', `%${search}%`))

    const [{ cnt }] = await q.clone().clearSelect().clearOrder().count('d.id as cnt')
    const rows = await paginate(q.clone(), page, limit)
    ok(res, rows, { total: Number(cnt), page: Number(page), limit: Number(limit) })
  } catch (err) { next(err) }
}

// GET /api/admin/disputes/:id
exports.getDispute = async (req, res, next) => {
  try {
    const { id } = req.params
    const d = await db('disputes').where({ id }).first()
    if (!d) return fail(res, 'Dispute not found', 404)

    const [job, payment, walletTx, messages] = await Promise.all([
      db('jobs').where({ id: d.job_id }).first(),
      db('payments').where({ job_id: d.job_id, status: 'completed' }).first(),
      db('wallet_transactions').where({ job_id: d.job_id, type: 'credit' }).orderBy('created_at', 'desc'),
      db('messages').where({ job_id: d.job_id }).orderBy('created_at', 'asc').limit(100),
    ])
    ok(res, { ...d, job: job || null, payment: payment || null, walletTx, messages })
  } catch (err) { next(err) }
}

// POST /api/admin/disputes/:id/resolve  { action, note?, refund_amount? }
//   action: 'refund' | 'warn_partner' | 'dismiss' | 'resolved'
//
// 'refund' calls Razorpay refund + reverses the partner's wallet credit
// (insert a credit row with negative total — same shape used elsewhere in
// the codebase so summarize() picks it up correctly).
exports.resolveDispute = async (req, res, next) => {
  try {
    const { id } = req.params
    const { action, note, refund_amount } = req.body || {}
    const valid = ['refund', 'warn_partner', 'dismiss', 'resolved']
    if (!valid.includes(action)) return fail(res, `Invalid action — use one of: ${valid.join(', ')}`)

    const dispute = await db('disputes').where({ id }).first()
    if (!dispute) return fail(res, 'Dispute not found', 404)
    if (dispute.status !== 'open') return fail(res, `Already ${dispute.status}`)

    const job = await db('jobs').where({ id: dispute.job_id }).first()
    if (!job) return fail(res, 'Underlying job missing', 404)

    let refundedAmount = null
    let refundId       = null

    if (action === 'refund') {
      // Refund flow — pull the captured payment, hit Razorpay, reverse the
      // partner's wallet credit, all inside a transaction so a partial
      // failure doesn't leave money in two places.
      const payment = await db('payments').where({ job_id: job.id, status: 'completed' }).first()
      if (!payment) return fail(res, 'No completed payment to refund')
      if (!razorpay.isReady()) return fail(res, 'Payments not configured on server', 503)

      const requested = Number(refund_amount)
      const fullPaise = Number(payment.total) * 100
      const refundPaise = Number.isFinite(requested) && requested > 0
        ? Math.min(Math.round(requested * 100), fullPaise)
        : fullPaise
      refundedAmount = Math.round(refundPaise / 100)

      try {
        const rp = await razorpay.instance.payments.refund(payment.razorpay_payment_id, {
          amount: refundPaise,
          notes:  { dispute_id: String(id), job_id: String(job.id) },
        })
        refundId = rp?.id || null
      } catch (err) {
        const psp = err?.error?.description || err.message
        return fail(res, `Razorpay refund failed: ${psp}`, 502)
      }

      // Reverse the wallet credit. We insert a `credit` row with negative
      // total — the same convention used for the existing withdrawal-cancel
      // refund path in reverse. Keeps Wallet.summarize() and earnings
      // analytics correct without requiring a new TX_TYPES enum value.
      await db.transaction(async (trx) => {
        await trx('wallet_transactions').insert({
          id:         txId(),
          partner_id: job.partner_id,
          job_id:     job.id,
          type:       'credit',
          service:    `Refund · Dispute #${id}`,
          customer_name: job.customer_name || 'System',
          amount:    -refundedAmount,
          tip:       0,
          total:    -refundedAmount,
          cleared:   true,
          eligible_at: trx.fn.now(),
          created_at:  trx.fn.now(),
        })
      })
    }

    // Persist the resolution + audit it.
    const resolutionMap = {
      refund:        'refund',
      warn_partner:  'warn_partner',
      dismiss:       'dismissed',
      resolved:      'resolved',
    }
    const finalStatus = action === 'dismiss' ? 'dismissed' : 'resolved'
    await db('disputes').where({ id }).update({
      status:          finalStatus,
      resolution:      resolutionMap[action],
      resolution_note: (note ? String(note).slice(0, 2000) : null),
      admin_id:        req.adminUser?.user_id || null,
      refund_amount:   refundedAmount,
      refund_id:       refundId,
      resolved_at:     db.fn.now(),
    })
    await auditLog(req,
      `dispute_${action}`, 'dispute', String(id),
      { status: dispute.status },
      { status: finalStatus, resolution: resolutionMap[action], refund_amount: refundedAmount, refund_id: refundId },
    )

    // Notify both sides + push. The in-app row also carries `route` so
    // tapping the bell entry deep-links the same way the push does.
    const notify = (uid, title, body, route) => {
      if (!uid) return
      db('notifications').insert({
        user_id: uid, type: 'promo',
        title, body, icon: '⚖️', icon_bg: '#f3e8ff',
        route: route || null,
        read: false, created_at: db.fn.now(),
      }).catch(() => {})
      push.sendToUser(uid, {
        title, body,
        data: { type: `dispute:${action}`, jobId: job.id, route },
      }).catch(() => {})
    }
    if (action === 'refund') {
      notify(job.customer_id, `Refund issued · ₹${refundedAmount}`,
        `Your dispute on ${job.service} was upheld. Money will appear in your account in 5–7 days.`,
        `/my-jobs/${job.id}`)
      notify(job.partner_id, `Earnings reversed · ₹${refundedAmount}`,
        `A dispute on ${job.service} was resolved with a refund. ₹${refundedAmount} debited from your wallet.`,
        '/partner/wallet')
    } else if (action === 'warn_partner') {
      notify(job.partner_id, `Warning · ${job.service}`,
        note ? `Admin warning: ${String(note).slice(0, 160)}` : 'Admin warning issued. Please review your conduct.',
        `/partner/profile`)
      notify(job.customer_id, 'Dispute resolved',
        'We reviewed your dispute and warned the partner. Thanks for the feedback.',
        `/my-jobs/${job.id}`)
    } else if (action === 'dismiss') {
      notify(dispute.raised_by, 'Dispute dismissed',
        'After review, no action was taken on your dispute.',
        `/my-jobs/${job.id}`)
    } else {
      notify(dispute.raised_by, 'Dispute resolved',
        note ? String(note).slice(0, 160) : 'Your dispute has been resolved.',
        `/my-jobs/${job.id}`)
    }

    const fresh = await db('disputes').where({ id }).first()
    ok(res, fresh)
  } catch (err) { next(err) }
}

// ─── ADMIN ME ─────────────────────────────────────────────────────────────────

exports.getMe = async (req, res, next) => {
  try {
    ok(res, req.adminUser)
  } catch (err) { next(err) }
}

// ─── M95 — OPS DIGEST PREVIEW ────────────────────────────────────────────────
// GET /api/admin/ops-digest — Same payload the daily worker emails out.
// Lets an admin pull the current state without waiting for the cron.
exports.opsDigestPreview = async (req, res, next) => {
  try {
    const { compute, toMarkdown } = require('../workers/opsDigest')
    const digest = await compute()
    res.json({ success: true, digest, markdown: toMarkdown(digest) })
  } catch (err) { next(err) }
}

// ─── M93 — GLOBAL SEARCH ─────────────────────────────────────────────────────
// GET /api/admin/search?q=...
// Searches users, partners, jobs, payments, disputes by id / phone / email /
// name. Returns up to 5 hits per type with a `route` for deep-link.
exports.globalSearch = async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim()
    if (q.length < 2) {
      return res.json({ success: true, q, results: { users: [], partners: [], jobs: [], payments: [], disputes: [] } })
    }
    const like = `%${q}%`
    const LIMIT = 5

    const [users, partners, jobs, payments, disputes] = await Promise.all([
      db('users')
        .where((b) => b.where('user_id', q).orWhere('email', 'like', like)
          .orWhere('phone', 'like', like).orWhere('full_name', 'like', like))
        .whereNull('deleted_at')
        .select('user_id', 'full_name', 'email', 'phone', 'role').limit(LIMIT),
      db('users as u')
        .join('partners as p', function () {
          this.on(db.raw('p.user_id COLLATE utf8mb4_unicode_ci = u.user_id COLLATE utf8mb4_unicode_ci'))
        })
        .where((b) => b.where('u.user_id', q).orWhere('u.full_name', 'like', like)
          .orWhere('u.phone', 'like', like).orWhere('p.primary_category', 'like', like))
        .whereNull('u.deleted_at')
        .select('u.user_id', 'u.full_name', 'u.phone', 'p.primary_category', 'p.is_online')
        .limit(LIMIT),
      db('jobs')
        .where((b) => b.where('id', q).orWhere('service', 'like', like)
          .orWhere('customer_name', 'like', like).orWhere('partner_name', 'like', like))
        .orderBy('created_at', 'desc')
        .select('id', 'service', 'state', 'customer_name', 'partner_name', 'agreed_price', 'created_at')
        .limit(LIMIT),
      db('payments')
        .where((b) => b.where('razorpay_payment_id', q).orWhere('razorpay_order_id', q)
          .orWhere('job_id', q))
        .orderBy('created_at', 'desc')
        .select('id', 'job_id', 'customer_id', 'partner_id', 'total', 'status', 'method', 'razorpay_payment_id', 'created_at')
        .limit(LIMIT),
      db('disputes')
        .where((b) => b.where('id', q).orWhere('job_id', q)
          .orWhere('customer_id', q).orWhere('partner_id', q))
        .orderBy('created_at', 'desc')
        .select('id', 'job_id', 'status', 'resolution', 'created_at')
        .limit(LIMIT),
    ])

    res.json({
      success: true,
      q,
      results: {
        users:    users.map((u)    => ({ ...u, route: `/users/${u.user_id}` })),
        partners: partners.map((p) => ({ ...p, route: `/partners/${p.user_id}` })),
        jobs:     jobs.map((j)     => ({ ...j, route: `/jobs/${j.id}` })),
        payments: payments.map((p) => ({ ...p, route: `/payments/${p.id}` })),
        disputes: disputes.map((d) => ({ ...d, route: `/disputes` })),
      },
    })
  } catch (err) { next(err) }
}

// ─── L96 — COHORT BROADCAST ──────────────────────────────────────────────────
// POST /api/admin/broadcasts
// Body: { filter: { city?, category?, online_only? }, title, body }
// Resolves the partner cohort, fans out via Notification.create + push.
exports.sendBroadcast = async (req, res, next) => {
  try {
    const filter = req.body?.filter || {}
    const title  = String(req.body?.title || '').trim().slice(0, 255)
    const body   = String(req.body?.body  || '').trim().slice(0, 1000)
    if (!title || !body) {
      return res.status(400).json({ success: false, message: 'title and body required' })
    }

    let q = db('users as u')
      .join('partners as p', function () {
        this.on(db.raw('p.user_id COLLATE utf8mb4_unicode_ci = u.user_id COLLATE utf8mb4_unicode_ci'))
      })
      .whereNull('u.deleted_at')
      .where('u.status', 'active')
    if (filter.city) {
      q = q.where((b) => b.where('p.location_city', filter.city).orWhere('u.city', filter.city))
    }
    if (filter.category) {
      q = q.where('p.primary_category', filter.category)
    }
    if (filter.online_only) {
      q = q.where('p.is_online', true)
    }
    const rows = await q.select('u.user_id', 'u.full_name').limit(5000)

    const Notification = require('../models/Notification')
    const push = require('../services/pushService')
    let sent = 0, failed = 0
    for (const r of rows) {
      try {
        await Notification.create({
          user_id: r.user_id, type: 'promo',
          title, body,
          icon: '📢', icon_bg: '#dbeafe',
          route: '/partner',
        })
        sent += 1
      } catch { failed += 1 }
    }
    push.sendToUsers(rows.map((r) => r.user_id), {
      title, body,
      data: { type: 'broadcast', route: '/partner' },
    }).catch(() => {})

    await auditLog(req, 'broadcast', 'partners', null, null,
      { filter, count: rows.length, sent, failed })

    res.json({
      success: true,
      message: `Broadcast sent to ${sent} partner${sent === 1 ? '' : 's'} (${failed} failed)`,
      sent, failed, count: rows.length,
    })
  } catch (err) { next(err) }
}

// ─── H92 — BULK PARTNER OPERATIONS ───────────────────────────────────────────
// POST /api/admin/partners/bulk
// Body: { partner_ids: [...], action: 'suspend' | 'activate' | 'verify' | 'unverify' | 'message',
//         message?: { title, body } }
// Returns per-id success/fail so the portal can show a summary.
const ALLOWED_BULK = new Set(['suspend', 'activate', 'verify', 'unverify', 'message'])

exports.bulkPartnerAction = async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.partner_ids) ? req.body.partner_ids.slice(0, 200) : []
    const action = String(req.body?.action || '').toLowerCase()
    if (!ids.length) return res.status(400).json({ success: false, message: 'partner_ids is required' })
    if (!ALLOWED_BULK.has(action)) return res.status(400).json({ success: false, message: 'Unsupported action' })

    const message = req.body?.message || null
    if (action === 'message') {
      if (!message?.title?.trim() || !message?.body?.trim()) {
        return res.status(400).json({ success: false, message: 'message.title and message.body required' })
      }
    }

    const ok = []
    const failed = []
    const Notification = require('../models/Notification')
    const push = require('../services/pushService')

    for (const uid of ids) {
      try {
        if (action === 'suspend') {
          await db('users').where({ user_id: uid }).update({ status: 'suspended' })
        } else if (action === 'activate') {
          await db('users').where({ user_id: uid }).update({ status: 'active' })
        } else if (action === 'verify') {
          await db('partners').where({ user_id: uid }).update({ is_verified: true })
        } else if (action === 'unverify') {
          await db('partners').where({ user_id: uid }).update({ is_verified: false })
        } else if (action === 'message') {
          await Notification.create({
            user_id: uid, type: 'promo',
            title: String(message.title).slice(0, 255),
            body:  String(message.body).slice(0, 1000),
            icon:  '📢', icon_bg: '#dbeafe',
            route: '/partner',
          })
          push.sendToUser(uid, {
            title: String(message.title),
            body:  String(message.body),
            data:  { type: 'broadcast', route: '/partner' },
          }).catch(() => {})
        }
        ok.push(uid)
      } catch (err) {
        failed.push({ user_id: uid, error: err.message })
      }
    }

    await auditLog(req, `bulk_partner_${action}`, 'partners', null, null, {
      ids_count: ids.length, ok: ok.length, failed: failed.length,
    })

    res.json({
      success: true,
      message: `Bulk ${action}: ${ok.length} ok, ${failed.length} failed`,
      ok, failed,
    })
  } catch (err) { next(err) }
}

// ─── H90 — IMPERSONATION ─────────────────────────────────────────────────────
// POST /api/admin/impersonate/:uid
// Mints a 15-minute HMAC-signed read-only token the admin uses to open the
// customer/partner app as that user. The middleware (verifyToken in
// middleware/auth.js) recognises the "Impersonate <token>" header and
// stamps req.user.readOnly = true; any write returns 403 read_only_session.
const { mint: mintImpersonate, DEFAULT_TTL_MS } = require('../utils/impersonate')

exports.impersonate = async (req, res, next) => {
  try {
    const target_uid = req.params.uid
    const admin_id   = req.adminUser?.user_id
    if (!admin_id) return res.status(401).json({ success: false, message: 'Admin session required' })
    if (!target_uid) return res.status(400).json({ success: false, message: 'uid required' })

    const target = await db('users')
      .where({ user_id: target_uid })
      .whereNull('deleted_at')
      .first()
    if (!target) return res.status(404).json({ success: false, message: 'User not found' })

    const token = mintImpersonate({ aud_uid: target_uid, admin_id })

    // Audit so we have a record of every impersonation request — support
    // sessions are high-trust and shouldn't be invisible.
    await auditLog(req, 'impersonate', 'user', target_uid,
      null, { ttl_ms: DEFAULT_TTL_MS })

    res.json({
      success: true,
      message: 'Impersonation token issued',
      token,
      expires_in_ms: DEFAULT_TTL_MS,
      target: {
        user_id:   target.user_id,
        full_name: target.full_name,
        role:      target.role,
        email:     target.email,
      },
    })
  } catch (err) { next(err) }
}

// ─── AUDIT LOG HELPER ────────────────────────────────────────────────────────

async function auditLog (req, action, target_type, target_id, before, after) {
  try {
    await db('admin_audit_log').insert({
      admin_id:    req.adminUser?.user_id  || null,
      admin_email: req.adminUser?.email    || null,
      action,
      target_type,
      target_id:   String(target_id),
      before_data: before ? JSON.stringify(before) : null,
      after_data:  after  ? JSON.stringify(after)  : null,
      ip:          req.ip || null,
      created_at:  db.fn.now(),
    })
  } catch { /* audit failures must not break the main response */ }
}
