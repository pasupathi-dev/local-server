const { db } = require('../config/db')
const TABLE  = 'requests'

// Normalise JSON-typed columns whose driver representation depends on the
// mysql2 version. We want every consumer to see arrays, never strings.
const parseJson = (v) => {
  if (v == null) return null
  if (Array.isArray(v) || typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return null }
}
const normalize = (row) => {
  if (!row) return row
  return {
    ...row,
    photos:            parseJson(row.photos) || [],
    tried_partner_ids: parseJson(row.tried_partner_ids) || [],
  }
}

const Request = {
  create: async (payload) => {
    await db(TABLE).insert(payload)
    return Request.findById(payload.id)
  },

  findById: async (id) => {
    const row = await db(TABLE).where({ id }).first()
    return normalize(row)
  },

  listLiveForCustomer: (customer_id) => db(TABLE)
    .where({ customer_id, status: 'live' })
    .orderBy('created_at', 'desc'),

  listLiveForPartner: (partner_id) => db(TABLE)
    .where({ partner_id, status: 'live' })
    .orderBy('created_at', 'desc'),

  // Partners see any live request whose work they serve
  listLiveByWork: (work_name) => db(TABLE)
    .where({ work_name, status: 'live' })
    .orderBy('created_at', 'desc'),

  // Live requests visible to a specific partner — survives refresh / navigation:
  //   • Direct requests addressed to this partner (any work), OR
  //   • Broadcast requests (partner_id IS NULL) for any work they serve
  //     (primary_work OR a row in partner_category_prices.work_name).
  // Excludes requests already taken by *another* partner (status != live).
  listLiveForPartnerView: async (partner_id, served_works = []) => {
    const works = (served_works || []).filter(Boolean)
    return db(TABLE)
      .where('status', 'live')
      .andWhere(function () {
        this.where('partner_id', partner_id)
        if (works.length) {
          this.orWhere(function () {
            this.whereNull('partner_id').whereIn('work_name', works)
          })
        }
      })
      .orderBy('created_at', 'desc')
  },

  updateStatus: async (id, status) => db(TABLE).where({ id }).update({
    status,
    resolved_at: status === 'live' ? null : db.fn.now(),
  }),

  assignPartner: (id, partner_id) => db(TABLE).where({ id }).update({ partner_id }),

  // Reassign an auto-match request to the next-best partner. Bumps the
  // tried list so future retries skip the new partner if THEY also decline.
  // Resets `partner_id` and resolved_at so the request stays visibly live
  // and the customer's waiting timer keeps ticking.
  reassignAutoMatch: async (id, new_partner_id, tried_ids) => db(TABLE).where({ id }).update({
    partner_id:        new_partner_id,
    tried_partner_ids: JSON.stringify(tried_ids),
    resolved_at:       null,
  }),

  // MySQL JSON columns can come back as either a parsed array or a string
  // depending on driver settings — normalise to an array of ids.
  triedPartnerIds: (row) => {
    if (!row?.tried_partner_ids) return []
    if (Array.isArray(row.tried_partner_ids)) return row.tried_partner_ids
    try { return JSON.parse(row.tried_partner_ids) || [] } catch { return [] }
  },

  // Atomic compare-and-swap: only updates if status is still 'live'.
  // Returns number of affected rows (0 = another partner already accepted).
  acceptAtomic: (id, partner_id) => db(TABLE)
    .where({ id, status: 'live' })
    .update({ status: 'accepted', partner_id, resolved_at: db.fn.now() }),

  // Pending auto-match pool: live, is_auto, no partner assigned yet, for any
  // work the newly-online partner serves. Caller filters by radius (Haversine)
  // and tried_partner_ids in JS — keeps the SQL portable across MySQL versions
  // that may or may not have spatial helpers handy.
  findPendingAutoForWorks: (work_names) => {
    const works = (work_names || []).filter(Boolean)
    if (!works.length) return Promise.resolve([])
    return db(TABLE)
      .where('status', 'live')
      .andWhere('is_auto', true)
      .whereNull('partner_id')
      .whereIn('work_name', works)
      .andWhere('expires_at', '>', new Date())
      .orderBy('created_at', 'asc')
  },

  // Atomic claim of a pending auto request for a newly-online partner.
  // Only succeeds if partner_id is still NULL and status still 'live' —
  // protects against two partners coming online concurrently and racing
  // for the same request. Returns affected row count (0 = lost the race).
  claimPendingAtomic: (id, partner_id, tried_ids) => db(TABLE)
    .where({ id, status: 'live' })
    .whereNull('partner_id')
    .update({
      partner_id,
      tried_partner_ids: JSON.stringify(tried_ids),
      resolved_at: null,
    }),

  // Returns the expired rows (with customer/partner/category) so the caller
  // can emit socket events to the affected parties.
  expireOverdue: async () => {
    // Use a JS Date for the comparison so the WHERE value goes through the
    // same UTC serialization path as the stored expires_at. db.fn.now() would
    // resolve via MySQL's session timezone and could mis-compare against a
    // driver-serialized UTC TIMESTAMP, causing fresh requests to be
    // incorrectly expired on the next cron tick.
    const now = new Date()
    const toExpire = await db(TABLE)
      .where('status', 'live')
      .where('expires_at', '<', now)
      .select('id', 'customer_id', 'partner_id', 'category_name', 'work_name')
    if (!toExpire.length) return []
    await db(TABLE)
      .whereIn('id', toExpire.map((r) => r.id))
      .update({ status: 'expired', resolved_at: now })
    return toExpire
  },
}

module.exports = Request
