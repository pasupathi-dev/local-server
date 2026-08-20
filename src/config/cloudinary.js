// Cloudinary — the single image store for the app (profile photos, category
// images, request/job photos). Replaces the old multer-on-disk setup.
//
// Configure from .env:
//   CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET
//
// Uploads are done server-side from a base64 data URI the client sends in a
// JSON body — the API secret never leaves the server and there's no browser→
// Cloudinary CORS or upload-preset to configure.

const { v2: cloudinary } = require('cloudinary')

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure:     true,
})

const isConfigured = () =>
  !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)

// Accepts a data URI (data:image/...;base64,xxxx) OR a remote URL and uploads
// it to Cloudinary under `folder`. Returns { url, public_id }. Throws a clean
// error when Cloudinary isn't configured so callers can 503 instead of 500.
async function uploadImage (dataUri, { folder = 'local-job', publicId } = {}) {
  if (!isConfigured()) {
    const e = new Error('Image uploads are not configured (missing CLOUDINARY_* env)')
    e.status = 503
    throw e
  }
  if (!dataUri || typeof dataUri !== 'string') {
    const e = new Error('No image provided')
    e.status = 400
    throw e
  }
  const res = await cloudinary.uploader.upload(dataUri, {
    folder: `local-job/${folder}`,
    public_id: publicId,
    overwrite: true,
    resource_type: 'image',
    // Keep originals reasonable — cap the longest side; Cloudinary serves
    // optimised/format-negotiated variants from this stored asset.
    transformation: [{ width: 1600, height: 1600, crop: 'limit' }],
  })
  return { url: res.secure_url, public_id: res.public_id }
}

// Best-effort delete by public_id (used when replacing an avatar). Never
// throws — a failed cleanup shouldn't break the user-facing flow.
async function destroyImage (publicId) {
  if (!publicId || !isConfigured()) return
  try { await cloudinary.uploader.destroy(publicId) } catch { /* non-fatal */ }
}

module.exports = { cloudinary, uploadImage, destroyImage, isConfigured }
