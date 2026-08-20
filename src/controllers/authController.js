const authService = require('../services/authService')
const User         = require('../models/User')
const { db }       = require('../config/db')
const { success }  = require('../utils/response')
const { avatarClass } = require('../utils/ids')
const { getConfigNumber } = require('../utils/appConfig')

// L79 — Daily worker. Finds users with deletion_requested_at older than
// the grace window and finalises the soft-delete. Grace days are admin-
// tunable (account_delete_grace_days). 7d default matches store guidance.
const finalizePendingDeletions = async () => {
  const graceDays = await getConfigNumber('account_delete_grace_days', 7)
  const cutoffSql = `DATE_SUB(NOW(), INTERVAL ${graceDays} DAY)`
  const rows = await db('users')
    .whereNotNull('deletion_requested_at')
    .whereNull('deleted_at')
    .andWhereRaw(`deletion_requested_at <= ${cutoffSql}`)
    .select('user_id')
  if (!rows.length) return 0
  for (const r of rows) {
    try { await User.softDelete(r.user_id) } catch { /* keep going */ }
  }
  return rows.length
}

const authController = {
  // Sync from Firebase login — creates user row if missing.
  // Body may carry { full_name, phone } to seed initial profile.
  // L79 — Signing in while a deletion is pending automatically cancels it
  // (per Play / App Store guidance: "Cancel anytime").
  syncUser: async (req, res, next) => {
    try {
      const user_id = req.user?.uid
      if (!user_id) return res.status(400).json({ success: false, message: 'Missing uid' })
      const { full_name, phone } = req.body || {}

      const existing = await User.findByUid(user_id)
      const name     = full_name || req.user?.name || null
      const av       = existing?.avatar_class || avatarClass(user_id)

      await User.upsert({
        user_id,
        email:     req.user?.email,
        full_name: name,
        phone,
      })
      if (!existing) {
        await User.update(user_id, { avatar_class: av })
      }
      // Cancel any pending deletion the moment they log back in.
      if (existing?.deletion_requested_at) {
        await User.cancelDeletion(user_id).catch(() => {})
      }
      const user = await authService.getProfile(user_id)
      res.json(success('User synced', { user }))
    } catch (err) { next(err) }
  },

  getMe: async (req, res, next) => {
    try {
      const user = await authService.getProfile(req.user.uid)
      res.json(success('Profile', { user }))
    } catch (err) { next(err) }
  },

  // Legacy hard soft-delete — kept for admin use. The user-facing flow now
  // goes through requestDeletion → 7-day worker → softDelete, so a UI
  // never calls this directly.
  deleteUser: async (req, res, next) => {
    try {
      await User.softDelete(req.user.uid)
      res.json(success('User deleted'))
    } catch (err) { next(err) }
  },

  // L79 — Schedules account deletion. Sets deletion_requested_at; the
  // existing /api/auth/me response surfaces the same field so the client
  // can show a banner with "X days until deletion · Cancel".
  requestDeletion: async (req, res, next) => {
    try {
      await User.requestDeletion(req.user.uid)
      const user = await authService.getProfile(req.user.uid)
      res.json(success('Deletion scheduled', { user, days: 7 }))
    } catch (err) { next(err) }
  },

  // L79 — Cancels a pending deletion. Clears deletion_requested_at.
  cancelDeletion: async (req, res, next) => {
    try {
      await User.cancelDeletion(req.user.uid)
      const user = await authService.getProfile(req.user.uid)
      res.json(success('Deletion cancelled', { user }))
    } catch (err) { next(err) }
  },

  // Step 1 — role pick
  pickRole: async (req, res, next) => {
    try {
      const { role } = req.body || {}
      const user = await authService.pickRole(req.user.uid, role)
      res.json(success('Role updated', { user }))
    } catch (err) { next(err) }
  },

  // Step 2 — basic profile
  saveProfile: async (req, res, next) => {
    try {
      const user = await authService.saveBasicProfile(req.user.uid, req.body || {})
      res.json(success('Profile saved', { user }))
    } catch (err) { next(err) }
  },

  finishOnboarding: async (req, res, next) => {
    try {
      const user = await authService.finishOnboarding(req.user.uid)
      res.json(success('Onboarding complete', { user }))
    } catch (err) { next(err) }
  },

  // Admin helpers (kept)
  updateStatus: async (req, res, next) => {
    try {
      const { user_id, status } = req.body || {}
      if (!user_id || !status) return res.status(400).json({ success: false, message: 'user_id and status are required' })
      await User.updateStatus(user_id, status)
      res.json(success('User status updated'))
    } catch (err) { next(err) }
  },
  updateRole: async (req, res, next) => {
    try {
      const { user_id, role } = req.body || {}
      if (!user_id || !role) return res.status(400).json({ success: false, message: 'user_id and role are required' })
      await User.updateRole(user_id, role)
      res.json(success('User role updated'))
    } catch (err) { next(err) }
  },
}

module.exports = authController
module.exports.finalizePendingDeletions = finalizePendingDeletions
