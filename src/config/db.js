// src/config/db.js
// Knex query builder using mysql2 as the driver.
// Use the exported `db` everywhere — never write raw SQL.

const knex = require('knex')

const db = knex({
  client: 'mysql2',
  connection: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     process.env.DB_PORT     || 3306,
    database: process.env.DB_NAME     || 'todo_app',
    user:     process.env.DB_USER     || 'root',
    password: process.env.DB_PASSWORD || '',
    // Tells the mysql2 DRIVER to serialize JS Date objects as UTC strings
    // and to interpret returned TIMESTAMPs as UTC. This alone is NOT enough
    // — the MySQL SESSION timezone (set via the afterCreate hook below)
    // must also be UTC, otherwise MySQL interprets the incoming UTC string
    // in the OS timezone and stores a value shifted by the local offset.
    timezone: '+00:00',
  },
  pool: {
    min: 0,
    max: 10,
    // Force every pooled connection into UTC so NOW() and stored TIMESTAMPs
    // agree with the values knex inserts. Without this, the request-expiry
    // cron compares an honestly-UTC `expires_at` against an OS-local NOW()
    // and incorrectly expires fresh requests on its very next tick (e.g.
    // a 60-second request would vanish on the partner side at the cron's
    // next 60s heartbeat regardless of how much time was actually left).
    afterCreate: (conn, done) => {
      conn.query("SET time_zone = '+00:00'", (err) => done(err, conn))
    },
  },
})

const testConnection = async () => {
  try {
    await db.raw('SELECT 1')
    console.log('✅ MySQL connected successfully (knex + mysql2)')
  } catch (err) {
    console.error('❌ MySQL connection failed:', err.message)
    process.exit(1)
  }
}

module.exports = { db, testConnection }
