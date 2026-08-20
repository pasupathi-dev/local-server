// src/services/locationService.js

const Location = require('../models/Location')

const locationService = {

  // ── Save / update user location ───────────
  saveLocation: async ({ uid, lat, lng, city, country, accuracy, source }) => {
    await Location.upsert({ uid, lat, lng, city, country, accuracy, source })
    const saved = await Location.findByUid(uid)
    return saved
  },

  // ── Get location for a user ───────────────
  getLocation: async (uid) => {
    const location = await Location.findByUid(uid)
    if (!location) throw Object.assign(new Error('Location not found'), { statusCode: 404 })
    return location
  },

  // ── Get all user locations (admin) ────────
  getAllLocations: async () => {
    return await Location.getAll()
  },
}

module.exports = locationService
