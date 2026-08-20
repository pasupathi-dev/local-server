// src/models/Location.js
// All `user_locations` table queries go through Knex — no raw SQL.

const { db } = require('../config/db')

const TABLE = 'user_locations'

const Location = {

  createTable: async () => {
    const exists = await db.schema.hasTable(TABLE)
    if (exists) return

    await db.schema.createTable(TABLE, (t) => {
      t.increments('id').primary()
      t.string('uid', 128).notNullable()
      t.decimal('lat', 10, 7).notNullable()
      t.decimal('lng', 10, 7).notNullable()
      t.string('city', 255).defaultTo(null)
      t.string('country', 255).defaultTo(null)
      t.float('accuracy').defaultTo(null)
      t.enum('source', ['gps', 'cached', 'manual']).defaultTo('gps')
      t.timestamp('saved_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))

      t.foreign('uid', 'fk_location_user')
        .references('user_id')
        .inTable('users')
        .onDelete('CASCADE')
    })
  },

  // One row per user — upsert on uid (requires UNIQUE/PK on uid)
  upsert: async ({ uid, lat, lng, city, country, accuracy, source }) => {
    const row = {
      uid,
      lat,
      lng,
      city:     city     || null,
      country:  country  || null,
      accuracy: accuracy || null,
      source:   source   || 'gps',
    }

    return db(TABLE)
      .insert(row)
      .onConflict('uid')
      .merge({
        lat,
        lng,
        city:     row.city,
        country:  row.country,
        accuracy: row.accuracy,
        source:   row.source,
        saved_at: db.fn.now(),
      })
  },

  findByUid: async (uid) => {
    const row = await db(TABLE).where({ uid }).first()
    return row || null
  },

  // For admin map view — joins with users table
  getAll: async () => {
    return db({ ul: TABLE })
      .join({ u: 'users' }, 'ul.uid', 'u.user_id')
      .select(
        'ul.uid',
        'ul.lat',
        'ul.lng',
        'ul.city',
        'ul.country',
        'ul.saved_at',
        'u.full_name as name',
        'u.email',
      )
      .orderBy('ul.saved_at', 'desc')
  },
}

module.exports = Location
