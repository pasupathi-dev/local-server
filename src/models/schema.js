// Single bootstrap file — creates every ServiceLink table if missing.
// Idempotent: safe to run on every server start.
//
// Table order below respects FK dependency order.

const { db } = require('../config/db')
const {
  CATEGORIES, WORKS, WORK_PARENT, USER_STATUSES, ROLES, AVATAR_CLASSES,
  REQUEST_STATUS, JOB_STATES, SCHED_STATUS,
  PAYMENT_STATUS, PAYMENT_METHODS, TX_TYPES, WD_STATUS,
  NOTIF_TYPES, ACT_TYPES,
  AVAIL_DAYS, AVAIL_HOURS,
} = require('../config/constants')

async function ensureUsers () {
  const exists = await db.schema.hasTable('users')
  if (!exists) {
    await db.schema.createTable('users', (t) => {
      t.string('user_id', 128).notNullable().primary()
      t.string('email', 255).defaultTo(null)
      t.string('phone', 20).defaultTo(null)
      t.string('full_name', 255).defaultTo(null)
      t.string('avatar_class', 10).defaultTo('pav-a')
      // L78 — Uploaded profile photo URL (server-relative). NULL means
      // the UI falls back to the deterministic colour circle.
      t.string('avatar_url', 500).defaultTo(null)
      // L79 — start of 7-day grace period for account deletion.
      t.timestamp('deletion_requested_at').defaultTo(null)
      t.string('address', 500).defaultTo(null)
      t.string('city', 100).defaultTo(null)
      t.string('pincode', 10).defaultTo(null)
      t.enum('status', USER_STATUSES).notNullable().defaultTo('active')
      t.enum('role', ROLES).notNullable().defaultTo('user')
      t.boolean('is_admin').notNullable().defaultTo(false)
      t.boolean('onboarding_done').notNullable().defaultTo(false)
      t.timestamp('created_at').defaultTo(db.fn.now())
      t.timestamp('updated_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))
      t.timestamp('deleted_at').defaultTo(null)
      t.index(['phone'])
      t.index(['email'])
    })
    return
  }

  // Table exists from an earlier version — add any missing columns.
  // Check each column upfront (can't await inside alterTable callback safely),
  // then emit one alter call per missing column.
  const columns = {
    phone:           (t) => t.string('phone', 20).defaultTo(null),
    full_name:       (t) => t.string('full_name', 255).defaultTo(null),
    avatar_class:    (t) => t.string('avatar_class', 10).defaultTo('pav-a'),
    // L78 — uploaded profile photo. NULL = render the deterministic
    // initials avatar via avatar_class.
    avatar_url:      (t) => t.string('avatar_url', 500).defaultTo(null),
    address:         (t) => t.string('address', 500).defaultTo(null),
    city:            (t) => t.string('city', 100).defaultTo(null),
    pincode:         (t) => t.string('pincode', 10).defaultTo(null),
    onboarding_done: (t) => t.boolean('onboarding_done').notNullable().defaultTo(false),
    is_admin:        (t) => t.boolean('is_admin').notNullable().defaultTo(false),
    // L79 — Delete account: soft delete starts when the user requests it.
    // `deletion_requested_at` is the start of the 7-day grace period; the
    // existing `deleted_at` is only set once the daily worker finalises it.
    deletion_requested_at: (t) => t.timestamp('deletion_requested_at').defaultTo(null),
  }
  const statuses = await Promise.all(
    Object.keys(columns).map(async (col) => [col, await db.schema.hasColumn('users', col)]),
  )
  const missing = statuses.filter(([, has]) => !has).map(([col]) => col)
  if (missing.length) {
    await db.schema.alterTable('users', (t) => {
      missing.forEach((col) => columns[col](t))
    })
    console.log(`✅ users table: added missing columns [${missing.join(', ')}]`)
  }

  // Backfill full_name from first_name if that legacy column is present
  const hasFirstName = await db.schema.hasColumn('users', 'first_name')
  if (hasFirstName) {
    await db('users')
      .whereNull('full_name')
      .update({ full_name: db.ref('first_name') })
      .catch(() => {})
  }
}

async function ensurePartners () {
  const exists = await db.schema.hasTable('partners')
  if (!exists) {
    await db.schema.createTable('partners', (t) => {
      t.string('user_id', 128).notNullable().primary()
      t.string('primary_category', 80).defaultTo(null)
      t.json('languages').defaultTo(null)
      t.integer('experience_years').defaultTo(0)
      t.enum('availability_days', AVAIL_DAYS).defaultTo('Mon-Sat')
      t.enum('availability_hours', AVAIL_HOURS).defaultTo('8am-8pm')
      t.boolean('emergency_service').defaultTo(false)
      t.integer('service_radius_km').defaultTo(10)
      t.boolean('is_online').defaultTo(false)
      t.boolean('is_verified').defaultTo(false)
      t.boolean('top_rated').defaultTo(false)
      t.boolean('aadhaar_verified').defaultTo(false)
      t.boolean('phone_verified').defaultTo(false)
      t.boolean('background_checked').defaultTo(false)
      t.boolean('own_tools').defaultTo(true)
      t.boolean('materials_extra').defaultTo(true)
      t.string('zone', 120).defaultTo(null)
      t.decimal('lat', 10, 7).defaultTo(null)
      t.decimal('lng', 10, 7).defaultTo(null)
      t.string('location_address', 255).defaultTo(null)
      t.string('location_city', 100).defaultTo(null)
      t.timestamp('location_updated_at').defaultTo(null)
      t.decimal('rating_avg', 3, 2).defaultTo(0)
      t.integer('rating_count').defaultTo(0)
      t.integer('jobs_completed').defaultTo(0)
      t.decimal('completion_rate', 5, 2).defaultTo(100)
      t.text('about').defaultTo(null)
      t.timestamp('online_since').defaultTo(null)
      t.timestamp('created_at').defaultTo(db.fn.now())
      t.timestamp('updated_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))
      t.foreign('user_id').references('user_id').inTable('users').onDelete('CASCADE')
      t.index(['is_online'])
      t.index(['primary_category'])
    })
    return
  }
  // Add missing columns on an existing partners table
  const columns = {
    location_address:    (t) => t.string('location_address', 255).defaultTo(null),
    location_city:       (t) => t.string('location_city', 100).defaultTo(null),
    location_updated_at: (t) => t.timestamp('location_updated_at').defaultTo(null),
  }
  const checks = await Promise.all(
    Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('partners', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (missing.length) {
    await db.schema.alterTable('partners', (t) => missing.forEach((c) => columns[c](t)))
    console.log(`✅ partners table: added missing columns [${missing.join(', ')}]`)
  }

  // Drop legacy `skills` column if it lingers from an older schema — feature removed.
  if (await db.schema.hasColumn('partners', 'skills')) {
    await db.schema.alterTable('partners', (t) => t.dropColumn('skills'))
    console.log('✅ partners table: dropped legacy [skills] column')
  }

  // Drop legacy `response_time` column — feature removed.
  if (await db.schema.hasColumn('partners', 'response_time')) {
    await db.schema.alterTable('partners', (t) => t.dropColumn('response_time'))
    console.log('✅ partners table: dropped legacy [response_time] column')
  }
}

async function ensureGeocodeCache () {
  if (await db.schema.hasTable('geocode_cache')) return
  await db.schema.createTable('geocode_cache', (t) => {
    // Rounded lat/lng to 3 decimals (~110m precision) — keys the cache row
    t.decimal('lat_round', 7, 3).notNullable()
    t.decimal('lng_round', 7, 3).notNullable()
    t.string('address', 500).defaultTo(null)
    t.string('city', 100).defaultTo(null)
    t.string('state', 100).defaultTo(null)
    t.string('country', 100).defaultTo(null)
    t.string('pincode', 20).defaultTo(null)
    t.json('components').defaultTo(null)
    t.timestamp('fetched_at').defaultTo(db.fn.now())
    t.primary(['lat_round', 'lng_round'])
  })
}

async function ensureCategories () {
  if (await db.schema.hasTable('categories')) return
  await db.schema.createTable('categories', (t) => {
    t.string('name', 80).notNullable().primary()
    t.string('icon', 10).defaultTo(null)
    t.string('pin_color', 10).defaultTo(null)
    t.integer('sort_order').defaultTo(0)
  })
}

async function ensurePartnerCategoryPrices () {
  if (await db.schema.hasTable('partner_category_prices')) return
  await db.schema.createTable('partner_category_prices', (t) => {
    t.increments('id').primary()
    t.string('partner_id', 128).notNullable()
    t.string('category_name', 80).notNullable()
    t.integer('base_price').notNullable().defaultTo(0)
    t.unique(['partner_id', 'category_name'], { indexName: 'uq_partner_category' })
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('CASCADE')
    t.foreign('category_name').references('name').inTable('categories').onDelete('RESTRICT')
  })
}

// Taxonomy v2 — the WORKS (leaf) table. Each work belongs to one parent
// category (the `categories` row). Matching + pricing happen at this level.
async function ensureWorks () {
  if (await db.schema.hasTable('works')) return
  await db.schema.createTable('works', (t) => {
    t.string('name', 120).notNullable().primary()
    t.string('category_name', 80).notNullable()      // parent category
    t.string('icon', 10).defaultTo(null)
    t.string('pin_color', 10).defaultTo(null)
    // Cloudinary image URL — replaces the emoji `icon` for works in the
    // portal + customer UI. `icon` stays as a fallback when no image is set.
    t.string('image_url', 500).defaultTo(null)
    t.string('display_name', 255).defaultTo(null)
    t.text('description').defaultTo(null)
    t.integer('base_price_suggestion').defaultTo(0)
    t.integer('sort_order').defaultTo(0)
    t.boolean('is_active').notNullable().defaultTo(true)
    t.foreign('category_name').references('name').inTable('categories').onDelete('RESTRICT')
    t.index(['category_name'])
  })
}

// Taxonomy v2 — add `primary_work` (the leaf) alongside the existing
// `primary_category` (now the parent). Backfilled once in seedWorks().
async function ensurePartnersPrimaryWork () {
  if (!(await db.schema.hasTable('partners'))) return
  if (await db.schema.hasColumn('partners', 'primary_work')) return
  await db.schema.alterTable('partners', (t) => {
    t.string('primary_work', 120).defaultTo(null)
    t.index(['primary_work'])
  })
  console.log('✅ partners table: added [primary_work]')
}

// Taxonomy v2 — partner_category_prices now prices a WORK, not a category.
// Rename the `category_name` column to `work_name`. We drop the FK (it pointed
// at categories.name, which after migration only holds parents) and the old
// unique index first, then rename, then re-create the unique index. The values
// already ARE work names, so no value rewrite is needed. No new FK is added —
// validity is enforced in the app, matching how requests/jobs store work_name.
async function ensurePartnerWorkPrices () {
  if (!(await db.schema.hasTable('partner_category_prices'))) return
  if (await db.schema.hasColumn('partner_category_prices', 'work_name')) return
  if (!(await db.schema.hasColumn('partner_category_prices', 'category_name'))) return

  // Drop any FK constraint(s) on category_name (name is driver-dependent).
  try {
    const res = await db.raw(
      `SELECT CONSTRAINT_NAME AS c FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'partner_category_prices'
         AND COLUMN_NAME = 'category_name' AND REFERENCED_TABLE_NAME IS NOT NULL`,
    )
    const rows = Array.isArray(res) ? (res[0] || []) : []
    for (const r of rows) {
      await db.raw(`ALTER TABLE partner_category_prices DROP FOREIGN KEY \`${r.c}\``).catch(() => {})
    }
  } catch { /* non-MySQL driver — skip */ }

  try { await db.raw('ALTER TABLE partner_category_prices DROP INDEX uq_partner_category') } catch { /* no index */ }
  await db.raw('ALTER TABLE partner_category_prices CHANGE COLUMN category_name work_name VARCHAR(120) NOT NULL')
  try {
    await db.raw('ALTER TABLE partner_category_prices ADD UNIQUE INDEX uq_partner_work (partner_id, work_name)')
  } catch (err) {
    if (!String(err.message).includes('Duplicate key name')) throw err
  }
  console.log('✅ partner_category_prices: renamed category_name → work_name')
}

async function ensureUserLocations () {
  if (await db.schema.hasTable('user_locations')) return
  await db.schema.createTable('user_locations', (t) => {
    t.increments('id').primary()
    t.string('uid', 128).notNullable().unique()
    t.decimal('lat', 10, 7).notNullable()
    t.decimal('lng', 10, 7).notNullable()
    t.string('city', 255).defaultTo(null)
    t.string('country', 255).defaultTo(null)
    t.float('accuracy').defaultTo(null)
    t.enum('source', ['gps','cached','manual']).defaultTo('gps')
    t.timestamp('saved_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))
    t.foreign('uid').references('user_id').inTable('users').onDelete('CASCADE')
  })
}

// Idempotent: re-applies the REQUEST_STATUS enum to pick up new values
// added after the table was first created (e.g. 'cancelled'), and adds
// the auto-match retry-chain columns. `is_auto` flags requests created
// via POST /api/requests/auto so the decline handler knows to re-try
// against the next-best partner instead of giving up. `auto_radius_km`
// + `tried_partner_ids` are the search context we replay on retry.
async function ensureRequestsColumns () {
  if (!(await db.schema.hasTable('requests'))) return
  const enumList = REQUEST_STATUS.map((s) => `'${s}'`).join(',')
  try {
    await db.raw(`ALTER TABLE requests MODIFY COLUMN status ENUM(${enumList}) NOT NULL DEFAULT 'live'`)
  } catch (err) {
    if (!/ENUM|unsupported/i.test(err.message)) throw err
  }

  const columns = {
    // Taxonomy v2 — the bookable leaf. `category_name` now holds the PARENT
    // category; `work_name` is the specific work matched + priced. Backfilled
    // once in seedWorks() from the legacy `category_name` value.
    work_name:         (t) => { t.string('work_name', 120).defaultTo(null); t.index(['work_name']) },
    is_auto:           (t) => t.boolean('is_auto').notNullable().defaultTo(false),
    auto_radius_km:    (t) => t.decimal('auto_radius_km', 6, 2).defaultTo(null),
    tried_partner_ids: (t) => t.json('tried_partner_ids').defaultTo(null),
    // H25 — up to 3 photo URLs attached at request time so the partner can
    // see what they're walking into ("leaking under sink — pic attached").
    // Stored as JSON to avoid a separate photos table for a 3-element cap.
    photos:            (t) => t.json('photos').defaultTo(null),
    // H33 — Partner-side decline reason (normalised chip) + free-text note.
    // Used for admin analytics and to skip the same partner faster on
    // auto-fanout retries.
    decline_reason:    (t) => t.string('decline_reason', 80).defaultTo(null),
    decline_note:      (t) => t.text('decline_note').defaultTo(null),
  }
  const checks = await Promise.all(
    Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('requests', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (missing.length) {
    await db.schema.alterTable('requests', (t) => missing.forEach((c) => columns[c](t)))
    console.log(`✅ requests table: added missing columns [${missing.join(', ')}]`)
  }
}

// Idempotent migration — adds the proximity-alert flag to jobs so the
// "partner is almost there" toast fires exactly once per trip instead of
// spamming on every stream tick once the threshold is crossed.
async function ensureJobsProximityColumn () {
  if (!(await db.schema.hasTable('jobs'))) return
  const has = await db.schema.hasColumn('jobs', 'proximity_announced_at')
  if (has) return
  await db.schema.alterTable('jobs', (t) => {
    t.timestamp('proximity_announced_at').defaultTo(null)
  })
  console.log('✅ jobs table: added missing column [proximity_announced_at]')
}

async function ensureRequests () {
  if (await db.schema.hasTable('requests')) return
  await db.schema.createTable('requests', (t) => {
    t.string('id', 40).notNullable().primary()
    t.string('customer_id', 128).notNullable()
    t.string('partner_id', 128).defaultTo(null)          // assigned on accept
    t.string('category_name', 80).notNullable()
    t.string('service', 160).notNullable()
    t.string('service_icon', 10).defaultTo(null)
    t.integer('base_price').notNullable().defaultTo(0)
    t.decimal('lat', 10, 7).defaultTo(null)
    t.decimal('lng', 10, 7).defaultTo(null)
    t.decimal('distance_km', 6, 2).defaultTo(null)
    t.text('notes').defaultTo(null)
    t.integer('timer_seconds').notNullable().defaultTo(30)
    t.timestamp('expires_at').notNullable()
    t.enum('status', REQUEST_STATUS).notNullable().defaultTo('live')
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.timestamp('resolved_at').defaultTo(null)
    // snapshots
    t.string('customer_name', 255).defaultTo(null)
    t.string('customer_initials', 8).defaultTo(null)
    t.string('customer_av_class', 10).defaultTo(null)
    t.string('customer_phone', 20).defaultTo(null)
    t.string('customer_address', 500).defaultTo(null)
    t.foreign('customer_id').references('user_id').inTable('users').onDelete('CASCADE')
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('SET NULL')
    t.index(['status'])
    t.index(['category_name'])
  })
}

async function ensureJobs () {
  if (await db.schema.hasTable('jobs')) return
  await db.schema.createTable('jobs', (t) => {
    t.string('id', 40).notNullable().primary()     // #SL-YYYY-NNNN
    t.string('request_id', 40).defaultTo(null)
    t.string('customer_id', 128).notNullable()
    t.string('partner_id', 128).notNullable()
    t.string('category_name', 80).notNullable()
    t.string('service', 160).notNullable()
    t.string('service_icon', 10).defaultTo(null)
    t.integer('base_price').notNullable().defaultTo(0)
    t.integer('agreed_price').notNullable().defaultTo(0)
    t.integer('tip_amount').defaultTo(0)
    t.decimal('distance_km', 6, 2).defaultTo(null)
    t.text('notes').defaultTo(null)
    t.enum('state', JOB_STATES).notNullable().defaultTo('accepted')
    t.string('cancel_reason', 500).defaultTo(null)
    t.string('cancelled_by', 20).defaultTo(null)   // 'user' | 'partner'
    t.timestamp('accepted_at').defaultTo(db.fn.now())
    t.timestamp('started_at').defaultTo(null)
    t.timestamp('completed_at').defaultTo(null)
    t.timestamp('paid_at').defaultTo(null)
    // snapshots
    t.string('customer_name', 255).defaultTo(null)
    t.string('customer_initials', 8).defaultTo(null)
    t.string('customer_av_class', 10).defaultTo(null)
    t.string('customer_phone', 20).defaultTo(null)
    t.string('customer_address', 500).defaultTo(null)
    t.string('partner_name', 255).defaultTo(null)
    t.string('partner_initials', 8).defaultTo(null)
    t.string('partner_av_class', 10).defaultTo(null)
    t.string('partner_city', 100).defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.timestamp('updated_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))
    t.foreign('request_id').references('id').inTable('requests').onDelete('SET NULL')
    t.foreign('customer_id').references('user_id').inTable('users').onDelete('CASCADE')
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('CASCADE')
    t.index(['state'])
    t.index(['customer_id'])
    t.index(['partner_id'])
  })
}

// Idempotent migration: add columns the original `ensureJobs` didn't ship with.
// Required so the partner's active-job page can compute distance from the
// partner's current location and deep-link to the customer's real coordinates.
async function ensureJobsColumns () {
  if (!(await db.schema.hasTable('jobs'))) return
  const columns = {
    // Taxonomy v2 — bookable leaf carried from the request. `category_name` is
    // the parent; `work_name` is the specific work.
    work_name:      (t) => { t.string('work_name', 120).defaultTo(null); t.index(['work_name']) },
    customer_lat:   (t) => t.decimal('customer_lat', 10, 7).defaultTo(null),
    customer_lng:   (t) => t.decimal('customer_lng', 10, 7).defaultTo(null),
    customer_email: (t) => t.string('customer_email', 255).defaultTo(null),
    // Free-text note paired with the predefined `cancel_reason` so the other
    // party gets the full story when a job is cancelled.
    cancel_note:    (t) => t.text('cancel_note').defaultTo(null),
    // Set when the customer dismisses the post-paid review nag. Acts as a
    // "don't ask again for this job" flag so we don't pester them on every
    // session.
    review_skipped_at: (t) => t.timestamp('review_skipped_at').defaultTo(null),
    // H25 — request photos carried forward when the partner accepts so the
    // chat / job-detail view can keep showing them after acceptance.
    photos:         (t) => t.json('photos').defaultTo(null),
    // M35 — partner-picked ETA in minutes captured at accept time. The
    // active-job header pins this for the customer; the partner can revise
    // it later as travel conditions change.
    eta_min:        (t) => t.integer('eta_min').defaultTo(null),
    // M43 — before/after evidence photos. Partner uploads up to 3 on
    // Working → Completed; surfaces in the customer's job detail + reviews.
    // Separate from `photos` (which carries request photos forward) so
    // disputes can tell apart "what the customer flagged" from "what the
    // partner delivered".
    completion_photos: (t) => t.json('completion_photos').defaultTo(null),
    // H47 — itemized bill the customer sees on PaymentPage. Stored as
    // JSON `{ service, materials, travel }` of integer rupees. Platform
    // fee + GST are derived (not stored). Nullable so legacy jobs without
    // a breakdown fall back to a single agreed_price line.
    line_items:     (t) => t.json('line_items').defaultTo(null),
    // H59 — count of times the review-nag modal surfaced this job. We
    // auto-mark the job as skipped when it crosses MAX_NAGS so a customer
    // who keeps backgrounding the app without submitting OR skipping
    // doesn't see the modal forever.
    review_nag_count: (t) => t.integer('review_nag_count').notNullable().defaultTo(0),
  }
  const checks = await Promise.all(
    Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('jobs', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (missing.length) {
    await db.schema.alterTable('jobs', (t) => missing.forEach((c) => columns[c](t)))
    console.log(`✅ jobs table: added missing columns [${missing.join(', ')}]`)
  }
}

async function ensureScheduledJobs () {
  if (await db.schema.hasTable('scheduled_jobs')) return
  await db.schema.createTable('scheduled_jobs', (t) => {
    t.string('id', 40).notNullable().primary()
    t.string('customer_id', 128).notNullable()
    t.string('partner_id', 128).notNullable()
    t.string('category_name', 80).notNullable()
    t.string('service', 160).notNullable()
    t.string('service_icon', 10).defaultTo(null)
    t.integer('base_price').notNullable().defaultTo(0)
    t.date('schedule_date').notNullable()
    t.string('time_slot', 20).notNullable()
    t.text('notes').defaultTo(null)
    t.enum('status', SCHED_STATUS).notNullable().defaultTo('pending')
    t.string('cancel_reason', 500).defaultTo(null)
    t.text('cancel_note').defaultTo(null)
    t.string('cancelled_by', 20).defaultTo(null)
    t.string('customer_name', 255).defaultTo(null)
    t.string('customer_initials', 8).defaultTo(null)
    t.string('customer_av_class', 10).defaultTo(null)
    t.string('customer_phone', 20).defaultTo(null)
    t.string('customer_address', 500).defaultTo(null)
    t.string('partner_name', 255).defaultTo(null)
    t.string('partner_initials', 8).defaultTo(null)
    t.string('partner_av_class', 10).defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.timestamp('updated_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))
    t.foreign('customer_id').references('user_id').inTable('users').onDelete('CASCADE')
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('CASCADE')
    t.index(['status'])
    t.index(['customer_id'])
    t.index(['partner_id'])
  })
}

// Idempotent migration: add alert-tracking columns introduced for the
// scheduling-alert cron system (T-24h / T-1h / T-15m / T=0 reminders).
async function ensureScheduledJobsAlertColumns () {
  if (!(await db.schema.hasTable('scheduled_jobs'))) return
  const columns = {
    // Taxonomy v2 — bookable leaf. `category_name` is the parent.
    work_name:         (t) => { t.string('work_name', 120).defaultTo(null); t.index(['work_name']) },
    scheduled_at:      (t) => t.dateTime('scheduled_at').defaultTo(null),
    alert_24h_sent:    (t) => t.boolean('alert_24h_sent').notNullable().defaultTo(false),
    alert_1h_sent:     (t) => t.boolean('alert_1h_sent').notNullable().defaultTo(false),
    alert_15m_sent:    (t) => t.boolean('alert_15m_sent').notNullable().defaultTo(false),
    alert_start_sent:  (t) => t.boolean('alert_start_sent').notNullable().defaultTo(false),
    converted_job_id:  (t) => t.string('converted_job_id', 40).defaultTo(null),
    // L52 — optional advance the customer commits to at schedule time.
    // `advance_amount` is the rupee value; `advance_payment_id` links to
    // a row in `payments` once the customer actually pays it.
    advance_amount:    (t) => t.integer('advance_amount').defaultTo(null),
    advance_payment_id:(t) => t.string('advance_payment_id', 40).defaultTo(null),
    // M82 — Reschedule proposal. Either side can propose; the other side
    // accepts/declines. Once accepted, the new date/slot lands on the main
    // schedule_date/time_slot/scheduled_at columns and these clear out.
    reschedule_proposed_date: (t) => t.date('reschedule_proposed_date').defaultTo(null),
    reschedule_proposed_slot: (t) => t.string('reschedule_proposed_slot', 20).defaultTo(null),
    reschedule_proposed_by:   (t) => t.string('reschedule_proposed_by', 20).defaultTo(null), // 'user' | 'partner'
    reschedule_proposed_at:   (t) => t.timestamp('reschedule_proposed_at').defaultTo(null),
    reschedule_note:          (t) => t.text('reschedule_note').defaultTo(null),
  }
  const checks = await Promise.all(
    Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('scheduled_jobs', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (missing.length) {
    await db.schema.alterTable('scheduled_jobs', (t) => missing.forEach((c) => columns[c](t)))
    console.log(`✅ scheduled_jobs table: added missing columns [${missing.join(', ')}]`)
  }
}

// Bug #22: prevent a partner from double-booking the same slot.
// Idempotent — MySQL silently skips duplicate CREATE INDEX.
// Idempotent: re-apply SCHED_STATUS enum so 'converted' is accepted by MySQL.
async function ensureScheduledJobsStatusEnum () {
  if (!(await db.schema.hasTable('scheduled_jobs'))) return
  const enumList = SCHED_STATUS.map((s) => `'${s}'`).join(',')
  try {
    await db.raw(`ALTER TABLE scheduled_jobs MODIFY COLUMN status ENUM(${enumList}) NOT NULL DEFAULT 'pending'`)
  } catch (err) {
    if (!/ENUM|unsupported/i.test(err.message)) throw err
  }
}

async function ensureScheduledJobsConstraint () {
  if (!(await db.schema.hasTable('scheduled_jobs'))) return
  try {
    await db.raw(
      'ALTER TABLE scheduled_jobs ADD UNIQUE INDEX uq_partner_slot (partner_id, schedule_date, time_slot)',
    )
    console.log('✅ scheduled_jobs: added UNIQUE(partner_id, schedule_date, time_slot)')
  } catch (err) {
    // 1061 = Duplicate key name — index already exists, safe to ignore.
    if (!String(err.code).includes('1061') && !String(err.message).includes('Duplicate key name')) throw err
  }
}

async function ensureMessages () {
  if (await db.schema.hasTable('messages')) return
  await db.schema.createTable('messages', (t) => {
    t.increments('id').primary()
    t.string('job_id', 40).notNullable()
    t.string('sender_id', 128).notNullable()
    t.enum('sender_role', ['user','partner','system']).notNullable()
    t.string('sender_initials', 8).defaultTo(null)
    t.text('body').defaultTo(null)
    t.json('attachment').defaultTo(null)   // {type, ...payload}
    t.boolean('read_by_customer').defaultTo(false)
    t.boolean('read_by_partner').defaultTo(false)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.foreign('job_id').references('id').inTable('jobs').onDelete('CASCADE')
    t.index(['job_id'])
  })
}

// Idempotent migration — adds `edited_at` and `deleted_at` so the chat can
// render an "edited" hint after a message is updated and a "deleted" tomb
// after a soft-delete. NULL means the message was never edited / deleted.
// L78 also adds `sender_avatar_url` so chat bubbles can render the
// sender's uploaded photo (snapshot at write time).
async function ensureMessagesEditedColumn () {
  if (!(await db.schema.hasTable('messages'))) return
  const columns = {
    edited_at:         (t) => t.timestamp('edited_at').defaultTo(null),
    deleted_at:        (t) => t.timestamp('deleted_at').defaultTo(null),
    sender_avatar_url: (t) => t.string('sender_avatar_url', 500).defaultTo(null),
  }
  const checks = await Promise.all(
    Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('messages', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (!missing.length) return
  await db.schema.alterTable('messages', (t) => missing.forEach((c) => columns[c](t)))
  console.log(`✅ messages table: added missing columns [${missing.join(', ')}]`)
}

async function ensurePayments () {
  if (await db.schema.hasTable('payments')) return
  await db.schema.createTable('payments', (t) => {
    t.increments('id').primary()
    t.string('job_id', 40).notNullable()
    t.string('customer_id', 128).notNullable()
    t.string('partner_id', 128).notNullable()
    t.integer('amount').notNullable().defaultTo(0)
    t.integer('tip').notNullable().defaultTo(0)
    t.integer('total').notNullable().defaultTo(0)
    t.integer('platform_fee').notNullable().defaultTo(0)
    t.enum('method', PAYMENT_METHODS).notNullable().defaultTo('upi')
    t.enum('status', PAYMENT_STATUS).notNullable().defaultTo('initiated')
    t.timestamp('paid_at').defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.string('razorpay_order_id', 64).defaultTo(null)
    t.string('razorpay_payment_id', 64).defaultTo(null)
    t.string('razorpay_signature', 255).defaultTo(null)
    t.foreign('job_id').references('id').inTable('jobs').onDelete('CASCADE')
    t.foreign('customer_id').references('user_id').inTable('users').onDelete('CASCADE')
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('CASCADE')
    t.index(['job_id'])
    t.index(['razorpay_order_id'])
  })
}

// Idempotent: add the Razorpay columns on DBs that already had the payments
// table before the PSP integration.
async function ensurePaymentsColumns () {
  if (!(await db.schema.hasTable('payments'))) return
  const needs = {
    razorpay_order_id:   (t) => t.string('razorpay_order_id',   64).defaultTo(null),
    razorpay_payment_id: (t) => t.string('razorpay_payment_id', 64).defaultTo(null),
    razorpay_signature:  (t) => t.string('razorpay_signature',  255).defaultTo(null),
    // L52 — 'advance' = paid before slot confirms; 'final' = end-of-job
    // settlement (default). Lets a single job have two payments (advance +
    // final) and lets refund logic know which one to act on.
    purpose:             (t) => t.string('purpose', 20).notNullable().defaultTo('final'),
  }
  const checks = await Promise.all(
    Object.keys(needs).map(async (c) => [c, await db.schema.hasColumn('payments', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (missing.length) {
    await db.schema.alterTable('payments', (t) => missing.forEach((c) => needs[c](t)))
    console.log(`✅ payments table: added missing columns [${missing.join(', ')}]`)
  }

  // M50 — accept 'cash' as a payment method. Idempotent MODIFY COLUMN.
  try {
    await db.raw(
      "ALTER TABLE payments MODIFY COLUMN method ENUM('upi','card','netbanking','cash') NOT NULL DEFAULT 'upi'",
    )
  } catch (err) {
    if (!/ENUM|unsupported/i.test(err.message)) throw err
  }
}

async function ensureWalletTransactions () {
  if (await db.schema.hasTable('wallet_transactions')) return
  await db.schema.createTable('wallet_transactions', (t) => {
    t.string('id', 40).notNullable().primary()
    t.string('partner_id', 128).notNullable()
    t.string('job_id', 40).defaultTo(null)
    t.enum('type', TX_TYPES).notNullable().defaultTo('credit')
    t.string('service', 160).defaultTo(null)
    t.string('customer_name', 255).defaultTo(null)
    t.integer('amount').notNullable().defaultTo(0)
    t.integer('tip').notNullable().defaultTo(0)
    t.integer('total').notNullable().defaultTo(0)
    t.boolean('cleared').notNullable().defaultTo(false)
    t.timestamp('eligible_at').defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('CASCADE')
    t.foreign('job_id').references('id').inTable('jobs').onDelete('SET NULL')
    t.index(['partner_id'])
    t.index(['cleared'])
  })
}

async function ensureWithdrawals () {
  if (await db.schema.hasTable('withdrawals')) return
  await db.schema.createTable('withdrawals', (t) => {
    t.string('id', 40).notNullable().primary()
    t.string('partner_id', 128).notNullable()
    t.integer('amount').notNullable().defaultTo(0)
    t.enum('status', WD_STATUS).notNullable().defaultTo('processing')
    t.string('ref', 40).defaultTo(null)
    t.string('bank_short', 60).defaultTo(null)
    t.timestamp('complete_at').defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.timestamp('updated_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('CASCADE')
    t.index(['partner_id'])
  })
}

async function ensureBankAccounts () {
  if (await db.schema.hasTable('bank_accounts')) return
  await db.schema.createTable('bank_accounts', (t) => {
    t.string('partner_id', 128).notNullable().primary()
    t.string('holder', 255).notNullable()
    t.string('bank_name', 120).notNullable()
    t.string('account_full', 32).notNullable()
    t.string('last4', 8).notNullable()
    t.string('ifsc', 15).notNullable()
    t.timestamp('linked_at').defaultTo(db.fn.now())
    t.timestamp('updated_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('CASCADE')
  })
}

async function ensureReviews () {
  if (await db.schema.hasTable('reviews')) return
  await db.schema.createTable('reviews', (t) => {
    t.increments('id').primary()
    t.string('job_id', 40).notNullable()
    t.string('customer_id', 128).notNullable()
    t.string('partner_id', 128).notNullable()
    t.tinyint('stars').notNullable()
    t.text('comment').defaultTo(null)
    t.string('reviewer_initials', 8).defaultTo(null)
    t.string('reviewer_name', 255).defaultTo(null)
    // H60 — aspect chip tags. Slug strings drawn from a fixed positive +
    // negative vocab on the client. Drives the "On time (87%)" stat on the
    // partner profile. Stored as JSON of slugs so adding chips later is a
    // pure client-side change.
    t.json('tags').defaultTo(null)
    // M61 — single public partner reply per review. Stays NULL until the
    // partner writes one; reply_at lets the UI show "Replied 3d ago".
    t.text('partner_reply').defaultTo(null)
    t.timestamp('partner_reply_at').defaultTo(null)
    // M62 — private "what went wrong" note attached to ≤2★ reviews. Not
    // shown publicly; surfaces as a support ticket internally.
    t.text('support_note').defaultTo(null)
    t.timestamp('support_note_at').defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.unique(['job_id'], { indexName: 'uq_review_job' })
    t.foreign('job_id').references('id').inTable('jobs').onDelete('CASCADE')
    t.foreign('customer_id').references('user_id').inTable('users').onDelete('CASCADE')
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('CASCADE')
    t.index(['partner_id'])
  })
}

// Idempotent migration — backfills the columns added across H60/M61/M62/L78
// on already-existing reviews tables.
async function ensureReviewsColumns () {
  if (!(await db.schema.hasTable('reviews'))) return
  const columns = {
    tags:             (t) => t.json('tags').defaultTo(null),
    partner_reply:    (t) => t.text('partner_reply').defaultTo(null),
    partner_reply_at: (t) => t.timestamp('partner_reply_at').defaultTo(null),
    support_note:     (t) => t.text('support_note').defaultTo(null),
    support_note_at:  (t) => t.timestamp('support_note_at').defaultTo(null),
    // L78 — snapshot of reviewer_avatar_url at the time of review. Same
    // pattern as reviewer_initials/reviewer_name — keeps old reviews
    // intact even if the customer later removes their photo.
    reviewer_avatar_url: (t) => t.string('reviewer_avatar_url', 500).defaultTo(null),
  }
  const checks = await Promise.all(
    Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('reviews', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (missing.length) {
    await db.schema.alterTable('reviews', (t) => missing.forEach((c) => columns[c](t)))
    console.log(`✅ reviews table: added missing columns [${missing.join(', ')}]`)
  }
}

// L63 — Denormalised "top review quote" on the partners row. We refresh it
// inline whenever a new 5★ review lands, so each partner card on the
// browse list can show social proof without a per-partner join.
async function ensurePartnersTopReview () {
  if (!(await db.schema.hasTable('partners'))) return
  const has = await db.schema.hasColumn('partners', 'top_review_quote')
  if (has) return
  await db.schema.alterTable('partners', (t) => {
    t.string('top_review_quote', 200).defaultTo(null)
    t.timestamp('top_review_at').defaultTo(null)
  })
  console.log('✅ partners table: added [top_review_quote, top_review_at]')
}

async function ensureCustomerRatings () {
  if (await db.schema.hasTable('customer_ratings')) return
  await db.schema.createTable('customer_ratings', (t) => {
    t.increments('id').primary()
    t.string('job_id', 40).notNullable()
    t.string('partner_id', 128).notNullable()
    t.string('customer_id', 128).notNullable()
    t.tinyint('stars').notNullable()
    t.text('comment').defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.unique(['job_id'], { indexName: 'uq_crating_job' })
    t.foreign('job_id').references('id').inTable('jobs').onDelete('CASCADE')
    t.index(['customer_id'])
  })
}

async function ensureNotifications () {
  if (await db.schema.hasTable('notifications')) return
  await db.schema.createTable('notifications', (t) => {
    t.increments('id').primary()
    t.string('user_id', 128).notNullable()
    t.enum('type', NOTIF_TYPES).notNullable()
    t.string('title', 255).notNullable()
    t.text('body').defaultTo(null)
    t.string('icon', 10).defaultTo(null)
    t.string('icon_bg', 20).defaultTo(null)
    t.boolean('read').notNullable().defaultTo(false)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.foreign('user_id').references('user_id').inTable('users').onDelete('CASCADE')
    t.index(['user_id', 'read'])
  })
}

// Idempotent ALTER: if NOTIF_TYPES was widened after the table was created
// (e.g. we added 'job_cancelled' / 'payment_received'), re-apply the enum
// so inserts don't bomb out with "Data truncated for column 'type'".
// MySQL is fine with re-running MODIFY COLUMN to the same definition.
async function ensureNotificationsColumns () {
  if (!(await db.schema.hasTable('notifications'))) return
  const enumList = NOTIF_TYPES.map((t) => `'${t}'`).join(',')
  try {
    await db.raw(`ALTER TABLE notifications MODIFY COLUMN type ENUM(${enumList}) NOT NULL`)
  } catch (err) {
    // Non-MySQL drivers (e.g. a test SQLite harness) won't support ENUMs;
    // they're permissive by default so the INSERT will work regardless.
    if (!/ENUM|unsupported/i.test(err.message)) throw err
  }

  // Deep-link target for the in-app notifications list. Mirrors the
  // `data.route` field FCM pushes already carry, so tapping a notification
  // in the bell list lands the user on the same page their lock-screen
  // notification would have. Nullable — older rows + ad-hoc admin
  // broadcasts may not point anywhere.
  if (!(await db.schema.hasColumn('notifications', 'route'))) {
    await db.schema.alterTable('notifications', (t) => t.string('route', 255).defaultTo(null))
    console.log('✅ notifications table: added [route] column')
  }
}

async function ensureActivityLog () {
  if (await db.schema.hasTable('activity_log')) return
  await db.schema.createTable('activity_log', (t) => {
    t.increments('id').primary()
    t.string('partner_id', 128).notNullable()
    t.enum('type', ACT_TYPES).notNullable()
    t.string('title', 255).notNullable()
    t.string('sub', 500).defaultTo(null)
    t.string('icon', 10).defaultTo(null)
    t.string('color', 20).defaultTo(null)
    t.string('job_id', 40).defaultTo(null)
    t.string('customer_name', 255).defaultTo(null)
    t.integer('amount').defaultTo(null)
    t.string('status', 30).defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('CASCADE')
    t.index(['partner_id', 'type'])
    t.index(['created_at'])
  })
}

async function ensureCategoriesColumns () {
  if (!(await db.schema.hasTable('categories'))) return
  const columns = {
    is_active:             (t) => t.boolean('is_active').notNullable().defaultTo(true),
    description:           (t) => t.text('description').defaultTo(null),
    base_price_suggestion: (t) => t.integer('base_price_suggestion').defaultTo(0),
    display_name:          (t) => t.string('display_name', 255).defaultTo(null),
    // Cloudinary image URL — replaces the emoji `icon` for categories in the
    // portal + customer UI. `icon` stays as a fallback when no image is set.
    image_url:             (t) => t.string('image_url', 500).defaultTo(null),
  }
  const checks = await Promise.all(
    Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('categories', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (missing.length) {
    await db.schema.alterTable('categories', (t) => missing.forEach((c) => columns[c](t)))
    console.log(`✅ categories table: added missing columns [${missing.join(', ')}]`)
  }
}

async function ensureWorksColumns () {
  if (!(await db.schema.hasTable('works'))) return
  const columns = {
    // Cloudinary image URL — replaces the emoji `icon` for works in the
    // portal + customer UI. `icon` stays as a fallback when no image is set.
    image_url: (t) => t.string('image_url', 500).defaultTo(null),
  }
  const checks = await Promise.all(
    Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('works', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (missing.length) {
    await db.schema.alterTable('works', (t) => missing.forEach((c) => columns[c](t)))
    console.log(`✅ works table: added missing columns [${missing.join(', ')}]`)
  }
}

async function ensureWithdrawalsColumns () {
  if (!(await db.schema.hasTable('withdrawals'))) return
  const columns = {
    utr_number:    (t) => t.string('utr_number', 100).defaultTo(null),
    transfer_date: (t) => t.date('transfer_date').defaultTo(null),
    admin_remarks: (t) => t.text('admin_remarks').defaultTo(null),
    processed_by:  (t) => t.string('processed_by', 128).defaultTo(null),
  }
  const checks = await Promise.all(
    Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('withdrawals', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (missing.length) {
    await db.schema.alterTable('withdrawals', (t) => missing.forEach((c) => columns[c](t)))
    console.log(`✅ withdrawals table: added missing columns [${missing.join(', ')}]`)
  }
}

async function ensureAppConfig () {
  if (await db.schema.hasTable('app_config')) return
  await db.schema.createTable('app_config', (t) => {
    t.string('key', 100).notNullable().primary()
    t.json('value').notNullable()
    t.string('label', 200).defaultTo(null)
    t.string('type', 30).defaultTo('string')   // 'string' | 'number' | 'boolean' | 'json_array'
    t.timestamp('updated_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))
  })
}

async function seedAppConfig () {
  if (!(await db.schema.hasTable('app_config'))) return
  const defaults = [
    { key: 'request_timer_seconds',   value: JSON.stringify(600),                                                label: 'Request Timer (seconds)',          type: 'number' },
    { key: 'max_request_radius_km',   value: JSON.stringify(10),                                                 label: 'Max Request Radius (km)',          type: 'number' },
    { key: 'wallet_clearance_days',   value: JSON.stringify(3),                                                  label: 'Wallet Clearance Delay (days)',    type: 'number' },
    { key: 'platform_fee_percent',    value: JSON.stringify(0),                                                  label: 'Platform Fee (%)',                 type: 'number' },
    { key: 'emergency_fee_percent',   value: JSON.stringify(25),                                                 label: 'Emergency Fee (%)',                type: 'number' },
    { key: 'min_job_price_inr',       value: JSON.stringify(199),                                                label: 'Minimum Job Price (₹)',            type: 'number' },
    { key: 'service_radius_options',  value: JSON.stringify([3, 5, 10, 15, 25]),                                 label: 'Service Radius Options (km)',      type: 'json_array' },
    { key: 'min_withdrawal_amount',   value: JSON.stringify(1500),                                               label: 'Minimum Withdrawal Amount (₹)',    type: 'number' },
    { key: 'maintenance_mode',        value: JSON.stringify(false),                                              label: 'Maintenance Mode',                 type: 'boolean' },
    { key: 'available_days_options',  value: JSON.stringify(['Mon-Sat','Mon-Sun','Mon-Fri','Weekends only']),     label: 'Available Days Options',           type: 'json_array' },
    { key: 'available_hours_options', value: JSON.stringify(['8am-8pm','6am-10pm','9am-6pm','24/7']),            label: 'Available Hours Options',          type: 'json_array' },
    // ── Phase 2: pricing & trust-gate values (admin-tunable from portal) ──
    { key: 'cancel_fee_inr',              value: JSON.stringify(50),    label: 'Cancellation Fee (₹)',                  type: 'number' },
    { key: 'auto_refund_max_inr',         value: JSON.stringify(500),   label: 'Auto-Refund Cap (₹)',                   type: 'number' },
    { key: 'auto_refund_window_hours',    value: JSON.stringify(24),    label: 'Auto-Refund Window (hours)',            type: 'number' },
    { key: 'default_base_price_inr',      value: JSON.stringify(299),   label: 'Default Starting Quote (₹)',            type: 'number' },
    { key: 'gst_pct',                     value: JSON.stringify(18),    label: 'GST on Platform Fee (%)',               type: 'number' },
    { key: 'trust_min_jobs',              value: JSON.stringify(10),    label: 'Trust Gate: Min Completed Jobs',        type: 'number' },
    { key: 'trust_cancel_lookback_days',  value: JSON.stringify(7),     label: 'Trust Gate: Cancel Lookback (days)',    type: 'number' },
    { key: 'trust_dispute_lookback_days', value: JSON.stringify(30),    label: 'Trust Gate: Dispute Lookback (days)',   type: 'number' },
    // ── Phase 3: policy windows + matching parameters ──
    { key: 'dispute_window_hours',          value: JSON.stringify(48),                    label: 'Dispute Window (hours after payment)',     type: 'number' },
    { key: 'free_cancel_window_sec',        value: JSON.stringify(90),                    label: 'Free Cancellation Window (seconds)',       type: 'number' },
    { key: 'reschedule_lock_hours',         value: JSON.stringify(4),                     label: 'Reschedule Lock Before Start (hours)',     type: 'number' },
    { key: 'stale_job_hours',               value: JSON.stringify(48),                    label: 'Stale Job Auto-Abandon (hours)',           type: 'number' },
    { key: 'account_delete_grace_days',     value: JSON.stringify(7),                     label: 'Account Deletion Grace (days)',            type: 'number' },
    { key: 'partner_flag_cooldown_hours',   value: JSON.stringify(24),                    label: 'Partner Flag Cooldown (hours/customer)',   type: 'number' },
    { key: 'auto_match_radius_rings',       value: JSON.stringify([10, 25, 50, 100]),     label: 'Auto-Match Radius Rings (km)',             type: 'json_array' },
    { key: 'default_search_radius_km',      value: JSON.stringify(10),                    label: 'Default Search Radius (km)',               type: 'number' },
    { key: 'max_user_radius_km',            value: JSON.stringify(50),                    label: 'Max User-Adjustable Radius (km)',          type: 'number' },
    { key: 'partner_snooze_min',            value: JSON.stringify(5),                     label: 'Partner Request Snooze (minutes)',         type: 'number' },
    // ── Phase 4: per-user limits + ETA formula ──
    { key: 'max_trusted_contacts',          value: JSON.stringify(5),                     label: 'Max Trusted Contacts per User',            type: 'number' },
    { key: 'max_saved_addresses',           value: JSON.stringify(8),                     label: 'Max Saved Addresses per User',             type: 'number' },
    { key: 'max_review_nags',               value: JSON.stringify(3),                     label: 'Max Review Reminders per Job',             type: 'number' },
    { key: 'activity_log_cap',              value: JSON.stringify(500),                   label: 'Activity Log Cap per Partner',             type: 'number' },
    { key: 'eta_speed_kmph',                value: JSON.stringify(20),                    label: 'ETA Travel Speed (km/h)',                  type: 'number' },
    { key: 'eta_buffer_min',                value: JSON.stringify(5),                     label: 'ETA Buffer (minutes)',                     type: 'number' },
    { key: 'live_eta_speed_kmph',           value: JSON.stringify(22),                    label: 'Live ETA Speed (km/h)',                    type: 'number' },
    { key: 'eta_inside_area_m',             value: JSON.stringify(200),                   label: 'ETA "Inside Area" Threshold (m)',          type: 'number' },
  ]
  for (const row of defaults) {
    await db('app_config').insert(row).onConflict('key').ignore()
  }
  await db('app_config').where({ key: 'response_time_options' }).del()
}

async function ensureAnnouncements () {
  if (await db.schema.hasTable('announcements')) return
  await db.schema.createTable('announcements', (t) => {
    t.increments('id').primary()
    t.string('title', 200).notNullable()
    t.text('body').defaultTo(null)
    t.enum('type', ['info','warning','promo','maintenance']).defaultTo('info')
    t.enum('target', ['all','users','partners']).defaultTo('all')
    t.string('city', 100).defaultTo(null)
    t.string('image_url', 500).defaultTo(null)
    t.string('action_url', 500).defaultTo(null)
    t.boolean('active').notNullable().defaultTo(true)
    t.timestamp('starts_at').defaultTo(null)
    t.timestamp('ends_at').defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.timestamp('updated_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))
    t.index(['active'])
    t.index(['target'])
  })
}

async function ensureAdminAuditLog () {
  if (await db.schema.hasTable('admin_audit_log')) return
  await db.schema.createTable('admin_audit_log', (t) => {
    t.increments('id').primary()
    t.string('admin_id', 128).defaultTo(null)
    t.string('admin_email', 200).defaultTo(null)
    t.string('action', 100).notNullable()
    t.string('target_type', 50).defaultTo(null)
    t.string('target_id', 128).defaultTo(null)
    t.json('before_data').defaultTo(null)
    t.json('after_data').defaultTo(null)
    t.string('ip', 50).defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.index(['admin_id'])
    t.index(['action'])
    t.index(['target_type', 'target_id'])
  })
}

// H26 — Customer address book. Lets a customer book on behalf of someone
// else (parent's house, office) without overwriting their profile address.
// `label` is a free-text bucket name (Home / Office / Mom / …); the UI
// suggests common labels but doesn't constrain. `is_default` is enforced
// at the controller layer — at most one default per user at a time.
async function ensureSavedAddresses () {
  if (await db.schema.hasTable('saved_addresses')) return
  await db.schema.createTable('saved_addresses', (t) => {
    t.increments('id').primary()
    t.string('user_id', 128).notNullable()
    t.string('label',   60).defaultTo('Other')   // Home | Office | Other | <custom>
    t.string('address', 500).notNullable()
    t.string('city',    120).defaultTo(null)
    t.string('pincode', 12).defaultTo(null)
    t.decimal('lat', 10, 7).defaultTo(null)
    t.decimal('lng', 10, 7).defaultTo(null)
    t.boolean('is_default').notNullable().defaultTo(false)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.timestamp('updated_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))
    t.foreign('user_id').references('user_id').inTable('users').onDelete('CASCADE')
    t.index(['user_id'])
  })
}

// Add city/pincode to existing saved_addresses tables.
async function ensureSavedAddressesColumns () {
  if (!(await db.schema.hasTable('saved_addresses'))) return
  const columns = {
    city:    (t) => t.string('city', 120).defaultTo(null),
    pincode: (t) => t.string('pincode', 12).defaultTo(null),
  }
  const checks = await Promise.all(
    Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('saved_addresses', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (missing.length) {
    await db.schema.alterTable('saved_addresses', (t) => missing.forEach((c) => columns[c](t)))
    console.log(`✅ saved_addresses: added missing columns [${missing.join(', ')}]`)
  }
}

// M21 — Customer-saved partners. One row per (user, partner). Drives both
// the star button on partner cards and the "Saved" section on the home
// page. We keep the row count cheap by treating "unfavourite" as a DELETE
// rather than a soft-flag column.
async function ensureFavourites () {
  if (await db.schema.hasTable('favourites')) return
  await db.schema.createTable('favourites', (t) => {
    t.increments('id').primary()
    t.string('user_id',    128).notNullable()
    t.string('partner_id', 128).notNullable()
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.unique(['user_id', 'partner_id'], { indexName: 'uq_favourite' })
    t.foreign('user_id').references('user_id').inTable('users').onDelete('CASCADE')
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('CASCADE')
    t.index(['user_id'])
  })
}

// Safety alerts — every SOS press and "share live trip" event lands here so
// Saved trusted contacts — customer-only address book for share-trip /
// future emergency-contact features. Capped at 5 per user (enforced in
// controller). One default at a time (also enforced in controller — we
// flip the previous default to false on every "set default" write).
async function ensureTrustedContacts () {
  if (await db.schema.hasTable('trusted_contacts')) return
  await db.schema.createTable('trusted_contacts', (t) => {
    t.increments('id').primary()
    t.string('user_id', 128).notNullable()
    t.string('name', 120).notNullable()
    t.string('phone', 20).notNullable()
    t.string('relation', 60).defaultTo(null)
    t.boolean('is_default').notNullable().defaultTo(false)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.timestamp('updated_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))
    t.foreign('user_id').references('user_id').inTable('users').onDelete('CASCADE')
    t.index(['user_id'])
  })
}

// H64 — Idempotent migration for disputes timeline columns. Adds the
// "under review" and "partner response" milestones that drive the
// customer-facing status timeline. Created_at/resolved_at already exist
// on the table — this fills in the intermediate steps.
async function ensureDisputesTimelineColumns () {
  if (!(await db.schema.hasTable('disputes'))) return
  const columns = {
    under_review_at:       (t) => t.timestamp('under_review_at').defaultTo(null),
    under_review_by:       (t) => t.string('under_review_by', 128).defaultTo(null),
    partner_response_at:   (t) => t.timestamp('partner_response_at').defaultTo(null),
    partner_response_note: (t) => t.text('partner_response_note').defaultTo(null),
  }
  const checks = await Promise.all(
    Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('disputes', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (missing.length) {
    await db.schema.alterTable('disputes', (t) => missing.forEach((c) => columns[c](t)))
    console.log(`✅ disputes table: added missing columns [${missing.join(', ')}]`)
  }
}

// M83 — Partner-side "block dates" calendar. Each row is one date the
// partner is unavailable. Customers shouldn't be offered scheduled slots
// on these dates. We deliberately key on (partner_id, blocked_date) so
// unblocking is just a DELETE.
async function ensurePartnerBlockedDates () {
  if (await db.schema.hasTable('partner_blocked_dates')) return
  await db.schema.createTable('partner_blocked_dates', (t) => {
    t.increments('id').primary()
    t.string('partner_id', 128).notNullable()
    t.date('blocked_date').notNullable()
    t.string('reason', 200).defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.unique(['partner_id', 'blocked_date'], { indexName: 'uq_partner_blocked' })
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('CASCADE')
    t.index(['blocked_date'])
  })
}

// M68 — Customer-side "Report this partner" flags. Independent of disputes
// — these are about behaviour on the platform (off-platform payment asks,
// misleading profile) rather than a single job. Multiple flags per partner
// allowed; admin reviews and either dismisses or actions.
async function ensurePartnerFlags () {
  if (await db.schema.hasTable('partner_flags')) return
  await db.schema.createTable('partner_flags', (t) => {
    t.increments('id').primary()
    t.string('partner_id', 128).notNullable()
    t.string('reporter_id', 128).notNullable()
    t.enum('reason', ['inappropriate', 'misleading', 'off_platform_payment', 'other']).notNullable()
    t.text('note').defaultTo(null)
    t.enum('status', ['open', 'reviewed', 'dismissed']).notNullable().defaultTo('open')
    t.string('admin_id', 128).defaultTo(null)
    t.text('admin_note').defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.timestamp('reviewed_at').defaultTo(null)
    t.foreign('partner_id').references('user_id').inTable('partners').onDelete('CASCADE')
    t.foreign('reporter_id').references('user_id').inTable('users').onDelete('CASCADE')
    t.index(['partner_id'])
    t.index(['status'])
  })
}

// Disputes — customer/partner can flag a paid or completed job. Admin
// resolves from the portal. We enforce "one open dispute per job" at the
// controller layer (MySQL doesn't support partial unique indexes).
async function ensureDisputes () {
  if (await db.schema.hasTable('disputes')) return
  await db.schema.createTable('disputes', (t) => {
    t.increments('id').primary()
    t.string('job_id', 40).notNullable()
    t.string('raised_by', 128).notNullable()
    t.enum('raised_role', ['user', 'partner']).notNullable()
    t.string('partner_id', 128).notNullable()        // denormalised for fast trust-gate / portal lookups
    t.string('customer_id', 128).notNullable()
    t.text('reason').notNullable()
    t.enum('status', ['open', 'resolved', 'dismissed']).notNullable().defaultTo('open')
    t.enum('resolution', ['refund', 'warn_partner', 'dismissed', 'resolved']).defaultTo(null)
    t.text('resolution_note').defaultTo(null)
    t.string('admin_id', 128).defaultTo(null)
    t.integer('refund_amount').defaultTo(null)        // rupees of refund actually issued
    t.string('refund_id', 64).defaultTo(null)         // Razorpay refund id
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.timestamp('resolved_at').defaultTo(null)
    t.foreign('job_id').references('id').inTable('jobs').onDelete('CASCADE')
    t.foreign('raised_by').references('user_id').inTable('users').onDelete('CASCADE')
    t.index(['job_id'])
    t.index(['status'])
    t.index(['partner_id'])
    t.index(['created_at'])
  })
}

// admin/ops can audit, follow up, and (eventually) close the loop. The
// `share_token` is the public bearer for the live tracking link.
async function ensureSafetyAlerts () {
  if (await db.schema.hasTable('safety_alerts')) return
  await db.schema.createTable('safety_alerts', (t) => {
    t.string('id', 40).notNullable().primary()
    t.string('job_id', 40).notNullable()
    t.string('customer_id', 128).notNullable()
    t.string('partner_id', 128).notNullable()
    t.enum('type', ['sos', 'share', 'partner_share']).notNullable()
    t.string('contact_phone', 20).defaultTo(null)
    t.string('contact_name', 120).defaultTo(null)
    t.string('share_token', 64).defaultTo(null)
    t.string('note', 500).defaultTo(null)
    t.decimal('lat', 10, 7).defaultTo(null)
    t.decimal('lng', 10, 7).defaultTo(null)
    t.enum('status', ['active', 'resolved']).notNullable().defaultTo('active')
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.timestamp('resolved_at').defaultTo(null)
    t.foreign('job_id').references('id').inTable('jobs').onDelete('CASCADE')
    t.foreign('customer_id').references('user_id').inTable('users').onDelete('CASCADE')
    t.index(['job_id'])
    t.index(['status'])
    t.index(['share_token'])
  })
}

// Idempotent migration — backfills resolution columns on existing safety_alerts
// tables. resolved_by tracks which admin closed the alert; resolution_note
// stores the optional follow-up text shown in audit + the customer push.
async function ensureSafetyAlertsColumns () {
  if (!(await db.schema.hasTable('safety_alerts'))) return
  const columns = {
    resolved_by:     (t) => t.string('resolved_by', 128).defaultTo(null),
    resolution_note: (t) => t.text('resolution_note').defaultTo(null),
  }
  const checks = await Promise.all(
    Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('safety_alerts', c)]),
  )
  const missing = checks.filter(([, has]) => !has).map(([c]) => c)
  if (missing.length) {
    await db.schema.alterTable('safety_alerts', (t) => missing.forEach((c) => columns[c](t)))
    console.log(`✅ safety_alerts table: added missing columns [${missing.join(', ')}]`)
  }

  // Widen the type enum to accept partner_share (added when partner-side
  // trip sharing shipped). Re-running MODIFY COLUMN with the same definition
  // is a MySQL no-op, so this is safe to call on every boot.
  try {
    await db.raw(
      "ALTER TABLE safety_alerts MODIFY COLUMN type ENUM('sos','share','partner_share') NOT NULL"
    )
  } catch (err) {
    if (!/ENUM|unsupported/i.test(err.message)) throw err
  }
}

// FCM device tokens — one row per (user, token). A user can have multiple
// devices (phone + tablet + web), so we key on the token itself but track
// the owner. `last_seen_at` is bumped on every register call so a cron can
// prune devices that haven't checked in for a while.
async function ensureFcmTokens () {
  if (await db.schema.hasTable('fcm_tokens')) return
  await db.schema.createTable('fcm_tokens', (t) => {
    t.string('token', 512).notNullable().primary()
    t.string('user_id', 128).notNullable()
    t.string('platform', 20).defaultTo('web')   // 'web' | 'android' | 'ios'
    t.string('user_agent', 255).defaultTo(null)
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.timestamp('last_seen_at').defaultTo(db.fn.now())
    t.foreign('user_id').references('user_id').inTable('users').onDelete('CASCADE')
    t.index(['user_id'])
  })
}

// Push delivery log — one row per pushService.sendToTokens() call. Lets
// admins debug why a user isn't receiving notifications: token expired,
// firebase rejected, or the controller never fired in the first place.
// We DON'T store the tokens themselves (those are in fcm_tokens) — just
// the aggregate counts and the unique FCM error codes seen so admins
// can spot patterns (e.g. all-failed = config issue, partial-failed =
// stale tokens).
async function ensurePushLog () {
  if (await db.schema.hasTable('push_log')) return
  await db.schema.createTable('push_log', (t) => {
    t.increments('id').primary()
    t.string('user_id', 128).defaultTo(null)
    t.string('type', 60).defaultTo(null)            // payload.data.type if caller set it
    t.string('title', 255).defaultTo(null)
    t.integer('sent').notNullable().defaultTo(0)
    t.integer('failed').notNullable().defaultTo(0)
    t.json('error_codes_json').defaultTo(null)      // unique FCM err codes seen this batch
    t.timestamp('created_at').defaultTo(db.fn.now())
    t.index(['user_id'])
    t.index(['type'])
    t.index(['created_at'])
  })
}

async function ensureSettings () {
  if (await db.schema.hasTable('app_settings')) {
    // H53 — mute_promos; M56 — quiet_hours_on; M77 — locale. Added on
    // existing tables so older installs pick the flags up on next boot
    // without dropping the table.
    const columns = {
      mute_promos:     (t) => t.boolean('mute_promos').notNullable().defaultTo(false),
      quiet_hours_on:  (t) => t.boolean('quiet_hours_on').notNullable().defaultTo(false),
      locale:          (t) => t.string('locale', 8).notNullable().defaultTo('en'),
    }
    const checks = await Promise.all(
      Object.keys(columns).map(async (c) => [c, await db.schema.hasColumn('app_settings', c)]),
    )
    const missing = checks.filter(([, has]) => !has).map(([c]) => c)
    if (missing.length) {
      await db.schema.alterTable('app_settings', (t) => missing.forEach((c) => columns[c](t)))
      console.log(`✅ app_settings table: added missing columns [${missing.join(', ')}]`)
    }
    return
  }
  await db.schema.createTable('app_settings', (t) => {
    t.string('user_id', 128).notNullable().primary()
    t.boolean('sound_on').defaultTo(true)
    t.boolean('push_on').defaultTo(true)
    t.boolean('email_on').defaultTo(false)
    t.boolean('dev_mode').defaultTo(true)
    t.boolean('dark_mode').defaultTo(false)
    // H53 — silences the 'promo' notification category. Affects both the
    // in-app notifications list (filtered out by default) and push fan-out
    // (skipped by pushService for this user).
    t.boolean('mute_promos').notNullable().defaultTo(false)
    // M56 — quiet hours: when on, pushService drops Promos and queues
    // non-urgent notifications during 22:00–07:00 local. Active-job
    // notifications always go through.
    t.boolean('quiet_hours_on').notNullable().defaultTo(false)
    // M77 — UI locale (BCP-47-ish short code). 'en' or 'ta' today; more
    // can be added without a migration.
    t.string('locale', 8).notNullable().defaultTo('en')
    t.timestamp('updated_at').defaultTo(db.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'))
    t.foreign('user_id').references('user_id').inTable('users').onDelete('CASCADE')
  })
}

// Seed the PARENT categories. Idempotent and non-destructive: existing rows
// (incl. admin-edited sort_order / display_name) are left untouched via
// onConflict.ignore(). On a legacy DB this inserts the new parents alongside
// the 16 leaf rows — seedWorks() then moves the leaves into `works` and
// removes them from `categories`.
async function seedCategories () {
  for (let i = 0; i < CATEGORIES.length; i++) {
    const c = CATEGORIES[i]
    await db('categories')
      .insert({ name: c.name, icon: c.icon, pin_color: c.pin_color, sort_order: i, is_active: true })
      .onConflict('name')
      .ignore()
  }
}

// Seed WORKS + one-time migration of legacy data. The works upsert runs every
// boot (idempotent ignore); the destructive backfill (steps 3–5) runs once,
// gated by the `taxonomy_v2_migrated` app_config flag.
async function seedWorks () {
  if (!(await db.schema.hasTable('works'))) return

  // 1. Upsert each work. On first migration we copy any admin-tuned attributes
  //    from the matching legacy category row before it gets removed.
  for (let i = 0; i < WORKS.length; i++) {
    const w = WORKS[i]
    const legacy = await db('categories').where({ name: w.name }).first().catch(() => null)
    await db('works')
      .insert({
        name:                  w.name,
        category_name:         w.category,
        icon:                  legacy?.icon || w.icon,
        pin_color:             legacy?.pin_color || w.pin_color,
        display_name:          legacy?.display_name || w.name,
        description:           legacy?.description || null,
        base_price_suggestion: legacy?.base_price_suggestion || 0,
        sort_order:            (legacy && legacy.sort_order != null) ? legacy.sort_order : i,
        is_active:             legacy ? !!legacy.is_active : true,
      })
      .onConflict('name')
      .ignore()
  }

  // Gate the destructive backfill.
  const flagRow = await db('app_config').where({ key: 'taxonomy_v2_migrated' }).first().catch(() => null)
  const isMigrated = (() => {
    if (!flagRow) return false
    let v = flagRow.value
    if (typeof v === 'string') { try { v = JSON.parse(v) } catch { /* keep raw */ } }
    return v === true || v === 'true' || v === 1
  })()
  if (isMigrated) return

  const legacyNames = WORKS.map((w) => w.name)

  // 2. Copy the legacy leaf value into the new work_name columns.
  if (await db.schema.hasColumn('partners', 'primary_work')) {
    await db('partners').whereNotNull('primary_category').whereNull('primary_work')
      .update({ primary_work: db.ref('primary_category') })
  }
  for (const tbl of ['requests', 'jobs', 'scheduled_jobs']) {
    if (await db.schema.hasColumn(tbl, 'work_name')) {
      await db(tbl).whereNull('work_name').whereNotNull('category_name')
        .update({ work_name: db.ref('category_name') })
    }
  }

  // 3. Promote the parent into the category columns, keyed off the leaf.
  for (const [work, parent] of Object.entries(WORK_PARENT)) {
    await db('partners').where({ primary_work: work }).update({ primary_category: parent })
    for (const tbl of ['requests', 'jobs', 'scheduled_jobs']) {
      await db(tbl).where({ work_name: work }).update({ category_name: parent })
    }
  }

  // 4. Remove the legacy leaf rows from `categories` (they now live in works).
  //    Safe: the only FK that pointed here (partner_category_prices) was
  //    dropped + renamed by ensurePartnerWorkPrices, which runs first.
  await db('categories').whereIn('name', legacyNames).del().catch(() => {})

  // 5. Mark migration complete.
  await db('app_config')
    .insert({ key: 'taxonomy_v2_migrated', value: JSON.stringify(true), label: 'Taxonomy v2 migrated', type: 'boolean' })
    .onConflict('key').merge({ value: JSON.stringify(true) })
  console.log('✅ taxonomy v2: works seeded + legacy data backfilled (work_name + parent category)')
}

async function runMigrations () {
  await ensureUsers()
  await ensureCategories()
  await ensurePartners()
  await ensurePartnersPrimaryWork()
  await ensurePartnerCategoryPrices()
  await ensureUserLocations()
  await ensureRequests()
  await ensureRequestsColumns()
  await ensureJobs()
  await ensureJobsColumns()
  await ensureJobsProximityColumn()
  await ensureScheduledJobs()
  await ensureScheduledJobsAlertColumns()
  await ensureScheduledJobsStatusEnum()
  await ensureScheduledJobsConstraint()
  await ensureMessages()
  await ensureMessagesEditedColumn()
  await ensurePayments()
  await ensurePaymentsColumns()
  await ensureWalletTransactions()
  await ensureWithdrawals()
  await ensureBankAccounts()
  await ensureReviews()
  await ensureReviewsColumns()
  await ensurePartnersTopReview()
  await ensureCustomerRatings()
  await ensureNotifications()
  await ensureNotificationsColumns()
  await ensureActivityLog()
  await ensureSafetyAlerts()
  await ensureSafetyAlertsColumns()
  await ensureTrustedContacts()
  await ensureFavourites()
  await ensureSavedAddresses()
  await ensureSavedAddressesColumns()
  await ensureDisputes()
  await ensureDisputesTimelineColumns()
  await ensurePartnerFlags()
  await ensurePartnerBlockedDates()
  await ensureFcmTokens()
  await ensurePushLog()
  await ensureSettings()
  await ensureGeocodeCache()
  await ensureCategoriesColumns()
  await ensureWorks()
  await ensureWorksColumns()
  await ensurePartnerWorkPrices()
  await ensureWithdrawalsColumns()
  await ensureAppConfig()
  await ensureAnnouncements()
  await ensureAdminAuditLog()
  await seedCategories()
  await seedWorks()
  await seedAppConfig()
  console.log('✅ Schema ensured (all tables + category/works seed)')
}

module.exports = { runMigrations }
