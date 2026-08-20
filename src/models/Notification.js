const { db } = require('../config/db')
const { categoryForType, typesInCategory, CATEGORIES } = require('../utils/notificationCategory')
const TABLE  = 'notifications'

// Decorate every row with a derived `category` so the client can render
// chips / icons without re-doing the mapping. Cheap: it's a switch on
// the type column.
const decorate = (row) => row && { ...row, category: categoryForType(row.type) }
const decorateAll = (rows) => rows.map(decorate)

// Apply category + mute_promos filtering to a knex query builder.
const applyFilters = (qb, { category, mute_promos = false } = {}) => {
  if (CATEGORIES.includes(category)) {
    qb.whereIn('type', typesInCategory(category))
  } else if (mute_promos) {
    // "All" tab with promos muted — fold them out.
    qb.whereNotIn('type', typesInCategory('promos'))
  }
  return qb
}

const Notification = {
  create: async (payload) => {
    const [id] = await db(TABLE).insert(payload)
    const row = await db(TABLE).where({ id }).first()
    const decorated = decorate(row)
    // H55 — push the row to the live socket so the bell badge updates
    // without a refetch. Late-require to dodge the io.js → models → io.js
    // circular import that would otherwise bite at boot. Best-effort —
    // if the realtime layer isn't ready yet (e.g. inside a migration),
    // swallow the error so the row still persists.
    try {
      const { emitToUser } = require('../realtime/io')
      if (decorated?.user_id) emitToUser(decorated.user_id, 'notification:new', decorated)
    } catch { /* realtime offline — fall back to client refetch */ }
    return decorated
  },

  listForUser: async (user_id, limit = 100) => {
    const rows = await db(TABLE).where({ user_id }).orderBy('created_at', 'desc').limit(limit)
    return decorateAll(rows)
  },

  // Paginated variant used by the infinite-scroll list on the client.
  // H53 — accepts an optional `category` filter and `mute_promos` flag.
  // M57 — accepts an optional `before` cursor (ISO timestamp). When set we
  // fetch rows strictly older than the cursor, which is stable under
  // concurrent inserts (an offset would shift when a new row lands at the
  // top mid-scroll, leading to dupes / skipped rows).
  listPaged: async (user_id, { limit = 10, offset = 0, before = null, category = null, mute_promos = false } = {}) => {
    const safeLimit  = Math.max(1, Math.min(50, Number(limit) || 10))
    const safeOffset = Math.max(0, Number(offset) || 0)

    let rowsQ = applyFilters(db(TABLE).where({ user_id }), { category, mute_promos })
      .orderBy('created_at', 'desc').limit(safeLimit)

    if (before) {
      // Cursor mode — offset is ignored.
      const beforeDate = new Date(before)
      if (!Number.isNaN(beforeDate.getTime())) {
        rowsQ = rowsQ.where('created_at', '<', beforeDate)
      }
    } else {
      rowsQ = rowsQ.offset(safeOffset)
    }

    // Total never depends on cursor — it's the unfiltered-by-time count
    // under the current category/mute_promos view so the client can show
    // "showing N of M".
    const countQ = applyFilters(db(TABLE).where({ user_id }), { category, mute_promos })
      .count({ n: '*' }).first()
    const [rows, totalRow] = await Promise.all([rowsQ, countQ])
    // Surface the next cursor — the oldest row's created_at — so the client
    // doesn't have to re-derive it from the list.
    const nextBefore = rows.length ? rows[rows.length - 1].created_at : null
    return {
      rows: decorateAll(rows),
      total: Number(totalRow?.n || 0),
      limit: safeLimit, offset: safeOffset,
      nextBefore,
    }
  },

  // H53 — Unread count honours the same filters so the bell badge can
  // also reflect a category (defaults to All-minus-muted-promos).
  unreadCount: async (user_id, { category = null, mute_promos = false } = {}) => {
    const r = await applyFilters(db(TABLE).where({ user_id, read: false }), { category, mute_promos })
      .count({ c: '*' }).first()
    return Number(r?.c || 0)
  },
  markRead:    (id) => db(TABLE).where({ id }).update({ read: true }),
  markAllRead: (user_id) => db(TABLE).where({ user_id }).update({ read: true }),
}

module.exports = Notification
