const router = require('express').Router()
const { db }  = require('../config/db')

// M30 — Weekly P50 acceptance time. Returns the median seconds between
// request creation and the matching job being created (= partner accepted),
// scoped to the last 7 days. Falls back to a sensible 120s if the dataset
// is too small to compute.
const computeResponseTimeP50 = async () => {
  try {
    const rows = await db('jobs as j')
      .leftJoin({ r: 'requests' }, function () {
        this.on(db.raw('j.request_id COLLATE utf8mb4_unicode_ci = r.id COLLATE utf8mb4_unicode_ci'))
      })
      .whereRaw('j.created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)')
      .whereNotNull('r.created_at')
      .select(db.raw('TIMESTAMPDIFF(SECOND, r.created_at, j.created_at) AS sec'))
    const samples = rows
      .map((row) => Number(row.sec))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 3600)
      .sort((a, b) => a - b)
    if (samples.length < 5) return 120     // tiny sample → keep the floor
    const mid = Math.floor(samples.length / 2)
    return samples.length % 2
      ? samples[mid]
      : Math.round((samples[mid - 1] + samples[mid]) / 2)
  } catch { return 120 }
}

// GET /api/config — returns dynamic enums + categories for the client app
router.get('/', async (req, res) => {
  try {
    const [configRows, categories, works, responseP50] = await Promise.all([
      db('app_config').orderBy('key'),
      db('categories').where({ is_active: true }).orderBy('sort_order','asc'),
      db('works').where({ is_active: true }).orderBy('category_name','asc').orderBy('sort_order','asc'),
      computeResponseTimeP50(),
    ])

    const config = {}
    for (const r of configRows) {
      try { config[r.key] = JSON.parse(r.value) }
      catch { config[r.key] = r.value }
    }

    res.json({
      success: true,
      data: {
        categories: categories.map(c => ({ name: c.name, display_name: c.display_name || c.name, icon: c.icon, image_url: c.image_url, pin_color: c.pin_color })),
        // Taxonomy v2 — bookable leaf list (each work carries its parent category).
        works: works.map(w => ({ name: w.name, category_name: w.category_name, display_name: w.display_name || w.name, icon: w.icon, pin_color: w.pin_color, base_price_suggestion: w.base_price_suggestion })),
        availableDays:      config.available_days_options      || [],
        availableHours:     config.available_hours_options     || [],
        requestTimerSeconds: config.request_timer_seconds      || 600,
        serviceRadiusOptions: config.service_radius_options    || [],
        emergencyFeePercent:  config.emergency_fee_percent     || 25,
        platformFeePercent:   config.platform_fee_percent      || 15,
        minJobPriceInr:       config.min_job_price_inr         || 199,
        // Phase 2 — exposed so the client default-quote logic stays in sync
        // with the admin's app_config value (no redeploy when ₹299 changes).
        defaultBasePriceInr:  config.default_base_price_inr    || 299,
        // Phase 3 — windows + matching parameters surfaced to client UI so
        // labels ("Cancelling now costs ₹50", "Up to 50 km") stay in sync.
        defaultSearchRadiusKm:  config.default_search_radius_km   || 10,
        maxUserRadiusKm:        config.max_user_radius_km         || 50,
        autoMatchRadiusRings:   Array.isArray(config.auto_match_radius_rings)
                                  ? config.auto_match_radius_rings
                                  : [10, 25, 50, 100],
        partnerSnoozeMin:       config.partner_snooze_min         || 5,
        freeCancelWindowSec:    config.free_cancel_window_sec     || 90,
        disputeWindowHours:     config.dispute_window_hours       || 48,
        rescheduleLockHours:    config.reschedule_lock_hours      || 4,
        accountDeleteGraceDays: config.account_delete_grace_days  || 7,
        // Phase 4 — limits + ETA formula. Client mirrors so labels stay in sync.
        maxTrustedContacts:     config.max_trusted_contacts       || 5,
        maxSavedAddresses:      config.max_saved_addresses        || 8,
        etaSpeedKmph:           config.eta_speed_kmph             || 20,
        etaBufferMin:           config.eta_buffer_min             || 5,
        liveEtaSpeedKmph:       config.live_eta_speed_kmph        || 22,
        etaInsideAreaM:         config.eta_inside_area_m          || 200,
        // M30 — drives "Most partners respond in under N min" copy.
        responseTimeP50Seconds: responseP50,
      },
    })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Config load failed' })
  }
})

// GET /api/config/announcements — active announcements for client app
router.get('/announcements', async (req, res) => {
  try {
    const now = new Date()
    const rows = await db('announcements')
      .where({ is_active: true })
      .where('starts_at', '<=', now)
      .where(b => b.whereNull('ends_at').orWhere('ends_at', '>=', now))
      .orderBy('created_at', 'desc')
      .limit(5)
    res.json({ success: true, data: rows })
  } catch (err) {
    res.status(500).json({ success: false, message: 'Announcements load failed' })
  }
})

module.exports = router
