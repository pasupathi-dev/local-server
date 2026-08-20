const { db } = require('../config/db')
const TABLE  = 'app_settings'

const DEFAULTS = {
  sound_on: true,
  push_on:  true,
  email_on: false,
  dev_mode: true,
  dark_mode:false,
  mute_promos:    false,   // H53 — hides 'promo' category in list + drops promo pushes
  quiet_hours_on: false,   // M56 — pushService queues non-urgent pushes during 22:00–07:00 local
  locale:         'en',    // M77 — UI locale, served by the client i18n bootstrap
}

const Settings = {
  get: async (user_id) => {
    const row = await db(TABLE).where({ user_id }).first()
    return row || { user_id, ...DEFAULTS }
  },

  update: async (user_id, patch = {}) => {
    const payload = { user_id, ...DEFAULTS, ...patch, user_id }
    await db(TABLE)
      .insert(payload)
      .onConflict('user_id')
      .merge({ ...patch, updated_at: db.fn.now() })
    return Settings.get(user_id)
  },
}

module.exports = Settings
