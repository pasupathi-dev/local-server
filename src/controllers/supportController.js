// H65 — Lightweight support funnel. Right now this is just the "Report a
// bug" path from the Help page: takes free text from any logged-in user and
// fans it out as a notification to every admin so the support team can
// triage. We deliberately don't create a dedicated table for this — the
// admin notifications inbox is the single source of triage today, and a
// new table would be premature without a portal-side queue UI.
//
// If the bug-report volume grows we can promote this to a `support_tickets`
// table with status transitions; the endpoint surface here would stay the
// same so the client doesn't need to change.

const { db } = require('../config/db')
const Notification = require('../models/Notification')
const User = require('../models/User')
const { success } = require('../utils/response')
const push = require('../services/pushService')

module.exports = {
  // POST /api/support/bug   { body, route?, jobId? }
  // body — free-text bug report (required, capped at 2000 chars)
  // route — page the user was on when they reported (optional, for context)
  // jobId — most recent job the user was looking at (optional)
  reportBug: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const body  = String(req.body?.body || '').trim().slice(0, 2000)
      const route = String(req.body?.route || '').slice(0, 200)
      const jobId = String(req.body?.jobId || '').slice(0, 40)
      if (!body) {
        return res.status(400).json({ success: false, message: 'Description cannot be empty' })
      }
      const reporter = await User.findByUid(uid).catch(() => null)
      const reporterName = reporter?.full_name || reporter?.email || 'A user'

      const adminIds = await db('users')
        .where((b) => b.where('role', 'admin').orWhere('is_admin', true))
        .whereNull('deleted_at')
        .pluck('user_id')

      const title = `🐞 Bug report from ${reporterName}`
      const ctx = [route && `route: ${route}`, jobId && `job: ${jobId}`].filter(Boolean).join(' · ')
      const fullBody = ctx ? `${ctx}\n${body}` : body

      for (const adminId of adminIds) {
        try {
          await Notification.create({
            user_id: adminId, type: 'dispute_opened',
            title,
            body: fullBody.slice(0, 500),
            icon: '🐞', icon_bg: '#fef3c7',
            route: '/portal/safety',
          })
        } catch { /* keep iterating */ }
      }
      if (adminIds.length) {
        push.sendToUsers(adminIds, {
          title,
          body: body.slice(0, 200),
          data: { type: 'support:bug', route: '/portal/safety' },
        }).catch(() => {})
      }

      res.status(201).json(success('Reported — our team will follow up'))
    } catch (err) { next(err) }
  },
}
