const { db } = require('../config/db')
const TABLE  = 'works'

// Works are the bookable leaf of the taxonomy. Each row belongs to one parent
// category (`category_name`). Matching + pricing happen at this level.
const Work = {
  // Active works only, optionally scoped to one parent category.
  getAll: (category_name = null) => {
    const q = db(TABLE).where({ is_active: true })
    if (category_name) q.andWhere({ category_name })
    return q.select('*').orderBy([{ column: 'category_name', order: 'asc' }, { column: 'sort_order', order: 'asc' }])
  },

  getByCategory: (category_name) =>
    db(TABLE).where({ is_active: true, category_name }).select('*').orderBy('sort_order', 'asc'),

  // All works (incl. inactive) — admin views.
  getAllAdmin: (category_name = null) => {
    const q = db(TABLE)
    if (category_name) q.where({ category_name })
    return q.select('*').orderBy([{ column: 'category_name', order: 'asc' }, { column: 'sort_order', order: 'asc' }])
  },

  findOne: (name) => db(TABLE).where({ name }).first(),

  // Resolve a work's parent category name (null if the work is unknown).
  parentOf: async (name) => {
    if (!name) return null
    const row = await db(TABLE).where({ name }).first()
    return row ? row.category_name : null
  },

  create: (row) => db(TABLE).insert(row),
  update: (name, patch) => db(TABLE).where({ name }).update(patch),
  remove: (name) => db(TABLE).where({ name }).del(),
}

module.exports = Work
