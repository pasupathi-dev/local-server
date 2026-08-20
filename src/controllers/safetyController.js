// Safety endpoints — SOS + share-trip + public live tracking.
//
//   POST /api/safety/sos          { job_id, lat?, lng?, note? }     (customer)
//   POST /api/safety/share-trip   { job_id, contact_phone, contact_name? } (customer)
//   GET  /api/safety/track/:token                                   (public)
//
// The public track endpoint is unauth'd because the link is shared with a
// third party (e.g. a friend). We only expose the partner's last-known
// location while the job is in motion (travelling/arrived), the partner's
// display name, and the customer's contact name. No phone numbers, no
// address text.

const crypto    = require('crypto')
const { db }    = require('../config/db')
const Job       = require('../models/Job')
const Notification = require('../models/Notification')
const { success } = require('../utils/response')
const { emitToUser, emitGlobal } = require('../realtime/io')
const sms  = require('../services/smsService')
const push = require('../services/pushService')

// Public origin used when building the share link sent over SMS. Falls back
// to PUBLIC_URL → CLIENT_URL → http://localhost:5173 in that order.
const publicOrigin = () => {
  const raw = process.env.PUBLIC_URL
    || (process.env.CLIENT_URL || '').split(',').map((s) => s.trim()).filter(Boolean)[0]
    || 'http://localhost:5173'
  return raw.replace(/\/+$/, '')
}

const newId = () => 'sa_' + crypto.randomBytes(8).toString('hex')
const newToken = () => crypto.randomBytes(24).toString('base64url')

const isMotionState = (s) => ['travelling', 'arrived', 'working'].includes(s)

module.exports = {
  // Emergency. Records the alert, blasts every admin via in-app notification
  // + FCM push + a global socket event the portal can subscribe to. We don't
  // try to be clever — if Firebase isn't configured the push silently
  // no-ops, the DB row is still written so admin can review later.
  sos: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const { job_id, lat, lng, note } = req.body || {}
      if (!job_id) return res.status(400).json({ success: false, message: 'job_id required' })

      const job = await Job.findById(job_id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.customer_id !== customer_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      if (!isMotionState(job.state)) {
        return res.status(409).json({
          success: false,
          message: `SOS only available while job is travelling / arrived / working (current: ${job.state})`,
        })
      }

      const lat_n = Number.isFinite(Number(lat)) ? Number(lat) : null
      const lng_n = Number.isFinite(Number(lng)) ? Number(lng) : null
      const id = newId()

      await db('safety_alerts').insert({
        id,
        job_id,
        customer_id,
        partner_id: job.partner_id,
        type:       'sos',
        note:       (note ? String(note).slice(0, 500) : null),
        lat: lat_n, lng: lng_n,
        status: 'active',
      })

      // Ping every admin: in-app notification row + push.
      const adminIds = await db('users')
        .where(b => b.where('role', 'admin').orWhere('is_admin', true))
        .whereNull('deleted_at')
        .pluck('user_id')

      const title = '🚨 SOS triggered'
      const body  = `${job.customer_name || 'A customer'} pressed SOS during ${job.service}`
      for (const adminId of adminIds) {
        try {
          await Notification.create({
            user_id: adminId, type: 'safety_sos',
            title, body, icon: '🚨', icon_bg: '#fee2e2',
            route: '/portal/safety',
          })
        } catch { /* keep iterating */ }
      }
      push.sendToUsers(adminIds, {
        title,
        body,
        data: { type: 'safety:sos', jobId: job_id, alertId: id, route: '/portal/safety' },
        icon: '/favicon.ico',
      }).catch(() => {})

      // Real-time signal so any open admin portal lights up immediately.
      emitGlobal('safety:sos', {
        alertId: id, jobId: job_id,
        customer_id, customer_name: job.customer_name,
        partner_id: job.partner_id, partner_name: job.partner_name,
        service: job.service, lat: lat_n, lng: lng_n,
        created_at: new Date().toISOString(),
      })

      res.status(201).json(success('SOS recorded', { alert: { id, status: 'active' } }))
    } catch (err) { next(err) }
  },

  // Share-trip. Mints a one-off public token, builds a tracking URL, fires
  // an SMS via the configured provider (or no-ops in dev) and returns the
  // link so the UI can fall back to native share / clipboard.
  shareTrip: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const { job_id, contact_phone, contact_name } = req.body || {}
      if (!job_id || !contact_phone) {
        return res.status(400).json({ success: false, message: 'job_id and contact_phone required' })
      }
      const phone = String(contact_phone).trim()
      // Loose validation — most regions use 7-15 digits with optional +.
      if (!/^\+?\d[\d\s-]{6,18}\d$/.test(phone)) {
        return res.status(400).json({ success: false, message: 'Invalid phone number' })
      }

      const job = await Job.findById(job_id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.customer_id !== customer_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      if (!isMotionState(job.state)) {
        return res.status(409).json({
          success: false,
          message: 'You can only share a trip while the job is in progress',
        })
      }

      const id    = newId()
      const token = newToken()
      await db('safety_alerts').insert({
        id,
        job_id,
        customer_id,
        partner_id:    job.partner_id,
        type:          'share',
        contact_phone: phone,
        contact_name:  contact_name ? String(contact_name).slice(0, 120) : null,
        share_token:   token,
        status:        'active',
      })

      const url = `${publicOrigin()}/track/${token}`
      const partnerName  = job.partner_name  || 'a service pro'
      const customerName = job.customer_name || 'I'
      const message = `${customerName} shared a live ServiceLink trip with you. ${partnerName} is on the way for ${job.service}. Track here: ${url}`

      const smsResult = await sms.send(phone, message)

      res.status(201).json(success('Trip shared', {
        url,
        token,
        sms: smsResult,
        alert: { id, status: 'active' },
      }))
    } catch (err) { next(err) }
  },

  // H39 — POST /api/safety/track-link { job_id }
  // Customer-initiated, no SMS / contact required. Returns { url, token }
  // the customer can share via any channel (WhatsApp, copy, native share).
  // Reuses the same `safety_alerts` row + `share_token` machinery as
  // share-trip so the existing /track/:token page renders it unchanged.
  // The token is valid until the job is paid / cancelled (the publicTrack
  // handler already enforces this).
  trackLink: async (req, res, next) => {
    try {
      const customer_id = req.user.uid
      const { job_id } = req.body || {}
      if (!job_id) {
        return res.status(400).json({ success: false, message: 'job_id required' })
      }
      const job = await Job.findById(job_id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.customer_id !== customer_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      if (!isMotionState(job.state)) {
        return res.status(409).json({
          success: false,
          message: 'You can only share tracking while the job is in progress',
        })
      }

      // Reuse an existing token if the customer already minted one for this
      // job — copy/share-again should yield the same URL, not flood the
      // safety_alerts table.
      const existing = await db('safety_alerts')
        .where({ job_id, customer_id, type: 'share', status: 'active' })
        .whereNotNull('share_token')
        .orderBy('created_at', 'desc')
        .first()
      let token = existing?.share_token
      let id    = existing?.id
      if (!token) {
        id = newId()
        token = newToken()
        await db('safety_alerts').insert({
          id,
          job_id,
          customer_id,
          partner_id: job.partner_id,
          type:       'share',
          // Contact fields stay null — this is a self-share, no SMS sent.
          contact_phone: null,
          contact_name:  null,
          share_token:   token,
          status:        'active',
        })
      }

      const url = `${publicOrigin()}/track/${token}`
      res.status(201).json(success('Track link', { url, token, alert: { id, status: 'active' } }))
    } catch (err) { next(err) }
  },

  // POST /api/safety/partner-share { job_id, contact_phone, contact_name? }
  // Partner heading to a job lets a family member follow them. Mirror of
  // shareTrip but caller is the partner; the recipient still hits the same
  // public /track/:token page (which already serves partner coords).
  partnerShareTrip: async (req, res, next) => {
    try {
      const partner_id = req.user.uid
      const { job_id, contact_phone, contact_name } = req.body || {}
      if (!job_id || !contact_phone) {
        return res.status(400).json({ success: false, message: 'job_id and contact_phone required' })
      }
      const phone = String(contact_phone).trim()
      if (!/^\+?\d[\d\s-]{6,18}\d$/.test(phone)) {
        return res.status(400).json({ success: false, message: 'Invalid phone number' })
      }

      const job = await Job.findById(job_id)
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })
      if (job.partner_id !== partner_id) {
        return res.status(403).json({ success: false, message: 'Not your job' })
      }
      // Same motion-state gate — partner location only flows during
      // travelling/arrived (working is on-site, no location streaming).
      if (!isMotionState(job.state)) {
        return res.status(409).json({
          success: false,
          message: 'You can only share a trip while heading to or at the customer',
        })
      }

      const id    = newId()
      const token = newToken()
      await db('safety_alerts').insert({
        id,
        job_id,
        customer_id:   job.customer_id,
        partner_id,
        type:          'partner_share',
        contact_phone: phone,
        contact_name:  contact_name ? String(contact_name).slice(0, 120) : null,
        share_token:   token,
        status:        'active',
      })

      const url = `${publicOrigin()}/track/${token}`
      const partnerName = job.partner_name || 'I'
      // Recipient is the partner's contact, so frame the message from the
      // partner's POV ("I'm heading to a service job…").
      const message = `${partnerName} shared a live ServiceLink trip with you. Heading to a ${job.service} job — track location here: ${url}`

      const smsResult = await sms.send(phone, message)

      res.status(201).json(success('Trip shared', {
        url,
        token,
        sms: smsResult,
        alert: { id, status: 'active' },
      }))
    } catch (err) { next(err) }
  },

  // Public live tracking — no auth. Designed to be opened from an SMS link,
  // so we keep the payload minimal and stop serving location data once the
  // job is resolved (paid/cancelled). The token row stays in the DB for
  // audit, but the payload becomes a "trip ended" stub.
  publicTrack: async (req, res, next) => {
    try {
      const token = req.params.token
      if (!token) return res.status(400).json({ success: false, message: 'token required' })

      const alert = await db('safety_alerts')
        .where({ share_token: token })
        .whereIn('type', ['share', 'partner_share'])
        .first()
      if (!alert) return res.status(404).json({ success: false, message: 'Invalid or expired link' })

      const job = await db('jobs').where({ id: alert.job_id }).first()
      if (!job) return res.status(404).json({ success: false, message: 'Job not found' })

      const ended = ['paid', 'cancelled'].includes(job.state)
      if (ended) {
        return res.json(success('Trip ended', {
          ended:        true,
          state:        job.state,
          partner_name: job.partner_name || null,
          service:      job.service       || null,
        }))
      }

      // Pull the partner's last-known coords (kept fresh by the streamLocation
      // ping during travelling/arrived). Strip the user_id and any PII.
      const partner = await db('partners').where({ user_id: job.partner_id })
        .select('lat', 'lng', 'location_updated_at').first()

      res.json(success('Tracking', {
        ended: false,
        state: job.state,
        service: job.service,
        partner_name: job.partner_name || null,
        customer_name: alert.contact_name || job.customer_name || null,
        customer_lat: job.customer_lat ?? null,
        customer_lng: job.customer_lng ?? null,
        partner_lat: partner?.lat ?? null,
        partner_lng: partner?.lng ?? null,
        partner_loc_at: partner?.location_updated_at ?? null,
      }))
    } catch (err) { next(err) }
  },
}
