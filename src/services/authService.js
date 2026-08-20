// src/services/authService.js
// Business logic for auth + onboarding.

const User    = require('../models/User')
const Partner = require('../models/Partner')

const deriveInitials = (name, fallback = 'U') => {
  if (!name) return fallback
  const parts = String(name).trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0] || '').join('').toUpperCase() || fallback
}

const authService = {

  // Called right after Firebase login — upserts minimal record.
  syncUser: async ({ user_id, email, full_name, phone }) => {
    await User.upsert({ user_id, email, full_name, phone })
    return User.findByUid(user_id)
  },

  getProfile: async (uid) => {
    const user = await User.findByUid(uid)
    if (!user) throw Object.assign(new Error('User not found'), { statusCode: 404 })
    if (user.role === 'partner') {
      const partner = await Partner.findByUid(uid)
      return { ...user, partner }
    }
    return user
  },

  // Onboarding step 2 (both roles) — basic profile.
  saveBasicProfile: async (uid, { full_name, email, address, city, pincode, phone, avatar_class }) => {
    const patch = { full_name, email, address, city, pincode }
    if (phone) patch.phone = phone
    if (avatar_class) patch.avatar_class = avatar_class
    return User.update(uid, patch)
  },

  pickRole: async (uid, role) => {
    if (!['user','partner'].includes(role)) {
      throw Object.assign(new Error('Invalid role'), { statusCode: 400 })
    }
    await User.updateRole(uid, role)
    return User.findByUid(uid)
  },

  finishOnboarding: async (uid) => {
    await User.setOnboardingDone(uid, true)
    return User.findByUid(uid)
  },

  deriveInitials,
}

module.exports = authService
