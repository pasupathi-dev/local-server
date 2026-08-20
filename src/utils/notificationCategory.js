// H53 — Maps a NOTIF_TYPES value to the user-facing category bucket used
// by the notifications tab bar (All / Jobs / Payments / Promos). Kept as
// a pure helper so it can be reused by the list endpoint, the socket
// emitter, and the push service without circular imports.
//
// 'jobs'     — anything tied to a request / scheduled job / review
// 'payments' — anything tied to money: bills, price changes, settlements
// 'promos'   — marketing / referral / discount blasts
//
// Anything we don't know about falls back to 'jobs' so it still shows up
// in the default "All" + "Jobs" tabs rather than silently disappearing.

const TYPE_CATEGORY = {
  job_completed:      'jobs',
  request_accepted:   'jobs',
  schedule_accepted:  'jobs',
  schedule_declined:  'jobs',
  schedule_cancelled: 'jobs',
  job_cancelled:      'jobs',
  new_review:         'jobs',
  // H54 — dispute + SOS are job-side, NOT marketing. Keeping them in
  // "jobs" means they survive a Mute Promos toggle.
  dispute_opened:     'jobs',
  safety_sos:         'jobs',
  price_updated:      'payments',
  payment_received:   'payments',
  promo:              'promos',
}

const CATEGORIES = ['jobs', 'payments', 'promos']

const categoryForType = (type) => TYPE_CATEGORY[type] || 'jobs'

const typesInCategory = (category) =>
  Object.entries(TYPE_CATEGORY).filter(([, c]) => c === category).map(([t]) => t)

module.exports = { categoryForType, typesInCategory, CATEGORIES, TYPE_CATEGORY }
