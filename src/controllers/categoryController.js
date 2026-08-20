const Category = require('../models/Category')
const Work     = require('../models/Work')
const Partner  = require('../models/Partner')
const Job      = require('../models/Job')
const { db }   = require('../config/db')
const { success } = require('../utils/response')

const withDisplayName = (r) => ({ ...r, display_name: r.display_name || r.name })

// Derive the requester's city for the "booked X times this week in your area"
// social proof. Try the explicit query first, then the user's saved profile.
const cityFor = async (req) => {
  let city = String(req.query.city || '').trim() || null
  if (!city && req.user?.uid) {
    const u = await db('users').where({ user_id: req.user.uid }).first().catch(() => null)
    city = u?.city || null
  }
  return city
}

module.exports = {
  // GET /api/categories — active PARENT categories (sorted), each with a
  // rolled-up online-partner count and weekly-booking count.
  list: async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase()
      const city = await cityFor(req)
      const [rows, onlineCounts, weeklyCounts] = await Promise.all([
        Category.getAll(),
        Partner.onlineCountsByCategory(),
        Job.weeklyCountsByCategory({ city }),
      ])
      let enriched = rows.map((r) => ({
        ...withDisplayName(r),
        online_count:    onlineCounts[r.name] || 0,
        weekly_bookings: weeklyCounts[r.name] || 0,
      }))
      if (q) {
        enriched = enriched.filter((c) =>
          c.name.toLowerCase().includes(q)
          || c.display_name.toLowerCase().includes(q),
        )
      }
      res.json(success('Categories', {
        categories: enriched,
        online_counts: onlineCounts,
        weekly_bookings: weeklyCounts,
      }))
    } catch (err) { next(err) }
  },

  // GET /api/categories/:category/works  — active works under one parent, each
  // with per-work online + weekly counts. `:category` is the parent name.
  works: async (req, res, next) => {
    try {
      const category = String(req.params.category || '').trim()
      const city = await cityFor(req)
      const [rows, workCounts, weeklyCounts] = await Promise.all([
        category ? Work.getByCategory(category) : Work.getAll(),
        Partner.onlineCountsByWork(),
        Job.weeklyCountsByWork({ city }),
      ])
      const works = rows.map((w) => ({
        ...withDisplayName(w),
        online_count:    workCounts[w.name] || 0,
        weekly_bookings: weeklyCounts[w.name] || 0,
      }))
      res.json(success('Works', { category, works, online_counts: workCounts }))
    } catch (err) { next(err) }
  },

  // GET /api/categories/search?q=elec&limit=5 — searches WORKS (the bookable
  // leaf) and returns each hit with its parent category for the two-step flow.
  search: async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim().toLowerCase()
      const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 5))
      if (!q) return res.json(success('Search', { hits: [], query: q }))

      const [rows, workCounts] = await Promise.all([
        Work.getAll(),
        Partner.onlineCountsByWork(),
      ])

      const hits = []
      for (const w of rows) {
        const name        = String(w.name || '')
        const displayName = w.display_name || name
        if (name.toLowerCase().includes(q) || displayName.toLowerCase().includes(q)) {
          hits.push({
            type: 'work',
            work: name,
            category: w.category_name,
            display_name: displayName,
            icon: w.icon,
            pin_color: w.pin_color,
            online_count: workCounts[name] || 0,
          })
        }
        if (hits.length >= limit * 2) break
      }

      const score = (h) => {
        const target = String(h.display_name || h.work).toLowerCase()
        if (target === q) return 0
        if (target.startsWith(q)) return 1
        return 2
      }
      hits.sort((a, b) => score(a) - score(b))

      res.json(success('Search', { hits: hits.slice(0, limit), query: q }))
    } catch (err) { next(err) }
  },
}
