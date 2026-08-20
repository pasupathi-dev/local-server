// FCM device tokens — one row per (user, token).
//
// Same token can be re-registered (e.g. user hits the app every day); we
// just bump last_seen_at instead of erroring on the unique key. If the same
// token shows up under a different user (rare — shared device) we steal it
// for the new owner so push doesn't go to the old account.

const { db } = require('../config/db')
const TABLE  = 'fcm_tokens'

const FcmToken = {
  // Insert or update. Always returns the row.
  upsert: async ({ token, user_id, platform = 'web', user_agent = null }) => {
    if (!token || !user_id) return null
    await db(TABLE)
      .insert({ token, user_id, platform, user_agent })
      .onConflict('token')
      .merge({ user_id, platform, user_agent, last_seen_at: db.fn.now() })
    return db(TABLE).where({ token }).first()
  },

  // Drop a single token (called on logout).
  remove: (token) => db(TABLE).where({ token }).del(),

  // Drop a list of tokens (used after FCM tells us they're invalid).
  removeMany: (tokens = []) => {
    if (!tokens.length) return 0
    return db(TABLE).whereIn('token', tokens).del()
  },

  // All tokens for a user — push fan-out target.
  forUser: (user_id) => db(TABLE).where({ user_id }).pluck('token'),

  // All tokens for many users at once (e.g. broadcast to a category).
  forUsers: (user_ids = []) => {
    if (!user_ids.length) return Promise.resolve([])
    return db(TABLE).whereIn('user_id', user_ids).pluck('token')
  },
}

module.exports = FcmToken
