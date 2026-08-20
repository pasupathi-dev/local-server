// src/models/User.js  — users table queries (Knex, no raw SQL).
// Table created by models/schema.js.

const { db } = require('../config/db')

const TABLE = 'users'

// fields a caller can update via profile / onboarding
const EDITABLE_FIELDS = [
  'email','phone','full_name','avatar_class','avatar_url',
  'address','city','pincode',
  'status','role','onboarding_done',
]

const pick = (obj, keys) => keys.reduce((acc, k) => {
  if (obj[k] !== undefined) acc[k] = obj[k]
  return acc
}, {})

const User = {

  findByUid: async (user_id) => {
    const row = await db(TABLE).where({ user_id }).whereNull('deleted_at').first()
    return row || null
  },

  findByEmail: async (email) => {
    const row = await db(TABLE).where({ email }).whereNull('deleted_at').first()
    return row || null
  },

  findByPhone: async (phone) => {
    const row = await db(TABLE).where({ phone }).whereNull('deleted_at').first()
    return row || null
  },

  // Insert new user OR merge in changed fields. Never clobbers role/status
  // on update unless explicitly passed.
  upsert: async ({ user_id, email, full_name, phone }) => {
    const row = {
      user_id,
      email:      email     || null,
      full_name:  full_name || null,
      phone:      phone     || null,
    }
    await db(TABLE)
      .insert(row)
      .onConflict('user_id')
      .merge({
        email:     db.raw('COALESCE(VALUES(email), email)'),
        full_name: db.raw('COALESCE(VALUES(full_name), full_name)'),
        phone:     db.raw('COALESCE(VALUES(phone), phone)'),
        updated_at: db.fn.now(),
      })
    return User.findByUid(user_id)
  },

  update: async (user_id, patch = {}) => {
    const payload = pick(patch, EDITABLE_FIELDS)
    if (!Object.keys(payload).length) return User.findByUid(user_id)
    await db(TABLE).where({ user_id }).update({ ...payload, updated_at: db.fn.now() })
    return User.findByUid(user_id)
  },

  softDelete: async (user_id) => {
    return db(TABLE).where({ user_id }).update({
      deleted_at: db.fn.now(),
      status:     'inactive',
    })
  },

  updateStatus: async (user_id, status) => db(TABLE).where({ user_id }).update({ status }),
  updateRole:   async (user_id, role)   => db(TABLE).where({ user_id }).update({ role }),
  setOnboardingDone: async (user_id, done = true) => db(TABLE).where({ user_id }).update({ onboarding_done: !!done }),

  getAll: async () => db(TABLE)
    .select('user_id','email','phone','full_name','avatar_class','avatar_url','status','role','onboarding_done','created_at')
    .whereNull('deleted_at')
    .orderBy('created_at', 'desc'),

  // L79 — Soft-deletion with 7-day grace period. The "request" call only
  // records the start of the grace period; the daily worker calls
  // `softDelete()` once the grace elapses. Sign-in clears it so a user
  // who changes their mind can cancel just by logging back in.
  requestDeletion: async (user_id) =>
    db(TABLE).where({ user_id }).update({ deletion_requested_at: db.fn.now() }),
  cancelDeletion: async (user_id) =>
    db(TABLE).where({ user_id }).update({ deletion_requested_at: null }),
}

module.exports = User
