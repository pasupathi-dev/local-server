const router  = require('express').Router()
const { requireAdmin } = require('../middleware/adminAuth')
const ctrl = require('../controllers/adminController')
const uploadCtrl = require('../controllers/uploadController')

router.use(requireAdmin)

// Image upload (Cloudinary) — used by the portal for category images.
// Body: { image: <dataURI>, folder?: string }. Returns { url }.
router.post('/upload-image', uploadCtrl.image)

// Auth check
router.get('/me', ctrl.getMe)

// H90 — Mint a read-only impersonation token for support debugging.
router.post('/impersonate/:uid', ctrl.impersonate)
// H92 — Bulk operations on a set of partner user_ids (suspend / activate /
// verify / unverify / message).
router.post('/partners/bulk', ctrl.bulkPartnerAction)
// M93 — Global search across multiple entity types.
router.get('/search', ctrl.globalSearch)
// L96 — Send a push/in-app broadcast to a partner cohort by filter.
router.post('/broadcasts', ctrl.sendBroadcast)
// M95 — Preview today's ops digest (same payload the daily worker emails).
router.get('/ops-digest', ctrl.opsDigestPreview)

// Dashboard
router.get('/dashboard/stats',  ctrl.getDashboardStats)
router.get('/dashboard/charts', ctrl.getDashboardCharts)

// Users
router.get('/users',              ctrl.listUsers)
router.get('/users/:id',          ctrl.getUser)
router.patch('/users/:id',        ctrl.updateUser)
router.patch('/users/:id/status', ctrl.updateUserStatus)
router.patch('/users/:id/role',   ctrl.updateUserRole)
router.patch('/users/:id/admin',  ctrl.updateUserAdmin)
router.delete('/users/:id',       ctrl.deleteUser)

// Devices (FCM tokens) — review + revoke. Tokens contain `:` / `/`, so
// the client must URL-encode them before hitting DELETE.
router.get('/users/:id/devices',           ctrl.listUserDevices)
router.delete('/users/:id/devices/:token', ctrl.revokeUserDevice)

// Partners
router.get('/partners',                    ctrl.listPartners)
router.get('/partners/:id',                ctrl.getPartner)
router.patch('/partners/:id',              ctrl.updatePartner)
router.patch('/partners/:id/verify',       ctrl.verifyPartner)
router.post('/partners/:id/force-online',  ctrl.forceOnlinePartner)
router.get('/partners/:id/wallet',         ctrl.getPartnerWallet)
router.get('/partners/:id/activity',       ctrl.getPartnerActivity)

// Jobs
router.get('/jobs',             ctrl.listJobs)
router.get('/jobs/:id',         ctrl.getJob)
router.patch('/jobs/:id/cancel', ctrl.cancelJob)

// Requests
router.get('/requests',             ctrl.listRequests)
router.post('/requests/:id/expire', ctrl.expireRequest)

// Schedules
router.get('/schedules',             ctrl.listSchedules)
router.post('/schedules/:id/cancel', ctrl.cancelSchedule)

// Payments
router.get('/payments',     ctrl.listPayments)
router.get('/payments/:id', ctrl.getPayment)

// Wallet & withdrawals
router.get('/wallet/overview',           ctrl.getWalletOverview)
router.get('/wallet/withdrawals',        ctrl.listWithdrawals)
router.patch('/wallet/withdrawals/:id',  ctrl.updateWithdrawal)
router.post('/wallet/clear-credits',     ctrl.clearPendingCredits)

// Reviews
router.get('/reviews',       ctrl.listReviews)
router.delete('/reviews/:id', ctrl.deleteReview)

// Notifications
router.get('/notifications',       ctrl.listNotifications)
router.post('/notifications/send', ctrl.sendNotification)

// Categories
router.get('/categories',                      ctrl.listCategories)
router.post('/categories',                     ctrl.createCategory)
router.patch('/categories/:name',              ctrl.updateCategory)
router.delete('/categories/:name',             ctrl.deleteCategory)
router.post('/categories/:name/toggle-active', ctrl.toggleCategoryActive)

// Works — the bookable leaf under a parent category (taxonomy v2)
router.get('/works',                      ctrl.listWorks)
router.post('/works',                     ctrl.createWork)
router.patch('/works/:name',              ctrl.updateWork)
router.delete('/works/:name',             ctrl.deleteWork)
router.post('/works/:name/toggle-active', ctrl.toggleWorkActive)

// App Config
router.get('/config',        ctrl.getAdminConfig)
router.put('/config',        ctrl.setAdminConfig)

// Announcements
router.get('/announcements',       ctrl.listAnnouncements)
router.post('/announcements',      ctrl.createAnnouncement)
router.patch('/announcements/:id', ctrl.updateAnnouncement)
router.delete('/announcements/:id', ctrl.deleteAnnouncement)

// Disputes
router.get('/disputes',                 ctrl.listDisputes)
router.get('/disputes/:id',             ctrl.getDispute)
router.post('/disputes/:id/resolve',    ctrl.resolveDispute)

// Safety alerts (SOS + share-trip)
router.get('/safety-alerts',                 ctrl.listSafetyAlerts)
router.get('/safety-alerts/:id',             ctrl.getSafetyAlert)
router.post('/safety-alerts/:id/resolve',    ctrl.resolveSafetyAlert)

// Push delivery log — visibility only, no resolve actions.
router.get('/push-log', ctrl.listPushLog)

// Audit Log
router.get('/audit-log', ctrl.getAuditLog)

// Analytics
router.get('/analytics/revenue',  ctrl.getRevenueAnalytics)
router.get('/analytics/users',    ctrl.getUserAnalytics)
router.get('/analytics/jobs',     ctrl.getJobAnalytics)
router.get('/analytics/partners', ctrl.getPartnerAnalytics)

// Enhanced Withdrawal (replaces old patch route)
router.patch('/wallet/withdrawals/:id/full', ctrl.updateWithdrawalFull)

module.exports = router
