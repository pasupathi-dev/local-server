// src/routes/locationRoutes.js
// ─────────────────────────────────────────────
// POST /api/location      → save user location
// GET  /api/location      → get my location
// GET  /api/location/all  → get all users' locations
// ─────────────────────────────────────────────

const express              = require('express')
const locationController   = require('../controllers/locationController')
const { verifyToken }      = require('../middleware/auth')
const { saveLocationRules } = require('../validators/locationValidator')
const { validate }         = require('../middleware/validate')

const router = express.Router()

// Save or update current user's location
router.post('/',    verifyToken, saveLocationRules, validate, locationController.save)

// Get current user's location
router.get('/',     verifyToken, locationController.get)

// Get all users' locations (admin)
router.get('/all',  verifyToken, locationController.getAll)

// Reverse-geocode lat/lng → address (Google Maps, 30-day cache)
router.post('/reverse-geocode', verifyToken, locationController.reverseGeocode)

// Place search typeahead — drives the "Change location" modal. Backed by
// Nominatim; safe to call on every keystroke (client debounces).
router.get('/search', verifyToken, locationController.search)

module.exports = router
