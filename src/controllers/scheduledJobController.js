const ScheduledJob = require('../models/ScheduledJob')
const Job          = require('../models/Job')
const Work         = require('../models/Work')
const Message      = require('../models/Message')
const User         = require('../models/User')
const Partner      = require('../models/Partner')
const ActivityLog  = require('../models/ActivityLog')
const Notification = require('../models/Notification')
const { success }  = require('../utils/response')
const { scheduleId, jobId, initials } = require('../utils/ids')
const { emitToUser } = require('../realtime/io')
const push = require('../services/pushService')
const { getConfigNumber } = require('../utils/appConfig')

module.exports = {
  // POST /api/schedule
  // L52 — optional `advance_amount` lets the customer commit to a
  // partial pre-payment so the slot is firm. We just record the
  // commitment here; the actual Razorpay flow is a follow-up (the row
  // exposes `advance_amount` so the partner can require it before
  // accepting if/when the policy is enabled).
  create: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const {
        partner_id, service, service_icon, base_price,
        schedule_date, time_slot, notes,
        advance_amount,
      } = req.body || {}
      // `work_name` is the bookable leaf; `category_name` accepted as legacy alias.
      const work_name = req.body?.work_name || req.body?.category_name || null
      if (!partner_id || !work_name || !service || !schedule_date || !time_slot) {
        return res.status(400).json({ success: false, message: 'Missing fields' })
      }
      // Resolve the parent category for the chosen work (falls back to the
      // work name itself if it isn't a known work — e.g. dirty/legacy input).
      const category_name = (await Work.parentOf(work_name)) || req.body?.category_name || work_name
      // M83 — Refuse bookings on dates the partner has blocked.
      const { isPartnerBlockedOn } = require('./partnerBlockedDatesController')
      if (await isPartnerBlockedOn(partner_id, schedule_date)) {
        return res.status(409).json({
          success: false,
          code: 'partner_blocked_date',
          message: 'The partner isn\'t available on that day. Try another date.',
        })
      }
      const c = await User.findByUid(customer_id)
      const p = await User.findByUid(partner_id)

      // L52 — clamp the advance to a sane fraction of base_price.
      const basePriceN = Number(base_price) || 0
      const rawAdv = Number(advance_amount)
      const safeAdv = Number.isFinite(rawAdv) && rawAdv > 0
        ? Math.min(Math.round(rawAdv), Math.max(1, basePriceN))
        : null

      const id = scheduleId()
      const row = {
        id, customer_id, partner_id,
        category_name, work_name, service, service_icon: service_icon || null,
        base_price: basePriceN,
        schedule_date, time_slot, notes: notes || null,
        status: 'pending',
        advance_amount: safeAdv,
        customer_name: c?.full_name, customer_initials: initials(c?.full_name),
        customer_av_class: c?.avatar_class, customer_phone: c?.phone, customer_address: c?.address,
        partner_name: p?.full_name, partner_initials: initials(p?.full_name), partner_av_class: p?.avatar_class,
      }
      const sj = await ScheduledJob.create(row)
      emitToUser(partner_id, 'schedule:incoming', sj)
      res.status(201).json(success('Scheduled', { scheduled: sj }))
    } catch (err) { next(err) }
  },

  // GET /api/schedule/mine  — role-aware
  mine: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const list = req.query.as === 'partner'
        ? await ScheduledJob.listForPartner(uid)
        : await ScheduledJob.listForCustomer(uid)
      res.json(success('Scheduled', { scheduled: list }))
    } catch (err) { next(err) }
  },

  // POST /api/schedule/:id/accept (partner)
  accept: async (req, res, next) => {
    try {
      const sj = await ScheduledJob.findById(req.params.id)
      if (!sj || sj.partner_id !== req.user.uid) return res.status(403).json({ success: false, message: 'Forbidden' })
      await ScheduledJob.setStatus(sj.id, 'accepted')
      emitToUser(sj.customer_id, 'schedule:accepted', { id: sj.id })
      await Notification.create({
        user_id: sj.customer_id, type: 'schedule_accepted',
        title: 'Schedule accepted', body: `${sj.partner_name} accepted your ${sj.service} on ${sj.schedule_date}`,
        icon: '📅', icon_bg: '#dbeafe',
        route: '/scheduled',
      })
      await ActivityLog.add({ partner_id: sj.partner_id, type: 'schedule_accepted',
        title: 'Schedule accepted', sub: `${sj.service} · ${sj.schedule_date}`, icon: '📅', color: '#2563eb' })
      res.json(success('Accepted'))
    } catch (err) { next(err) }
  },

  // POST /api/schedule/:id/decline (partner)
  decline: async (req, res, next) => {
    try {
      const sj = await ScheduledJob.findById(req.params.id)
      if (!sj || sj.partner_id !== req.user.uid) return res.status(403).json({ success: false, message: 'Forbidden' })
      await ScheduledJob.setStatus(sj.id, 'declined', { cancel_reason: req.body?.reason || null })
      emitToUser(sj.customer_id, 'schedule:declined', { id: sj.id, reason: req.body?.reason })
      await ActivityLog.add({ partner_id: sj.partner_id, type: 'schedule_declined',
        title: 'Schedule declined', sub: `${sj.service}`, icon: '✖️', color: '#dc2626' })
      res.json(success('Declined'))
    } catch (err) { next(err) }
  },

  // POST /api/schedule/:id/cancel (either side)
  cancel: async (req, res, next) => {
    try {
      const sj = await ScheduledJob.findById(req.params.id)
      if (!sj) return res.status(404).json({ success: false, message: 'Not found' })
      if (sj.customer_id !== req.user.uid && sj.partner_id !== req.user.uid) return res.status(403).json({ success: false, message: 'Forbidden' })
      const cancelled_by = req.user.uid === sj.customer_id ? 'user' : 'partner'
      await ScheduledJob.setStatus(sj.id, 'cancelled', {
        cancel_reason: req.body?.reason || null,
        cancel_note:   req.body?.note || null,
        cancelled_by,
      })
      const target = cancelled_by === 'user' ? sj.partner_id : sj.customer_id
      emitToUser(target, 'schedule:cancelled', { id: sj.id, cancelled_by, reason: req.body?.reason })
      await ActivityLog.add({ partner_id: sj.partner_id, type: 'schedule_cancelled',
        title: 'Schedule cancelled', sub: `${sj.service} · ${req.body?.reason || ''}`, icon: '🚫', color: '#dc2626' })
      res.json(success('Cancelled'))
    } catch (err) { next(err) }
  },

  // POST /api/schedule/:id/reschedule  { date, slot, note }
  // M82 — Either side proposes a new date/slot for an already-accepted
  // scheduled job. Allowed up to 4 hours before the current start. The
  // OTHER side gets a notification and can accept/decline. We don't
  // mutate the existing schedule_date/time_slot yet — only the proposed_*
  // columns. Accept moves them in atomically; Decline just clears.
  proposeReschedule: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const sj = await ScheduledJob.findById(req.params.id)
      if (!sj) return res.status(404).json({ success: false, message: 'Not found' })
      if (sj.customer_id !== uid && sj.partner_id !== uid) {
        return res.status(403).json({ success: false, message: 'Not your booking' })
      }
      if (sj.status !== 'accepted') {
        return res.status(409).json({ success: false, message: 'Only confirmed bookings can be rescheduled' })
      }
      // Reschedule lock-out window — admin-tunable (reschedule_lock_hours).
      if (sj.scheduled_at) {
        const lockHours = await getConfigNumber('reschedule_lock_hours', 4)
        const lockBefore = new Date(new Date(sj.scheduled_at).getTime() - lockHours * 60 * 60 * 1000)
        if (new Date() > lockBefore) {
          return res.status(409).json({
            success: false, code: 'reschedule_window_closed',
            message: `Rescheduling is only allowed up to ${lockHours} hours before the start time.`,
          })
        }
      }
      // Block a second proposal while one is still pending.
      if (sj.reschedule_proposed_at) {
        return res.status(409).json({
          success: false, code: 'reschedule_pending',
          message: 'A reschedule proposal is already pending — wait for the other side to respond.',
        })
      }

      const date = String(req.body?.date || '').trim().slice(0, 30)
      const slot = String(req.body?.slot || '').trim().slice(0, 30)
      const note = String(req.body?.note || '').trim().slice(0, 500)
      if (!date || !slot) {
        return res.status(400).json({ success: false, message: 'Pick a new date and time slot' })
      }
      const role = uid === sj.customer_id ? 'user' : 'partner'

      await ScheduledJob.setStatus(sj.id, sj.status, {
        reschedule_proposed_date: date,
        reschedule_proposed_slot: slot,
        reschedule_proposed_by:   role,
        reschedule_proposed_at:   new Date(),
        reschedule_note:          note || null,
      })
      const fresh = await ScheduledJob.findById(sj.id)

      const other  = role === 'user' ? sj.partner_id : sj.customer_id
      const otherRoute = role === 'user' ? '/partner/scheduled' : '/scheduled'
      const proposerName = role === 'user' ? (sj.customer_name || 'Customer') : (sj.partner_name || 'Partner')

      emitToUser(other, 'schedule:reschedule-proposed', { id: sj.id, schedule: fresh })
      await Notification.create({
        user_id: other, type: 'schedule_accepted',
        title: `Reschedule requested · ${sj.service}`,
        body:  `${proposerName} suggests ${date} · ${slot}${note ? ` — ${note.slice(0, 80)}` : ''}`,
        icon:  '🔁', icon_bg: '#dbeafe',
        route: otherRoute,
      }).catch(() => {})
      push.sendToUser(other, {
        title: `Reschedule requested · ${sj.service}`,
        body:  `${proposerName} suggests ${date} · ${slot}`,
        data: { type: 'schedule:reschedule-proposed', scheduleId: sj.id, route: otherRoute, urgent: 'true' },
      }).catch(() => {})

      res.json(success('Reschedule proposed', { schedule: fresh }))
    } catch (err) { next(err) }
  },

  // POST /api/schedule/:id/reschedule/respond   { action: 'accept' | 'decline' }
  // M82 — Other side accepts or declines a pending reschedule proposal.
  // Only the side that did NOT propose can respond.
  respondReschedule: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const sj = await ScheduledJob.findById(req.params.id)
      if (!sj) return res.status(404).json({ success: false, message: 'Not found' })
      if (sj.customer_id !== uid && sj.partner_id !== uid) {
        return res.status(403).json({ success: false, message: 'Not your booking' })
      }
      if (!sj.reschedule_proposed_at) {
        return res.status(409).json({ success: false, message: 'No pending reschedule proposal' })
      }
      const myRole = uid === sj.customer_id ? 'user' : 'partner'
      if (sj.reschedule_proposed_by === myRole) {
        return res.status(403).json({ success: false, message: 'Only the other side can respond.' })
      }
      const action = String(req.body?.action || '').toLowerCase()
      if (!['accept', 'decline'].includes(action)) {
        return res.status(400).json({ success: false, message: 'Pick accept or decline' })
      }

      if (action === 'accept') {
        const newDate = sj.reschedule_proposed_date
        const newSlot = sj.reschedule_proposed_slot
        const newScheduledAt = ScheduledJob.parseScheduledAt(newDate, newSlot)
        await ScheduledJob.setStatus(sj.id, 'accepted', {
          schedule_date: newDate,
          time_slot:     newSlot,
          scheduled_at:  newScheduledAt || null,
          // Reset alert flags so the cron re-fires reminders for the new time.
          alert_24h_sent:   false,
          alert_1h_sent:    false,
          alert_15m_sent:   false,
          alert_start_sent: false,
          reschedule_proposed_date: null,
          reschedule_proposed_slot: null,
          reschedule_proposed_by:   null,
          reschedule_proposed_at:   null,
          reschedule_note:          null,
        })
      } else {
        await ScheduledJob.setStatus(sj.id, 'accepted', {
          reschedule_proposed_date: null,
          reschedule_proposed_slot: null,
          reschedule_proposed_by:   null,
          reschedule_proposed_at:   null,
          reschedule_note:          null,
        })
      }
      const fresh = await ScheduledJob.findById(sj.id)

      // Notify the proposer.
      const proposer = sj.reschedule_proposed_by === 'user' ? sj.customer_id : sj.partner_id
      const proposerRoute = sj.reschedule_proposed_by === 'user' ? '/scheduled' : '/partner/scheduled'
      const verb = action === 'accept' ? 'accepted' : 'declined'
      emitToUser(proposer, 'schedule:reschedule-responded', { id: sj.id, action, schedule: fresh })
      await Notification.create({
        user_id: proposer, type: 'schedule_accepted',
        title:   `Reschedule ${verb} · ${sj.service}`,
        body:    action === 'accept'
          ? `New time confirmed: ${fresh.schedule_date} · ${fresh.time_slot}`
          : 'The other side kept the original time.',
        icon: action === 'accept' ? '✅' : '↩️',
        icon_bg: action === 'accept' ? '#dcfce7' : '#fef3c7',
        route: proposerRoute,
      }).catch(() => {})
      push.sendToUser(proposer, {
        title: `Reschedule ${verb} · ${sj.service}`,
        body:  action === 'accept'
          ? `New time confirmed: ${fresh.schedule_date} · ${fresh.time_slot}`
          : 'The other side kept the original time.',
        data: { type: 'schedule:reschedule-responded', scheduleId: sj.id, route: proposerRoute, urgent: 'true' },
      }).catch(() => {})

      res.json(success(`Reschedule ${verb}`, { schedule: fresh }))
    } catch (err) { next(err) }
  },

  // POST /api/schedule/:id/start (partner only)
  // Converts an accepted scheduled job into a live job — same flow as request accept.
  start: async (req, res, next) => {
    try {
      const partner_id = req.user.uid
      const sj = await ScheduledJob.findById(req.params.id)
      if (!sj) return res.status(404).json({ success: false, message: 'Not found' })
      if (sj.partner_id !== partner_id) return res.status(403).json({ success: false, message: 'Forbidden' })
      if (sj.status !== 'accepted') {
        return res.status(409).json({ success: false, message: 'Job is not in accepted state' })
      }

      // Allow starting up to 30 minutes before the scheduled time.
      const scheduledAt = sj.scheduled_at ? new Date(sj.scheduled_at) : null
      if (scheduledAt) {
        const nowPlus30 = new Date(Date.now() + 30 * 60 * 1000)
        if (scheduledAt > nowPlus30) {
          return res.status(409).json({
            success: false,
            message: 'Too early — you can start up to 30 minutes before the scheduled time',
          })
        }
      }

      // Prevent starting if partner already has an active job. Use the
      // BLOCKING variant so a 'completed' (waiting-for-payment) job
      // doesn't gate them from starting a scheduled one.
      const activeJob = await Job.findBlockingForPartner(partner_id)
      if (activeJob) {
        return res.status(409).json({ success: false, message: 'Finish your active job first' })
      }

      // Fetch partner profile for snapshot fields
      const pUser   = await User.findByUid(partner_id)
      const partner = await Partner.findByUid(partner_id)

      const id = jobId()
      const jobPayload = {
        id,
        request_id:    null,         // originated from schedule, not a request
        customer_id:   sj.customer_id,
        partner_id,
        category_name: sj.category_name,
        work_name:     sj.work_name,
        service:       sj.service,
        service_icon:  sj.service_icon,
        base_price:    sj.base_price,
        agreed_price:  sj.base_price,
        tip_amount:    0,
        distance_km:   null,
        notes:         sj.notes,
        // Firm pricing — schedule was booked at a known price, no negotiation.
        state:         'priceConfirmed',
        // customer snapshot from the scheduled job
        customer_name:     sj.customer_name,
        customer_initials: sj.customer_initials,
        customer_av_class: sj.customer_av_class,
        customer_phone:    sj.customer_phone,
        customer_address:  sj.customer_address,
        customer_email:    null,
        customer_lat:      null,
        customer_lng:      null,
        // partner snapshot
        partner_name:     pUser?.full_name     || sj.partner_name,
        partner_initials: initials(pUser?.full_name) || sj.partner_initials,
        partner_av_class: pUser?.avatar_class  || sj.partner_av_class,
        partner_city:     pUser?.city          || null,
      }

      const createdJob = await Job.create(jobPayload)

      // Single greeting that confirms the price — matches the new firm-price
      // accept flow in requestController. Mid-job scope changes still go
      // through proposePrice + the price-update attachment.
      await Message.create({
        job_id: id, sender_id: partner_id, sender_role: 'partner',
        sender_initials: jobPayload.partner_initials,
        body: `Hi ${jobPayload.customer_name || 'there'}! I'm on my way for your scheduled ${jobPayload.service}. Confirmed price: ₹${jobPayload.agreed_price}.`,
      })

      // Mark the scheduled job as converted
      await ScheduledJob.convertToJob(sj.id, id)

      // Take partner offline while they are on this job
      await Partner.setOnline(partner_id, false)

      // Realtime events
      emitToUser(sj.customer_id, 'schedule:converted', { id: sj.id, job: createdJob })
      emitToUser(partner_id,     'schedule:converted', { id: sj.id, job: createdJob })
      // Trigger customer's active-job screen the same way an instant accept does
      emitToUser(sj.customer_id, 'request:accepted', { requestId: null, job: createdJob })
      // Pause partner's incoming request feed
      emitToUser(partner_id, 'partner:online-ack', { online: false })

      // Notifications
      await Notification.create({
        user_id: sj.customer_id, type: 'schedule_accepted',
        title: 'Your scheduled job has started',
        body: `${jobPayload.partner_name} has started your ${jobPayload.service} appointment`,
        icon: '🚀', icon_bg: '#dcfce7',
        route: `/chat/${id}`,
      })

      try {
        await ActivityLog.add({
          partner_id, type: 'schedule_accepted',
          title: 'Started scheduled job',
          sub: `${jobPayload.customer_name} · ${jobPayload.service}`,
          icon: '🚀', color: '#059669',
          job_id: id, customer_name: jobPayload.customer_name, amount: jobPayload.base_price,
        })
      } catch { /* non-fatal */ }

      res.json(success('Scheduled job started', { job: createdJob }))
    } catch (err) { next(err) }
  },
}

// ─── Schedule Alert Cron ────────────────────────────────────────────────────
//
// Called every 60 seconds from server.js.
// Fires socket events + in-app notifications for T-24h, T-1h, T-15m,
// T=0 (start-now), and overdue (>30 min past).

const ALERT_WINDOWS = [
  { offset: 1440, flag: 'alert_24h_sent', label: '24h'  },
  { offset: 60,   flag: 'alert_1h_sent',  label: '1h'   },
  { offset: 15,   flag: 'alert_15m_sent', label: '15m'  },
]

async function fireScheduleAlerts () {
  // --- T-24h, T-1h, T-15m reminder alerts ---
  for (const { offset, flag, label } of ALERT_WINDOWS) {
    let candidates
    try {
      candidates = await ScheduledJob.findAlertCandidates(offset, flag)
    } catch {
      continue
    }

    for (const sj of candidates) {
      try {
        // H80 — Conditional mark: only proceed if we're the first tick to
        // claim this alert. Stops duplicate notifications when two cron
        // workers (or overlapping ticks) hit the same row.
        const claimed = await ScheduledJob.markAlertSent(sj.id, flag)
        if (!claimed) continue

        const payload = {
          id:           sj.id,
          type:         label,
          scheduled_at: sj.scheduled_at,
          service:      sj.service,
          partner_name: sj.partner_name,
          customer_name: sj.customer_name,
        }

        emitToUser(sj.customer_id, 'schedule:alert', { ...payload, partner_name: sj.partner_name })
        emitToUser(sj.partner_id,  'schedule:alert', { ...payload, customer_name: sj.customer_name })

        const reminderText = label === '24h' ? '24 hours'
          : label === '1h'  ? '1 hour'
          : '15 minutes'

        await Notification.create({
          user_id:  sj.customer_id,
          type:     'schedule_accepted',
          title:    `Reminder: ${sj.service} in ${reminderText}`,
          body:     `Your appointment with ${sj.partner_name} starts in ${reminderText}`,
          icon:     '⏰', icon_bg: '#dbeafe',
          route:    '/scheduled',
        }).catch(() => {})

        await Notification.create({
          user_id:  sj.partner_id,
          type:     'schedule_accepted',
          title:    `Reminder: ${sj.service} in ${reminderText}`,
          body:     `Your appointment with ${sj.customer_name} starts in ${reminderText}`,
          icon:     '⏰', icon_bg: '#dbeafe',
          route:    '/partner/scheduled',
        }).catch(() => {})

        // H80 — FCM push so the reminder lands on the lock screen too. The
        // T-15m reminder is treated as urgent so it survives Quiet Hours.
        const urgent = label === '15m'
        push.sendToUser(sj.customer_id, {
          title: `Reminder: ${sj.service} in ${reminderText}`,
          body:  `Your appointment with ${sj.partner_name} starts in ${reminderText}`,
          data: {
            type: 'schedule_accepted',
            scheduleId: sj.id,
            route: '/scheduled',
            ...(urgent ? { urgent: 'true' } : {}),
          },
        }).catch(() => {})
        push.sendToUser(sj.partner_id, {
          title: `Reminder: ${sj.service} in ${reminderText}`,
          body:  `Your appointment with ${sj.customer_name} starts in ${reminderText}`,
          data: {
            type: 'schedule_accepted',
            scheduleId: sj.id,
            route: '/partner/scheduled',
            ...(urgent ? { urgent: 'true' } : {}),
          },
        }).catch(() => {})
      } catch { /* keep iterating */ }
    }
  }

  // --- T=0 start-now alert (partner gets action button, customer gets info) ---
  let startCandidates
  try {
    startCandidates = await ScheduledJob.findAlertCandidates(0, 'alert_start_sent')
  } catch {
    startCandidates = []
  }

  for (const sj of startCandidates) {
    try {
      // H80 — Single-flight start mark.
      const claimed = await ScheduledJob.markStartSent(sj.id)
      if (!claimed) continue

      const basePayload = {
        id:           sj.id,
        scheduled_at: sj.scheduled_at,
        service:      sj.service,
        category_name: sj.category_name,
        base_price:   sj.base_price,
        partner_name: sj.partner_name,
        customer_name: sj.customer_name,
        customer_phone:   sj.customer_phone,
        customer_address: sj.customer_address,
      }

      // Partner receives the special start-now event (triggers Start button in UI)
      emitToUser(sj.partner_id, 'schedule:start-now', basePayload)

      // Customer receives a generic "now" alert
      emitToUser(sj.customer_id, 'schedule:alert', {
        id:           sj.id,
        type:         'now',
        scheduled_at: sj.scheduled_at,
        service:      sj.service,
        partner_name: sj.partner_name,
      })

      await Notification.create({
        user_id:  sj.customer_id,
        type:     'schedule_accepted',
        title:    `${sj.service} is starting now`,
        body:     `Your appointment with ${sj.partner_name} is about to begin`,
        icon:     '🚀', icon_bg: '#dcfce7',
        route:    '/scheduled',
      }).catch(() => {})

      await Notification.create({
        user_id:  sj.partner_id,
        type:     'schedule_accepted',
        title:    `Time to start: ${sj.service}`,
        body:     `Your appointment with ${sj.customer_name} is now — tap to start`,
        icon:     '🚀', icon_bg: '#dcfce7',
        route:    '/partner/scheduled',
      }).catch(() => {})

      // H80 — FCM push for the T=0 start cue. Always urgent — this is the
      // alert most likely to prevent a no-show.
      push.sendToUser(sj.customer_id, {
        title: `${sj.service} is starting now`,
        body:  `Your appointment with ${sj.partner_name} is about to begin`,
        data:  { type: 'schedule_accepted', scheduleId: sj.id, route: '/scheduled', urgent: 'true' },
      }).catch(() => {})
      push.sendToUser(sj.partner_id, {
        title: `Time to start: ${sj.service}`,
        body:  `Your appointment with ${sj.customer_name} is now — tap to start`,
        data:  { type: 'schedule_accepted', scheduleId: sj.id, route: '/partner/scheduled', urgent: 'true' },
      }).catch(() => {})
    } catch { /* keep iterating */ }
  }

  // --- Overdue alert (>30 min past scheduled_at, not yet converted) ---
  let overdueCandidates
  try {
    overdueCandidates = await ScheduledJob.findOverdueCandidates()
  } catch {
    overdueCandidates = []
  }

  for (const sj of overdueCandidates) {
    try {
      const payload = {
        id:           sj.id,
        type:         'overdue',
        scheduled_at: sj.scheduled_at,
        service:      sj.service,
        partner_name: sj.partner_name,
        customer_name: sj.customer_name,
      }
      emitToUser(sj.customer_id, 'schedule:alert', payload)
      emitToUser(sj.partner_id,  'schedule:alert', payload)
    } catch { /* keep iterating */ }
  }
}

module.exports.fireScheduleAlerts = fireScheduleAlerts
