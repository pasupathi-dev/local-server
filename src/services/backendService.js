// src/services/backendService.js  (add to your FRONTEND project)
// ─────────────────────────────────────────────
// Calls our Express + MySQL backend.
// Always sends Firebase idToken in Authorization header.
// ─────────────────────────────────────────────

import apiClient from './apiClient'    // your existing axios instance
import { auth }  from './firebase'     // your existing firebase init

// ── Helper: get fresh Firebase token ─────────
// Firebase tokens expire every 1 hour.
// getIdToken(true) forces a refresh if needed.
const getAuthHeader = async () => {
  const token = await auth.currentUser?.getIdToken(true)
  if (!token) throw new Error('No authenticated user')
  return { Authorization: `Bearer ${token}` }
}

// Backend base URL — set in your frontend .env as:
// VITE_API_URL=http://localhost:5000
const API = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const backendService = {

  // ── Sync user to MySQL after Firebase login ──
  // Call this right after loginUser or registerUser succeeds.
  // Saves uid + email + name into our DB.
  syncUser: async (photoUrl = null) => {
    const headers = await getAuthHeader()
    const res = await fetch(`${API}/api/auth/sync`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body:    JSON.stringify({ photoUrl }),
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.message)
    return data.user
  },

  // ── Get my profile from MySQL ─────────────
  getMe: async () => {
    const headers = await getAuthHeader()
    const res = await fetch(`${API}/api/auth/me`, { headers })
    const data = await res.json()
    if (!data.success) throw new Error(data.message)
    return data.user
  },

  // ── Save my location to MySQL ─────────────
  // Call this after GPS fetch succeeds in HomePage.
  saveLocation: async ({ lat, lng, city, country, accuracy, source = 'gps' }) => {
    const headers = await getAuthHeader()
    const res = await fetch(`${API}/api/location`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body:    JSON.stringify({ lat, lng, city, country, accuracy, source }),
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.message)
    return data.location
  },

  // ── Get my saved location from MySQL ──────
  getMyLocation: async () => {
    const headers = await getAuthHeader()
    const res = await fetch(`${API}/api/location`, { headers })
    const data = await res.json()
    if (!data.success) throw new Error(data.message)
    return data.location
  },

  // ── Get all users' locations (admin) ──────
  getAllLocations: async () => {
    const headers = await getAuthHeader()
    const res = await fetch(`${API}/api/location/all`, { headers })
    const data = await res.json()
    if (!data.success) throw new Error(data.message)
    return data.locations
  },
}

export default backendService
