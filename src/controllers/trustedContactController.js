// Saved trusted contacts — customer-only address book used by the SOS
// share-trip flow (and any future emergency contact features).
//
// Constraints:
//   - max 5 contacts per user (enforced here, not via DB)
//   - one default at a time (we flip the previous default off whenever a
//     new one is set)
//   - phone format mirrors safetyController.shareTrip's check so we never
//     save a contact the safety endpoint would reject

const { db }      = require('../config/db')
const { success } = require('../utils/response')
const { getConfigNumber } = require('../utils/appConfig')

// Same loose phone validator the safety endpoint uses — accepts most
// regional formats with optional country code.
const isValidPhone = (s) => /^\+?\d[\d\s-]{6,18}\d$/.test(String(s || '').trim())

const sanitiseName     = (s) => String(s || '').trim().slice(0, 120)
const sanitiseRelation = (s) => (s ? String(s).trim().slice(0, 60) : null)

// Atomically set / clear the "is_default" flag in a transaction so two
// concurrent writes can't end up with two defaults.
const writeDefault = async (trx, user_id, contactId) => {
  await trx('trusted_contacts').where({ user_id }).update({ is_default: false })
  if (contactId != null) {
    await trx('trusted_contacts').where({ id: contactId, user_id }).update({ is_default: true })
  }
}

module.exports = {
  // GET /api/trusted-contacts  — caller's saved contacts, default first
  list: async (req, res, next) => {
    try {
      const rows = await db('trusted_contacts')
        .where({ user_id: req.user.uid })
        .orderBy([{ column: 'is_default', order: 'desc' }, { column: 'created_at', order: 'asc' }])
      res.json(success('Trusted contacts', { contacts: rows }))
    } catch (err) { next(err) }
  },

  // POST /api/trusted-contacts  { name, phone, relation?, is_default? }
  create: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const { name, phone, relation, is_default } = req.body || {}
      const cleanName  = sanitiseName(name)
      const cleanPhone = String(phone || '').trim()
      if (!cleanName)                  return res.status(400).json({ success: false, message: 'name is required' })
      if (!isValidPhone(cleanPhone))   return res.status(400).json({ success: false, message: 'Invalid phone number' })

      const maxContacts = await getConfigNumber('max_trusted_contacts', 5)
      const [{ n }] = await db('trusted_contacts').where({ user_id: uid }).count({ n: '*' })
      if (Number(n) >= maxContacts) {
        return res.status(409).json({
          success: false,
          message: `You can save at most ${maxContacts} trusted contacts. Remove one to add another.`,
        })
      }

      let id
      await db.transaction(async (trx) => {
        const [insertedId] = await trx('trusted_contacts').insert({
          user_id:    uid,
          name:       cleanName,
          phone:      cleanPhone,
          relation:   sanitiseRelation(relation),
          is_default: !!is_default,
        })
        id = insertedId
        if (is_default) await writeDefault(trx, uid, id)
      })
      const row = await db('trusted_contacts').where({ id }).first()
      res.status(201).json(success('Saved', { contact: row }))
    } catch (err) { next(err) }
  },

  // PATCH /api/trusted-contacts/:id  { name?, phone?, relation?, is_default? }
  update: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const id  = Number(req.params.id)
      if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'Invalid id' })

      const existing = await db('trusted_contacts').where({ id, user_id: uid }).first()
      if (!existing) return res.status(404).json({ success: false, message: 'Not found' })

      const patch = {}
      const { name, phone, relation, is_default } = req.body || {}
      if (name     !== undefined) {
        const v = sanitiseName(name)
        if (!v) return res.status(400).json({ success: false, message: 'name cannot be empty' })
        patch.name = v
      }
      if (phone    !== undefined) {
        const v = String(phone || '').trim()
        if (!isValidPhone(v)) return res.status(400).json({ success: false, message: 'Invalid phone number' })
        patch.phone = v
      }
      if (relation !== undefined) patch.relation = sanitiseRelation(relation)

      await db.transaction(async (trx) => {
        if (Object.keys(patch).length) {
          await trx('trusted_contacts').where({ id, user_id: uid }).update(patch)
        }
        if (is_default === true) {
          await writeDefault(trx, uid, id)
        } else if (is_default === false && existing.is_default) {
          await trx('trusted_contacts').where({ id, user_id: uid }).update({ is_default: false })
        }
      })
      const fresh = await db('trusted_contacts').where({ id }).first()
      res.json(success('Updated', { contact: fresh }))
    } catch (err) { next(err) }
  },

  // DELETE /api/trusted-contacts/:id
  remove: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const id  = Number(req.params.id)
      if (!Number.isFinite(id)) return res.status(400).json({ success: false, message: 'Invalid id' })
      const removed = await db('trusted_contacts').where({ id, user_id: uid }).del()
      if (!removed) return res.status(404).json({ success: false, message: 'Not found' })
      res.json(success('Removed'))
    } catch (err) { next(err) }
  },
}
