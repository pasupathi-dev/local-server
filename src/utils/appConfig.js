// Tiny in-memory cache around the app_config table. Avoids hitting the DB
// for every payment / request — values change rarely and a 60s staleness is
// fine for fee percentages and timer windows.

const { db } = require('../config/db')

const TTL_MS = 60_000
const cache = new Map() // key -> { value, expires }

async function getConfigRaw (key) {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value
  const row = await db('app_config').where({ key }).first()
  let value = null
  if (row) {
    try { value = JSON.parse(row.value) } catch { value = row.value }
  }
  cache.set(key, { value, expires: Date.now() + TTL_MS })
  return value
}

async function getConfigNumber (key, fallback = 0) {
  const v = await getConfigRaw(key)
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

async function getConfigBool (key, fallback = false) {
  const v = await getConfigRaw(key)
  return typeof v === 'boolean' ? v : fallback
}

function invalidate (key) {
  if (key) cache.delete(key); else cache.clear()
}

module.exports = { getConfigRaw, getConfigNumber, getConfigBool, invalidate }
