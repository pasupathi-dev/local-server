const { db } = require('../config/db')
const TABLE  = 'scheduled_jobs'

// Converts "2026-04-20" + "09:00 AM" → JS Date object
function parseScheduledAt (schedule_date, time_slot) {
  if (!schedule_date || !time_slot) return null
  try {
    // Normalise the time slot: "09:00 AM" or "9:00AM" or "14:00"
    const combined = `${schedule_date} ${time_slot}`
    const d = new Date(combined)
    if (!isNaN(d.getTime())) return d

    // Fallback: manual parse for "HH:MM AM/PM"
    const match = String(time_slot).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i)
    if (!match) return null
    let [, hStr, mStr, meridiem] = match
    let h = parseInt(hStr, 10)
    const m = parseInt(mStr, 10)
    if (meridiem) {
      const upper = meridiem.toUpperCase()
      if (upper === 'PM' && h !== 12) h += 12
      if (upper === 'AM' && h === 12) h = 0
    }
    const [year, month, day] = schedule_date.split('-').map(Number)
    return new Date(year, month - 1, day, h, m, 0, 0)
  } catch {
    return null
  }
}

const ScheduledJob = {
  parseScheduledAt,

  create: async (payload) => {
    const scheduled_at = parseScheduledAt(payload.schedule_date, payload.time_slot)
    await db(TABLE).insert({ ...payload, scheduled_at: scheduled_at || null })
    return ScheduledJob.findById(payload.id)
  },

  findById: (id) => db(TABLE).where({ id }).first(),

  listForCustomer: (customer_id) => db(TABLE).where({ customer_id }).orderBy('schedule_date', 'asc'),
  listForPartner:  (partner_id)  => db(TABLE).where({ partner_id }).orderBy('schedule_date', 'asc'),

  setStatus: (id, status, extra = {}) => db(TABLE).where({ id }).update({ status, ...extra }),

  // Find accepted jobs whose scheduled_at falls within ±2 min of (NOW + minuteOffset minutes)
  // and the alertFlag column is still false.
  findAlertCandidates: (minuteOffset, alertFlag) =>
    db(TABLE)
      .where('status', 'accepted')
      .whereRaw(
        'scheduled_at BETWEEN DATE_ADD(NOW(), INTERVAL ? MINUTE) AND DATE_ADD(NOW(), INTERVAL ? MINUTE)',
        [minuteOffset - 2, minuteOffset + 2],
      )
      .where(alertFlag, false),

  // H80 — Conditional update: only flips the flag if it was still false.
  // Returns the number of rows updated (0 if another cron tick already
  // claimed it, 1 if this caller won). Keeps the fan-out single-flight
  // across multiple workers or overlapping ticks.
  markAlertSent: async (id, alertFlag) => {
    const updated = await db(TABLE)
      .where({ id })
      .where(alertFlag, false)
      .update({ [alertFlag]: true })
    return Number(updated || 0)
  },

  markStartSent: async (id) => {
    const updated = await db(TABLE)
      .where({ id })
      .where('alert_start_sent', false)
      .update({ alert_start_sent: true })
    return Number(updated || 0)
  },

  convertToJob: (id, job_id) =>
    db(TABLE).where({ id }).update({ status: 'converted', converted_job_id: job_id }),

  // Find accepted jobs that are overdue (>30 min past scheduled_at),
  // already had the start alert sent, but haven't been converted to a job yet.
  findOverdueCandidates: () =>
    db(TABLE)
      .where('status', 'accepted')
      .whereRaw('scheduled_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)')
      .where('alert_start_sent', true)
      .whereNull('converted_job_id'),
}

module.exports = ScheduledJob
