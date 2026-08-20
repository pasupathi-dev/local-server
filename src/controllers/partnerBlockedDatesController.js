// M83 — Partner day-off block.
// Partner-side CRUD for partner_blocked_dates + a customer-facing helper
// that returns the blocked set for a given partner so the booking form
// can hide those dates from the picker.

const { db } = require('../config/db')
const { success } = require('../utils/response')

const TABLE = 'partner_blocked_dates'
const MAX_BLOCKS_PER_PARTNER = 366   // a whole year is plenty

// Normalises a "YYYY-MM-DD" string. Returns null on bad input.
const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '').trim())

module.exports = {
  // GET /api/partners/me/blocked-dates  — list dates this partner blocked.
  listMine: async (req, res, next) => {
    try {
      const rows = await db(TABLE)
        .where({ partner_id: req.user.uid })
        .orderBy('blocked_date', 'asc')
      res.json(success('Blocked dates', { blocked: rows }))
    } catch (err) { next(err) }
  },

  // POST /api/partners/me/blocked-dates   { date, reason? }
  create: async (req, res, next) => {
    try {
      const date = String(req.body?.date || '').trim()
      const reason = String(req.body?.reason || '').trim().slice(0, 200)
      if (!isValidDate(date)) {
        return res.status(400).json({ success: false, message: 'date must be YYYY-MM-DD' })
      }

      // Cap to avoid runaway storage from a stuck client.
      const countRow = await db(TABLE).where({ partner_id: req.user.uid }).count({ c: '*' }).first()
      if (Number(countRow?.c || 0) >= MAX_BLOCKS_PER_PARTNER) {
        return res.status(409).json({ success: false, message: 'Block limit reached' })
      }

      try {
        await db(TABLE).insert({
          partner_id: req.user.uid,
          blocked_date: date,
          reason: reason || null,
        })
      } catch (err) {
        // UNIQUE constraint hit — date already blocked. Idempotent: just
        // return the existing row so the UI doesn't have to special-case.
        if (String(err.code).includes('ER_DUP_ENTRY')
         || String(err.message).includes('Duplicate')) {
          const existing = await db(TABLE)
            .where({ partner_id: req.user.uid, blocked_date: date })
            .first()
          return res.json(success('Already blocked', { blocked: existing }))
        }
        throw err
      }

      const blocked = await db(TABLE)
        .where({ partner_id: req.user.uid, blocked_date: date })
        .first()
      res.status(201).json(success('Date blocked', { blocked }))
    } catch (err) { next(err) }
  },

  // DELETE /api/partners/me/blocked-dates/:id
  remove: async (req, res, next) => {
    try {
      await db(TABLE)
        .where({ id: req.params.id, partner_id: req.user.uid })
        .del()
      res.json(success('Date unblocked'))
    } catch (err) { next(err) }
  },

  // GET /api/partners/:id/blocked-dates   (customer-facing)
  // Returns the blocked-date set so the customer's booking form can hide
  // those dates from the picker. Caller uses this BEFORE letting the
  // customer pick a date — the server also re-validates on create.
  listForPartner: async (req, res, next) => {
    try {
      const rows = await db(TABLE)
        .where({ partner_id: req.params.id })
        .whereRaw('blocked_date >= CURRENT_DATE()')
        .orderBy('blocked_date', 'asc')
        .select('blocked_date')
      res.json(success('Blocked dates', {
        blocked: rows.map((r) => {
          // MySQL returns Date objects — normalise to YYYY-MM-DD string.
          const d = r.blocked_date instanceof Date ? r.blocked_date : new Date(r.blocked_date)
          const y = d.getFullYear()
          const m = String(d.getMonth() + 1).padStart(2, '0')
          const day = String(d.getDate()).padStart(2, '0')
          return `${y}-${m}-${day}`
        }),
      }))
    } catch (err) { next(err) }
  },

  // Internal helper for the scheduledJob.create controller — returns true
  // if the partner is blocked on the requested date. Exported so it can
  // be required without spinning up an HTTP call.
  isPartnerBlockedOn: async (partner_id, date) => {
    if (!isValidDate(date)) return false
    const row = await db(TABLE)
      .where({ partner_id, blocked_date: date })
      .first()
    return !!row
  },
}
