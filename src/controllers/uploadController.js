// Image uploads — Cloudinary edition. The client sends the image as a base64
// data URI (data:image/...;base64,...) in a JSON body; we upload it to
// Cloudinary server-side (API secret stays here) and return the secure URL the
// client stores / embeds. Replaces the old multer-on-disk implementation.
//
// Controller interface is unchanged from the client's perspective: every
// endpoint returns { url } (avatar/category also persist it in the DB).

const { success } = require('../utils/response')
const { uploadImage, destroyImage } = require('../config/cloudinary')

const safeId = (s) => String(s || 'anon').replace(/[^a-z0-9_-]/gi, '')

// Pull the image data URI from the request body. Accept a couple of common
// field names so existing/foreign callers don't trip on naming.
const pickImage = (req) => req.body?.image || req.body?.photo || req.body?.dataUri || null

module.exports = {
  // POST /api/uploads/request-photo  { image: <dataURI> }
  // Returns { url } the client adds to the request payload's `photos` array.
  requestPhoto: async (req, res, next) => {
    try {
      const image = pickImage(req)
      if (!image) return res.status(400).json({ success: false, message: 'No image provided' })
      const { url } = await uploadImage(image, { folder: 'request-photos' })
      res.json(success('Uploaded', { url }))
    } catch (err) { next(err) }
  },

  // POST /api/uploads/avatar  { image: <dataURI> }
  // Uploads (overwriting the user's single avatar asset), persists
  // users.avatar_url, returns the new URL so the client swaps it immediately.
  avatar: async (req, res, next) => {
    try {
      const image = pickImage(req)
      if (!image) return res.status(400).json({ success: false, message: 'No image provided' })
      const uid = req.user.uid
      const { url } = await uploadImage(image, { folder: 'avatars', publicId: `avatar_${safeId(uid)}` })
      const { db } = require('../config/db')
      await db('users').where({ user_id: uid }).update({ avatar_url: url })
      res.json(success('Uploaded', { url }))
    } catch (err) { next(err) }
  },

  // DELETE /api/uploads/avatar — clears users.avatar_url (falls back to the
  // deterministic initials circle) and removes the Cloudinary asset.
  removeAvatar: async (req, res, next) => {
    try {
      const uid = req.user.uid
      const { db } = require('../config/db')
      await db('users').where({ user_id: uid }).update({ avatar_url: null })
      // Asset path mirrors uploadImage's `local-job/<folder>/<publicId>`.
      destroyImage(`local-job/avatars/avatar_${safeId(uid)}`)
      res.json(success('Removed'))
    } catch (err) { next(err) }
  },

  // POST /api/uploads/job-photo  { image: <dataURI> }
  // Partner before/after photo; attached via PATCH /jobs/:id/completion-photos.
  jobPhoto: async (req, res, next) => {
    try {
      const image = pickImage(req)
      if (!image) return res.status(400).json({ success: false, message: 'No image provided' })
      const { url } = await uploadImage(image, { folder: 'job-photos' })
      res.json(success('Uploaded', { url }))
    } catch (err) { next(err) }
  },

  // POST /api/uploads/image  { image: <dataURI>, folder?: string }
  // Generic authed upload — used by the portal for category images. Returns
  // { url } the caller stores.
  image: async (req, res, next) => {
    try {
      const image = pickImage(req)
      if (!image) return res.status(400).json({ success: false, message: 'No image provided' })
      const folder = String(req.body?.folder || 'misc').replace(/[^a-z0-9_-]/gi, '') || 'misc'
      const { url, public_id } = await uploadImage(image, { folder })
      res.json(success('Uploaded', { url, public_id }))
    } catch (err) { next(err) }
  },
}
