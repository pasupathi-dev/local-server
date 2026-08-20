// Customer-saved partners (M21). Star/unstar a partner, and list the
// authenticated user's saved partners with the same shape PartnersListPage
// already renders (avatar + rating + price + distance) so the home page's
// "Saved" rail can reuse the existing card component.

const { db }    = require('../config/db')
const { success } = require('../utils/response')

const TABLE = 'favourites'

module.exports = {
  // GET /api/favourites — paginated list, newest-first
  list: async (req, res, next) => {
    try {
      const uid    = req.user.uid
      const limit  = Math.max(1, Math.min(100, Number(req.query.limit) || 20))
      // Optional coords so the response matches the same `distance_km` shape
      // PartnersListPage uses. Without coords we just skip the column.
      const lat = Number(req.query.lat)
      const lng = Number(req.query.lng)
      const hasCoords = Number.isFinite(lat) && Number.isFinite(lng)

      const q = db({ f: TABLE })
        .leftJoin({ p: 'partners' }, function () {
          this.on(db.raw('f.partner_id COLLATE utf8mb4_unicode_ci = p.user_id COLLATE utf8mb4_unicode_ci'))
        })
        .leftJoin({ u: 'users' }, function () {
          this.on(db.raw('f.partner_id COLLATE utf8mb4_unicode_ci = u.user_id COLLATE utf8mb4_unicode_ci'))
        })
        .where('f.user_id', uid)
        .select(
          'f.partner_id as user_id',
          'u.full_name', 'u.avatar_class', 'u.city',
          'p.primary_category', 'p.primary_work', 'p.rating_avg', 'p.rating_count',
          'p.is_online', 'p.is_verified', 'p.completion_rate',
          'p.lat', 'p.lng', 'p.location_city',
          'f.created_at as favourited_at',
        )
        .orderBy('f.created_at', 'desc')
        .limit(limit)

      if (hasCoords) {
        q.select(db.raw(
          '(6371 * acos(cos(radians(?)) * cos(radians(p.lat)) * cos(radians(p.lng) - radians(?)) + sin(radians(?)) * sin(radians(p.lat)))) AS distance_km',
          [lat, lng, lat],
        ))
      }

      const rows = await q
      // Strip rows where the partner profile was deleted underneath us.
      const partners = rows.filter((r) => r.user_id)
      res.json(success('Favourites', { partners }))
    } catch (err) { next(err) }
  },

  // POST /api/favourites { partner_id }
  add: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const partner_id = String(req.body?.partner_id || '').trim()
      if (!partner_id) {
        return res.status(400).json({ success: false, message: 'partner_id required' })
      }
      // ON CONFLICT IGNORE — starring twice is a no-op, not an error.
      await db(TABLE).insert({ user_id: uid, partner_id })
        .onConflict(['user_id', 'partner_id']).ignore()
      res.json(success('Favourited', { partner_id, favourited: true }))
    } catch (err) { next(err) }
  },

  // DELETE /api/favourites/:partner_id
  remove: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const partner_id = String(req.params.partner_id || '').trim()
      if (!partner_id) {
        return res.status(400).json({ success: false, message: 'partner_id required' })
      }
      await db(TABLE).where({ user_id: uid, partner_id }).del()
      res.json(success('Unfavourited', { partner_id, favourited: false }))
    } catch (err) { next(err) }
  },

  // GET /api/favourites/ids  — small payload for the star-button hydration.
  // The customer's saved-partner IDs as a flat array; the client uses this
  // to render the star state on every partner card without N round-trips.
  ids: async (req, res, next) => {
    try {
      const rows = await db(TABLE).where({ user_id: req.user.uid }).pluck('partner_id')
      res.json(success('Favourite IDs', { ids: rows }))
    } catch (err) { next(err) }
  },
}
