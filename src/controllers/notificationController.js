const Notification = require('../models/Notification')
const Settings     = require('../models/Settings')
const FcmToken     = require('../models/FcmToken')
const { success }  = require('../utils/response')
const { CATEGORIES } = require('../utils/notificationCategory')

module.exports = {
  list: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const rawCat = String(req.query.category || '').toLowerCase()
      const category = CATEGORIES.includes(rawCat) ? rawCat : null

      // H53 — if the user muted promos, fold them out of the "All" tab too.
      // Cheap one-row lookup; we already fetch settings on the client but the
      // server is authoritative so the filter survives a stale client.
      const s = await Settings.get(uid).catch(() => ({}))
      const mute_promos = !!s?.mute_promos

      // When the caller paginates we return total + limit + offset so the
      // client can implement infinite scroll without guessing when to stop.
      // M57 — also accepts `before` (ISO timestamp) for cursor-based pages.
      if (req.query.limit != null || req.query.offset != null || req.query.before != null) {
        const [{ rows: notifications, total, limit, offset, nextBefore }, unread] = await Promise.all([
          Notification.listPaged(uid, {
            limit: req.query.limit, offset: req.query.offset,
            before: req.query.before,
            category, mute_promos,
          }),
          // Bell badge: count unread under the same view the user is seeing.
          Notification.unreadCount(uid, { category, mute_promos }),
        ])
        return res.json(success('Notifications', { notifications, total, limit, offset, nextBefore, unread, category }))
      }
      const [notifications, unread] = await Promise.all([
        Notification.listForUser(uid, 100),
        Notification.unreadCount(uid, { mute_promos }),
      ])
      res.json(success('Notifications', { notifications, unread, category }))
    } catch (err) { next(err) }
  },
  markRead:    async (req, res, next) => { try { await Notification.markRead(req.params.id); res.json(success('Read')) } catch (err) { next(err) } },
  markAllRead: async (req, res, next) => { try { await Notification.markAllRead(req.user.uid); res.json(success('All read')) } catch (err) { next(err) } },

  // POST /api/notifications/devices  { token, platform?, user_agent? }
  // Register (or refresh) an FCM device token for the current user. Idempotent
  // — calling it on every app load is fine; we just bump last_seen_at.
  registerDevice: async (req, res, next) => {
    try {
      const { token, platform, user_agent } = req.body || {}
      if (!token || typeof token !== 'string') {
        return res.status(400).json({ success: false, message: 'token required' })
      }
      const row = await FcmToken.upsert({
        token,
        user_id:    req.user.uid,
        platform:   platform || 'web',
        user_agent: user_agent || req.headers['user-agent'] || null,
      })
      res.status(201).json(success('Device registered', { device: row }))
    } catch (err) { next(err) }
  },

  // DELETE /api/notifications/devices/:token
  // Called on logout so the device stops receiving pushes for the old user.
  unregisterDevice: async (req, res, next) => {
    try {
      await FcmToken.remove(req.params.token)
      res.json(success('Device removed'))
    } catch (err) { next(err) }
  },
}
