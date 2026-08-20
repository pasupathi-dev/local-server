const { db } = require('../config/db')
const TABLE  = 'categories'

const Category = {
  getAll:      ()     => db(TABLE).where({ is_active: true }).select('*').orderBy('sort_order', 'asc'),
  getAllAdmin:  ()     => db(TABLE).select('*').orderBy('sort_order', 'asc'),
  findOne:     (name) => db(TABLE).where({ name }).first(),
}

module.exports = Category
