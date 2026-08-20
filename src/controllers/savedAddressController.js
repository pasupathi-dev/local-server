// Customer address book (H26). Powers the "Send to: 24 Lotus Ave. Change"
// confirmation step before a request goes out. Customers can book for a
// friend's address without overwriting their own profile.

const { db } = require('../config/db')
const { success } = require('../utils/response')
const { getConfigNumber } = require('../utils/appConfig')

const TABLE = 'saved_addresses'

// Server enforces "at most one default per user" because MySQL doesn't
// support partial unique indexes.
const setOthersNonDefault = async (user_id, exceptId = null) => {
  const q = db(TABLE).where({ user_id, is_default: true }).update({ is_default: false })
  if (exceptId != null) q.andWhereNot('id', exceptId)
  await q
}

module.exports = {
  // GET /api/saved-addresses — every address the user has saved, default first.
  list: async (req, res, next) => {
    try {
      const rows = await db(TABLE)
        .where({ user_id: req.user.uid })
        .orderBy([{ column: 'is_default', order: 'desc' }, { column: 'created_at', order: 'desc' }])
      res.json(success('Saved addresses', { addresses: rows }))
    } catch (err) { next(err) }
  },

  // POST /api/saved-addresses { label?, address, lat?, lng?, is_default? }
  create: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const { label, address, city, pincode, lat, lng, is_default } = req.body || {}
      const trimmed = String(address || '').trim()
      if (!trimmed) {
        return res.status(400).json({ success: false, message: 'address is required' })
      }
      // Cap the address book — admin-tunable (max_saved_addresses).
      const maxAddresses = await getConfigNumber('max_saved_addresses', 8)
      const count = await db(TABLE).where({ user_id: uid }).count({ n: '*' }).first()
      if (Number(count?.n || 0) >= maxAddresses) {
        return res.status(409).json({ success: false, message: `Address book is full (${maxAddresses} max)` })
      }
      const payload = {
        user_id:    uid,
        label:      String(label || 'Other').trim().slice(0, 60) || 'Other',
        address:    trimmed.slice(0, 500),
        city:       city != null ? String(city).trim().slice(0, 120) || null : null,
        pincode:    pincode != null ? String(pincode).trim().slice(0, 12) || null : null,
        lat:        lat != null && Number.isFinite(Number(lat)) ? Number(lat) : null,
        lng:        lng != null && Number.isFinite(Number(lng)) ? Number(lng) : null,
        is_default: !!is_default,
      }
      const [id] = await db(TABLE).insert(payload)
      if (payload.is_default) await setOthersNonDefault(uid, id)
      const row = await db(TABLE).where({ id }).first()
      res.status(201).json(success('Created', { address: row }))
    } catch (err) { next(err) }
  },

  // PATCH /api/saved-addresses/:id — partial update
  update: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const id = Number(req.params.id)
      const existing = await db(TABLE).where({ id, user_id: uid }).first()
      if (!existing) return res.status(404).json({ success: false, message: 'Not found' })

      const patch = {}
      if (req.body?.label   !== undefined) patch.label   = String(req.body.label || '').trim().slice(0, 60) || 'Other'
      if (req.body?.address !== undefined) patch.address = String(req.body.address || '').trim().slice(0, 500)
      if (req.body?.city    !== undefined) patch.city    = String(req.body.city || '').trim().slice(0, 120) || null
      if (req.body?.pincode !== undefined) patch.pincode = String(req.body.pincode || '').trim().slice(0, 12) || null
      if (req.body?.lat     !== undefined) patch.lat     = Number(req.body.lat)
      if (req.body?.lng     !== undefined) patch.lng     = Number(req.body.lng)
      if (req.body?.is_default !== undefined) patch.is_default = !!req.body.is_default

      await db(TABLE).where({ id }).update(patch)
      if (patch.is_default) await setOthersNonDefault(uid, id)
      const row = await db(TABLE).where({ id }).first()
      res.json(success('Updated', { address: row }))
    } catch (err) { next(err) }
  },

  // DELETE /api/saved-addresses/:id
  remove: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const id = Number(req.params.id)
      const existing = await db(TABLE).where({ id, user_id: uid }).first()
      if (!existing) return res.status(404).json({ success: false, message: 'Not found' })
      await db(TABLE).where({ id }).del()
      res.json(success('Deleted', { id }))
    } catch (err) { next(err) }
  },
}
