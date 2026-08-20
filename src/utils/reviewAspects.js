// H60 — Aspect chip vocabulary. Mirrored on the client at
// `client/src/utils/reviewAspects.js`. Keep both lists in sync.
//
// Positive chips appear after a 4★ or 5★ pick; negative chips after a
// 1–3★ pick. Slugs are persisted on the review row; labels are presentation.

const POSITIVE = [
  { slug: 'on_time',     label: 'On time' },
  { slug: 'clean_work',  label: 'Clean work' },
  { slug: 'fair_price',  label: 'Fair price' },
  { slug: 'friendly',    label: 'Friendly' },
  { slug: 'prepared',    label: 'Prepared' },
]
const NEGATIVE = [
  { slug: 'late',         label: 'Late' },
  { slug: 'overcharged',  label: 'Overcharged' },
  { slug: 'untidy',       label: 'Untidy' },
]

const ALL_SLUGS = new Set([...POSITIVE, ...NEGATIVE].map((c) => c.slug))

// Returns the chips applicable for a given star rating. >= 4 stars gets
// positive chips, anything else gets negative.
const chipsFor = (stars) => (Number(stars) >= 4 ? POSITIVE : NEGATIVE)

// Validate a tag array coming from the client. Drops unknown slugs so a
// stale client passing an old chip doesn't corrupt the row. Caps the
// array at 5 (the size of the longest list) so payloads stay bounded.
const sanitizeTags = (tags) => {
  if (!Array.isArray(tags)) return null
  const seen = new Set()
  const out = []
  for (const t of tags) {
    if (typeof t !== 'string') continue
    const slug = t.trim().toLowerCase()
    if (!ALL_SLUGS.has(slug) || seen.has(slug)) continue
    seen.add(slug); out.push(slug)
    if (out.length >= 5) break
  }
  return out.length ? out : null
}

const labelFor = (slug) => {
  const found = [...POSITIVE, ...NEGATIVE].find((c) => c.slug === slug)
  return found ? found.label : slug
}

module.exports = { POSITIVE, NEGATIVE, ALL_SLUGS, chipsFor, sanitizeTags, labelFor }
