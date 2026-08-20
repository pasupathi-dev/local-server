const { db } = require('../config/db')
const { sanitizeTags, POSITIVE, NEGATIVE } = require('../utils/reviewAspects')
const TABLE  = 'reviews'
const CRT    = 'customer_ratings'

// MySQL JSON columns come back as a string in some driver versions and as
// a parsed array in others. Normalise so callers always see an array.
const parseTags = (raw) => {
  if (!raw) return null
  if (Array.isArray(raw)) return raw
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null } catch { return null }
}
const decorate = (row) => row && { ...row, tags: parseTags(row.tags) }
const decorateAll = (rows) => rows.map(decorate)

const Review = {
  create: async ({ job_id, customer_id, partner_id, stars, comment, tags,
                    reviewer_initials, reviewer_name, reviewer_avatar_url }) => {
    const cleanTags = sanitizeTags(tags)
    await db(TABLE).insert({
      job_id, customer_id, partner_id, stars, comment: comment || null,
      tags: cleanTags ? JSON.stringify(cleanTags) : null,
      reviewer_initials:   reviewer_initials || null,
      reviewer_name:       reviewer_name || null,
      reviewer_avatar_url: reviewer_avatar_url || null,
    })
    return Review.findForJob(job_id)
  },

  findForJob:     async (job_id)  => decorate(await db(TABLE).where({ job_id }).first()),
  findById:       async (id)      => decorate(await db(TABLE).where({ id }).first()),
  listForPartner: async (partner_id) =>
    decorateAll(await db(TABLE).where({ partner_id }).orderBy('created_at', 'desc')),

  // Paginated reviews for a partner — used by the partner-detail page so each
  // page click becomes one network round-trip instead of fetching the full
  // history up-front. Returns { rows, total } so the caller can compute
  // total pages without a second query.
  pageForPartner: async (partner_id, { offset = 0, limit = 5 } = {}) => {
    const safeOffset = Math.max(0, Number(offset) || 0)
    const safeLimit  = Math.min(50, Math.max(1, Number(limit) || 5))
    const [rows, totalRow] = await Promise.all([
      db(TABLE).where({ partner_id }).orderBy('created_at', 'desc')
        .offset(safeOffset).limit(safeLimit),
      db(TABLE).where({ partner_id }).count({ c: '*' }).first(),
    ])
    return { rows: decorateAll(rows), total: Number(totalRow?.c || 0), offset: safeOffset, limit: safeLimit }
  },

  partnerAggregate: async (partner_id) => {
    const r = await db(TABLE).where({ partner_id }).avg({ avg: 'stars' }).count({ c: '*' }).first()
    return { rating_avg: Number(r?.avg || 0), rating_count: Number(r?.c || 0) }
  },

  // Per-partner star histogram — { 5:N, 4:N, 3:N, 2:N, 1:N } plus total.
  // Drives the five distribution bars on the partner detail page.
  ratingDistribution: async (partner_id) => {
    const rows = await db(TABLE).where({ partner_id })
      .select('stars').count({ n: '*' }).groupBy('stars')
    const counts = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
    let total = 0
    for (const r of rows) {
      const s = Number(r.stars)
      const n = Number(r.n) || 0
      if (s >= 1 && s <= 5) { counts[s] = n; total += n }
    }
    return { counts, total }
  },

  // H60 — Aspect aggregate: how often each chip slug appears, as a percent
  // of the partner's total reviews. Returns one entry per known slug so
  // the UI can render every chip even when 0% (e.g. "Late 0%").
  // Cheap: one full-table fetch of the partner's tags column, then count
  // in JS. We do NOT push the aggregation into SQL because MySQL JSON
  // operators are awkward across driver versions.
  aspectStats: async (partner_id) => {
    const rows = await db(TABLE).where({ partner_id }).select('tags')
    let total = 0
    const counts = {}
    for (const r of rows) {
      total += 1
      const tags = parseTags(r.tags)
      if (!tags) continue
      for (const slug of tags) {
        counts[slug] = (counts[slug] || 0) + 1
      }
    }
    // Convert to { slug: { count, pct } } for every known chip. Only
    // include chips actually used so the UI doesn't show "Late 0%"
    // unsolicited.
    const out = {}
    for (const slug of Object.keys(counts)) {
      out[slug] = { count: counts[slug], pct: total ? Math.round((counts[slug] / total) * 100) : 0 }
    }
    return { stats: out, total }
  },

  // M61 — partner sets the reply on their own review row.
  setPartnerReply: async (id, reply) => {
    await db(TABLE).where({ id }).update({
      partner_reply: reply,
      partner_reply_at: db.fn.now(),
    })
    return Review.findById(id)
  },

  // M62 — private "what went wrong" note attached after a low review.
  setSupportNote: async (id, note) => {
    await db(TABLE).where({ id }).update({
      support_note: note,
      support_note_at: db.fn.now(),
    })
    return Review.findById(id)
  },

  // L63 — refresh the denormalised top-quote on the partners row. Called
  // from the create handler after a new review lands. We pick the most
  // recent 5★ (then 4★) review with a non-empty comment so the card has
  // something readable to surface.
  refreshTopQuote: async (partner_id) => {
    const top = await db(TABLE).where({ partner_id })
      .whereNotNull('comment')
      .where('stars', '>=', 4)
      .orderBy('stars', 'desc')
      .orderBy('created_at', 'desc')
      .first()
    if (!top) return null
    // Take the first sentence (or 120 chars) so the card stays compact.
    const raw = String(top.comment || '').trim()
    const firstSentence = raw.split(/[.\n]/)[0].trim()
    const quote = (firstSentence || raw).slice(0, 120)
    if (!quote) return null
    await db('partners').where({ user_id: partner_id }).update({
      top_review_quote: quote,
      top_review_at: top.created_at || db.fn.now(),
    })
    return quote
  },

  // Partner rating of customer
  createCustomerRating: async ({ job_id, partner_id, customer_id, stars, comment }) => {
    await db(CRT).insert({ job_id, partner_id, customer_id, stars, comment: comment || null })
  },
  findCustomerRatingForJob: (job_id) => db(CRT).where({ job_id }).first(),
  listCustomerRatingsFor: (customer_id) => db(CRT).where({ customer_id }).orderBy('created_at', 'desc'),
}

module.exports = Review
module.exports.ASPECT_POSITIVE = POSITIVE
module.exports.ASPECT_NEGATIVE = NEGATIVE
