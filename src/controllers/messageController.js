const Job     = require('../models/Job')
const Message = require('../models/Message')
const { success } = require('../utils/response')
const { emitToJob } = require('../realtime/io')

const verifyParty = async (jobId, uid) => {
  const job = await Job.findById(jobId)
  if (!job) return { ok: false, code: 404, msg: 'Job not found' }
  if (uid !== job.customer_id && uid !== job.partner_id) return { ok: false, code: 403, msg: 'Not a party' }
  const role = uid === job.partner_id ? 'partner' : 'user'
  return { ok: true, job, role }
}

// Once a job is paid or cancelled the chat is read-only — no new messages,
// no edits, no deletes. Customers used to land back here by tapping an old
// notification and could still chat at a partner who'd long since moved on.
const CLOSED_STATES = new Set(['paid', 'cancelled'])
const isClosed = (job) => CLOSED_STATES.has(job?.state)

module.exports = {
  // GET /api/messages/:jobId
  list: async (req, res, next) => {
    try {
      const p = await verifyParty(req.params.jobId, req.user.uid)
      if (!p.ok) return res.status(p.code).json({ success: false, message: p.msg })
      const messages = await Message.listForJob(req.params.jobId)
      await Message.markRead(req.params.jobId, p.role)
      res.json(success('Messages', { messages }))
    } catch (err) { next(err) }
  },

  // POST /api/messages/:jobId  { body, attachment? }
  send: async (req, res, next) => {
    try {
      const p = await verifyParty(req.params.jobId, req.user.uid)
      if (!p.ok) return res.status(p.code).json({ success: false, message: p.msg })
      if (isClosed(p.job)) {
        return res.status(409).json({
          success: false,
          code: 'chat_closed',
          message: p.job.state === 'paid'
            ? 'This job is finished. Chat is closed.'
            : 'This job was cancelled. Chat is closed.',
        })
      }
      const initials = p.role === 'partner' ? p.job.partner_initials : p.job.customer_initials
      // L78 — snapshot the sender's uploaded photo so the chat bubble can
      // render it. Best-effort — a sender without a photo gets NULL and
      // the bubble falls back to the colour initials circle.
      const User = require('../models/User')
      const sender = await User.findByUid(req.user.uid).catch(() => null)
      const msg = await Message.create({
        job_id: req.params.jobId,
        sender_id: req.user.uid,
        sender_role: p.role,
        sender_initials:   initials,
        sender_avatar_url: sender?.avatar_url || null,
        body: req.body?.body || null,
        attachment: req.body?.attachment || null,
      })
      emitToJob(req.params.jobId, 'chat:message', msg)
      res.status(201).json(success('Sent', { message: msg }))
    } catch (err) { next(err) }
  },

  // PATCH /api/messages/:jobId/:messageId  { body }
  // Edit your own message. Refuses if you aren't the sender, the message
  // belongs to a different job, or the bubble has an attachment (price
  // bubbles would desync if the body changed without the attachment).
  // Broadcasts `chat:message-edited` so the other party swaps in place.
  update: async (req, res, next) => {
    try {
      const p = await verifyParty(req.params.jobId, req.user.uid)
      if (!p.ok) return res.status(p.code).json({ success: false, message: p.msg })
      if (isClosed(p.job)) {
        return res.status(409).json({ success: false, code: 'chat_closed', message: 'Chat is closed on this job.' })
      }

      const existing = await Message.findById(req.params.messageId)
      if (!existing || String(existing.job_id) !== String(req.params.jobId)) {
        return res.status(404).json({ success: false, message: 'Message not found' })
      }
      if (existing.sender_id !== req.user.uid) {
        return res.status(403).json({ success: false, message: 'You can only edit your own messages' })
      }
      if (existing.deleted_at) {
        return res.status(400).json({ success: false, message: 'Cannot edit a deleted message' })
      }
      if (existing.attachment) {
        return res.status(400).json({ success: false, message: 'Messages with attachments cannot be edited' })
      }
      const body = String(req.body?.body || '').trim()
      if (!body) {
        return res.status(400).json({ success: false, message: 'Message body cannot be empty' })
      }

      const updated = await Message.updateBody(req.params.messageId, body)
      emitToJob(req.params.jobId, 'chat:message-edited', updated)
      res.json(success('Updated', { message: updated }))
    } catch (err) { next(err) }
  },

  // DELETE /api/messages/:jobId/:messageId
  // Soft-delete your own message. The row stays so other tabs / future loads
  // see a "deleted" tomb in place of the original body. Broadcasts the
  // updated row via `chat:message-edited` (same event as edit — the client's
  // applyMessageEdit reducer just swaps in the new fields, including
  // `deleted_at`) so we don't need a separate listener.
  remove: async (req, res, next) => {
    try {
      const p = await verifyParty(req.params.jobId, req.user.uid)
      if (!p.ok) return res.status(p.code).json({ success: false, message: p.msg })
      if (isClosed(p.job)) {
        return res.status(409).json({ success: false, code: 'chat_closed', message: 'Chat is closed on this job.' })
      }

      const existing = await Message.findById(req.params.messageId)
      if (!existing || String(existing.job_id) !== String(req.params.jobId)) {
        return res.status(404).json({ success: false, message: 'Message not found' })
      }
      if (existing.sender_id !== req.user.uid) {
        return res.status(403).json({ success: false, message: 'You can only delete your own messages' })
      }
      if (existing.deleted_at) {
        // Already deleted — return the existing row instead of erroring so the
        // client's optimistic flow doesn't have to special-case double-taps.
        return res.json(success('Already deleted', { message: existing }))
      }

      const updated = await Message.softDelete(req.params.messageId)
      emitToJob(req.params.jobId, 'chat:message-edited', updated)
      res.json(success('Deleted', { message: updated }))
    } catch (err) { next(err) }
  },

  // POST /api/messages/:jobId/read
  markRead: async (req, res, next) => {
    try {
      const p = await verifyParty(req.params.jobId, req.user.uid)
      if (!p.ok) return res.status(p.code).json({ success: false, message: p.msg })
      await Message.markRead(req.params.jobId, p.role)
      emitToJob(req.params.jobId, 'chat:read', { jobId: req.params.jobId, role: p.role })
      res.json(success('Read'))
    } catch (err) { next(err) }
  },
}
