// src/controllers/locationController.js

const locationService    = require('../services/locationService')
const { reverseGeocode } = require('../services/geocodeService')
const { searchPlaces }   = require('../services/placeSearch')
const { success }        = require('../utils/response')

const locationController = {

  // POST /api/location
  // Body: { lat, lng, city, country, accuracy, source }
  save: async (req, res, next) => {
    try {
      const { lat, lng, city, country, accuracy, source } = req.body
      const uid = req.user.uid   // from verifyToken middleware

      const location = await locationService.saveLocation({
        uid, lat, lng,
        city:     city     || null,
        country:  country  || null,
        accuracy: accuracy || null,
        source:   source   || 'gps',
      })

      return res.status(200).json(
        success('Location saved', { location })
      )
    } catch (err) {
      next(err)
    }
  },

  // GET /api/location
  // Returns the current user's saved location
  get: async (req, res, next) => {
    try {
      const location = await locationService.getLocation(req.user.uid)
      return res.status(200).json(success('Location fetched', { location }))
    } catch (err) {
      next(err)
    }
  },

  // GET /api/location/all  (admin — all users' locations)
  getAll: async (req, res, next) => {
    try {
      const locations = await locationService.getAllLocations()
      return res.status(200).json(success('All locations fetched', { locations }))
    } catch (err) {
      next(err)
    }
  },

  // POST /api/location/reverse-geocode  { lat, lng }
  // Returns address + city for any coordinates. Cached for 30 days.
  reverseGeocode: async (req, res, next) => {
    try {
      const lat = Number(req.body?.lat)
      const lng = Number(req.body?.lng)
      const result = await reverseGeocode(lat, lng)
      return res.status(200).json(success('Reverse geocoded', result))
    } catch (err) { next(err) }
  },

  // GET /api/location/search?q=...&limit=...
  // Typeahead for the "Change location" modal. We return up to 30
  // candidates by default so the client can do its own scroll-based
  // pagination (5 at a time) without firing a new request per page.
  // Caller can override via `limit` query param (clamped to 1–50).
  search: async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim()
      if (q.length < 2) {
        return res.status(200).json(success('Place search', { results: [] }))
      }
      const reqLimit = Number(req.query.limit) || 30
      const limit = Math.max(1, Math.min(50, reqLimit))
      const results = await searchPlaces(q, { limit })
      return res.status(200).json(success('Place search', { results }))
    } catch (err) { next(err) }
  },
}

module.exports = locationController
