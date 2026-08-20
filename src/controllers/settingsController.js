const Settings = require('../models/Settings')
const ActivityLog = require('../models/ActivityLog')
const { success } = require('../utils/response')

module.exports = {
  get: async (req, res, next) => {
    try {
      const s = await Settings.get(req.user.uid)
      res.json(success('Settings', { settings: s }))
    } catch (err) { next(err) }
  },
  update: async (req, res, next) => {
    try {
      const s = await Settings.update(req.user.uid, req.body || {})
      // only log for partners
      const user = require('../models/User')
      const u = await user.findByUid(req.user.uid)
      if (u?.role === 'partner') {
        await ActivityLog.add({
          partner_id: req.user.uid, type: 'setting_changed',
          title: 'Settings updated', sub: Object.keys(req.body || {}).join(', '),
          icon: '⚙️', color: '#6b7280',
        })
      }
      res.json(success('Settings saved', { settings: s }))
    } catch (err) { next(err) }
  },
}
