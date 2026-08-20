const ActivityLog = require('../models/ActivityLog')
const { success } = require('../utils/response')

module.exports = {
  list: async (req, res, next) => {
    try {
      const rows = await ActivityLog.list(req.user.uid, {
        type: req.query.type,
        from: req.query.from,
        to:   req.query.to,
        q:    req.query.q,
        limit: Number(req.query.limit) || 500,
      })
      res.json(success('Activity', { activity: rows }))
    } catch (err) { next(err) }
  },
}
