// M68 — Customer-side "Report this partner". Independent of disputes —
// disputes are about a single job; flags are about a partner's general
// behaviour (off-platform payment asks, misleading profile, abusive
// language). Multiple flags per partner are allowed; the admin portal
// reviews and either dismisses or actions.

const { db } = require('../config/db')
const Notification = require('../models/Notification')
const User = require('../models/User')
const { success } = require('../utils/response')
const push = require('../services/pushService')
const { getConfigNumber } = require('../utils/appConfig')

const REASONS = new Set(['inappropriate', 'misleading', 'off_platform_payment', 'other'])
const REASON_LABEL = {
  inappropriate:        'Inappropriate behaviour',
  misleading:           'Misleading profile',
  off_platform_payment: 'Asked for off-platform payment',
  other:                'Other',
}

module.exports = {
  // POST /api/partners/:id/flag   { reason, note }
  create: async (req, res, next) => {
    try {
      const reporter_id = req.user.uid
      const partner_id  = req.params.id
      const reason      = String(req.body?.reason || '').toLowerCase()
      const note        = String(req.body?.note || '').trim().slice(0, 1000)

      if (!REASONS.has(reason)) {
        return res.status(400).json({ success: false, message: 'Pick a valid reason' })
      }
      // "Other" requires a note — a freeform reason without context is noise.
      if (reason === 'other' && !note) {
        return res.status(400).json({ success: false, message: 'Tell us briefly what happened' })
      }

      const partner = await db('partners').where({ user_id: partner_id }).first()
      if (!partner) {
        return res.status(404).json({ success: false, message: 'Partner not found' })
      }
      if (partner_id === reporter_id) {
        return res.status(400).json({ success: false, message: 'You can\'t flag yourself' })
      }

      // Cooldown — block duplicate flags from the same reporter inside the
      // cooldown window. Admin-tunable (partner_flag_cooldown_hours).
      const cooldownHours = await getConfigNumber('partner_flag_cooldown_hours', 24)
      const recent = await db('partner_flags')
        .where({ partner_id, reporter_id })
        .andWhereRaw('created_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)', [cooldownHours])
        .orderBy('created_at', 'desc')
        .first()
      if (recent) {
        return res.status(409).json({
          success: false,
          code: 'flag_cooldown',
          message: `You already flagged this partner recently. Our team is reviewing.`,
        })
      }

      const [id] = await db('partner_flags').insert({
        partner_id, reporter_id, reason, note: note || null, status: 'open',
      })
      const flag = await db('partner_flags').where({ id }).first()

      // Admin fan-out — same pattern as dispute fan-out, in-app + push.
      const reporter = await User.findByUid(reporter_id).catch(() => null)
      const reporterName = reporter?.full_name || 'A customer'
      const adminIds = await db('users')
        .where((b) => b.where('role', 'admin').orWhere('is_admin', true))
        .whereNull('deleted_at')
        .pluck('user_id')

      const title = `🚩 Partner flagged · ${REASON_LABEL[reason]}`
      const body  = `${reporterName} flagged ${partner.user_id} (${REASON_LABEL[reason]})${note ? `: ${note.slice(0, 80)}` : ''}`
      for (const adminId of adminIds) {
        try {
          await Notification.create({
            user_id: adminId, type: 'safety_sos',
            title, body, icon: '🚩', icon_bg: '#fee2e2',
            route: '/portal/safety',
          })
        } catch { /* keep iterating */ }
      }
      if (adminIds.length) {
        push.sendToUsers(adminIds, {
          title,
          body: note ? note.slice(0, 200) : REASON_LABEL[reason],
          data: { type: 'partner:flagged', partnerId: partner_id, flagId: String(id), route: '/portal/safety' },
        }).catch(() => {})
      }

      res.status(201).json(success('Reported — our team will review', { flag }))
    } catch (err) { next(err) }
  },

  // GET /api/partners/:id/flags/mine   — does the current customer already
  // have an open / recent flag against this partner? Drives the UI on the
  // partner detail page so we don't show the report button twice.
  mine: async (req, res, next) => {
    try {
      const flag = await db('partner_flags')
        .where({ partner_id: req.params.id, reporter_id: req.user.uid })
        .orderBy('created_at', 'desc')
        .first()
      res.json(success('Flag', { flag: flag || null }))
    } catch (err) { next(err) }
  },
}
