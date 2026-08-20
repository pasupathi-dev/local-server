const { db } = require('../config/db')
const { ACTIVITY_LOG_CAP } = require('../config/constants')
const { getConfigNumber } = require('../utils/appConfig')
const TABLE = 'activity_log'

const ActivityLog = {
  // Bug #35: wrapped in try-catch so an ActivityLog failure (e.g. unknown
  // ACT_TYPE enum value or DB hiccup) never crashes the calling controller.
  add: async (payload) => {
    try {
      const [id] = await db(TABLE).insert(payload)
      // Cap is admin-tunable (activity_log_cap). Falls back to constants.js
      // value if DB row missing.
      const cap = await getConfigNumber('activity_log_cap', ACTIVITY_LOG_CAP)
      const excess = await db(TABLE)
        .where({ partner_id: payload.partner_id })
        .orderBy('created_at', 'desc')
        .offset(cap)
        .select('id')
      if (excess.length) {
        await db(TABLE).whereIn('id', excess.map((e) => e.id)).del()
      }
      return db(TABLE).where({ id }).first()
    } catch (err) {
      console.error('[ActivityLog] add failed (non-fatal):', err.message)
      return null
    }
  },

  list: (partner_id, { type, from, to, q, limit = 500 } = {}) => {
    const query = db(TABLE).where({ partner_id }).orderBy('created_at', 'desc').limit(limit)
    if (type && type !== 'all') query.where({ type })
    if (from) query.where('created_at', '>=', from)
    if (to)   query.where('created_at', '<=', to)
    if (q)    query.where(function () { this.where('title','like',`%${q}%`).orWhere('sub','like',`%${q}%`) })
    return query
  },
}

module.exports = ActivityLog
