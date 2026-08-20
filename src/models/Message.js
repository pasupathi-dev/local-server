const { db } = require('../config/db')
const TABLE  = 'messages'

const parseAttachment = (v) => {
  if (!v) return null
  if (typeof v === 'object') return v
  try { return JSON.parse(v) } catch { return null }
}

const normalize = (row) => row ? { ...row, attachment: parseAttachment(row.attachment) } : row

const Message = {
  create: async ({ job_id, sender_id, sender_role, sender_initials, sender_avatar_url, body, attachment }) => {
    const [id] = await db(TABLE).insert({
      job_id,
      sender_id,
      sender_role,
      sender_initials:   sender_initials || null,
      sender_avatar_url: sender_avatar_url || null,
      body:       body || null,
      attachment: attachment ? JSON.stringify(attachment) : null,
      read_by_customer: sender_role === 'user',
      read_by_partner:  sender_role === 'partner',
    })
    return Message.findById(id)
  },

  findById: async (id) => normalize(await db(TABLE).where({ id }).first()),

  listForJob: async (job_id) => {
    const rows = await db(TABLE).where({ job_id }).orderBy('created_at', 'asc')
    return rows.map(normalize)
  },

  markRead: (job_id, role) => db(TABLE)
    .where({ job_id })
    .update(role === 'partner' ? { read_by_partner: true } : { read_by_customer: true }),

  // Update the body of a single message and stamp `edited_at`. The caller is
  // expected to have already verified that `sender_id` matches the requester.
  // Returns the fresh row, or null if no row was affected (id missing).
  updateBody: async (id, body) => {
    const affected = await db(TABLE)
      .where({ id })
      .update({ body: body || null, edited_at: new Date() })
    if (!affected) return null
    return Message.findById(id)
  },

  // Soft-delete: keep the row (so it remains addressable for sockets / threads)
  // but blank the body and stamp `deleted_at`. The chat UI reads `deleted_at`
  // to render a "This message was deleted" tomb in place of the original body.
  softDelete: async (id) => {
    const affected = await db(TABLE)
      .where({ id })
      .update({ body: null, attachment: null, deleted_at: new Date() })
    if (!affected) return null
    return Message.findById(id)
  },
}

module.exports = Message
