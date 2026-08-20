const { db } = require('../config/db')
const TABLE  = 'jobs'

const Job = {
  // L22 — Per-category job count over the last 7 days, optionally scoped
  // to the user's city. We count every job that wasn't cancelled (paid +
  // in-progress + scheduled all qualify as "demand") so the social proof
  // still works during off-peak hours when fewer jobs have actually been
  // paid. City scoping uses the customer's address snapshot on the job
  // (`customer_address` is a free-text snapshot captured at request time),
  // falling back to a global count when no city is provided.
  weeklyCountsByCategory: async ({ city = null } = {}) => {
    const q = db(TABLE)
      .whereNot('state', 'cancelled')
      .andWhereRaw('created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)')
      .select('category_name')
      .count({ n: '*' })
      .groupBy('category_name')

    if (city) {
      // Match on the city substring within the customer_address snapshot.
      // Cheap, indexless, but on a 7-day window the row count is small
      // enough that a LIKE doesn't matter — and it avoids a join.
      q.andWhere('customer_address', 'like', `%${city}%`)
    }

    const rows = await q
    const out = {}
    for (const r of rows) out[r.category_name] = Number(r.n || 0)
    return out
  },

  // Same as weeklyCountsByCategory but grouped by the WORK leaf — drives the
  // "booked N times this week" badge on the per-work grid.
  weeklyCountsByWork: async ({ city = null } = {}) => {
    const q = db(TABLE)
      .whereNot('state', 'cancelled')
      .andWhereRaw('created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)')
      .whereNotNull('work_name')
      .select('work_name')
      .count({ n: '*' })
      .groupBy('work_name')
    if (city) q.andWhere('customer_address', 'like', `%${city}%`)
    const rows = await q
    const out = {}
    for (const r of rows) out[r.work_name] = Number(r.n || 0)
    return out
  },

  create: async (payload) => {
    await db(TABLE).insert(payload)
    return Job.findById(payload.id)
  },

  findById: (id) => db(TABLE).where({ id }).first(),

  // Partner-side "current job" — what to show on /partner/work. Includes
  // 'completed' so the partner doesn't lose context on refresh while
  // waiting for the customer to pay.
  findActiveForPartner: (partner_id) => db(TABLE)
    .where({ partner_id })
    .whereNotIn('state', ['paid', 'cancelled'])
    .orderBy('accepted_at', 'desc')
    .first(),

  // Partner-side "is the partner blocked from accepting a new job?". Used
  // by the request-accept handler's single-active-job guard. 'completed'
  // does NOT block — once work is done the partner is free to take a new
  // request even while waiting for payment on the previous one.
  findBlockingForPartner: (partner_id) => db(TABLE)
    .where({ partner_id })
    .whereNotIn('state', ['paid', 'cancelled', 'completed'])
    .orderBy('accepted_at', 'desc')
    .first(),

  // Customer-side "active" — keeps 'completed' visible because the
  // customer still has a "pay now" action to take on it.
  findActiveForCustomer: (customer_id) => db(TABLE)
    .where({ customer_id })
    .whereNotIn('state', ['paid', 'cancelled'])
    .orderBy('accepted_at', 'desc')
    .first(),

  listForCustomer: (customer_id) => db(TABLE).where({ customer_id }).orderBy('created_at', 'desc'),
  listForPartner:  (partner_id)  => db(TABLE).where({ partner_id }).orderBy('created_at', 'desc'),

  // Paginated + filtered variant used by /api/jobs/mine.
  // Filters:
  //   role:   'partner' | 'customer' — which side the caller is on
  //   status: single state | 'active' | 'history'
  //   q:      free-text search on service / category / partner / customer name
  //   from:   ISO date/timestamp — created_at >= from
  //   to:     ISO date/timestamp — created_at <= to
  //   limit / offset
  //
  // Returns { rows, total } so clients can show a "showing N of M" count
  // that's authoritative under the current filter.
  listPaged: async ({ uid, role, status, q, from, to, limit = 10, offset = 0 } = {}) => {
    const ownCol = role === 'partner' ? 'partner_id' : 'customer_id'
    const HISTORY = ['paid', 'cancelled']
    const applyFilters = (qb) => {
      qb.where({ [ownCol]: uid })
      if (status === 'active')  qb.whereNotIn('state', HISTORY)
      else if (status === 'history') qb.whereIn('state', HISTORY)
      else if (status && status !== 'all') qb.where('state', status)
      if (q) {
        const like = `%${String(q).trim()}%`
        qb.where(function () {
          this.where('service', 'like', like)
              .orWhere('category_name', 'like', like)
              .orWhere('work_name', 'like', like)
              .orWhere('partner_name', 'like', like)
              .orWhere('customer_name', 'like', like)
        })
      }
      if (from) qb.where('created_at', '>=', new Date(from))
      if (to)   qb.where('created_at', '<=', new Date(to))
      return qb
    }

    const totalRow = await applyFilters(db(TABLE).count({ n: '*' })).first()
    const total = Number(totalRow?.n || 0)

    const safeLimit  = Math.max(1, Math.min(50, Number(limit) || 10))
    const safeOffset = Math.max(0, Number(offset) || 0)
    const rows = await applyFilters(db(TABLE)).orderBy('created_at', 'desc').limit(safeLimit).offset(safeOffset)
    return { rows, total, limit: safeLimit, offset: safeOffset }
  },

  setState: (id, state, extra = {}) => db(TABLE).where({ id }).update({ state, ...extra }),

  setAgreedPrice: (id, agreed_price) => db(TABLE).where({ id }).update({ agreed_price }),

  cancel: (id, { cancel_reason, cancel_note, cancelled_by }) => db(TABLE).where({ id }).update({
    state: 'cancelled',
    cancel_reason,
    cancel_note,
    cancelled_by,
  }),
}

module.exports = Job
