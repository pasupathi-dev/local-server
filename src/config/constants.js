// Shared enums & static taxonomy. Mirror the prototype (local.html).
// Any change here must propagate to the client `src/constants/` too.
//
// TWO-LEVEL TAXONOMY (taxonomy v2):
//   CATEGORIES = parent groupings (browse-only). e.g. "Electric & Electronic".
//   WORKS      = the bookable leaf unit; matching + pricing happen here.
//                Each work points at its parent category via `category`.
// The 16 flat categories that pre-dated this change become the seed WORKS,
// grouped under the six parents below. schema.js → seedWorks() derives the
// work→parent map from WORKS and migrates existing data once.

const CATEGORIES = [
  { name: 'Electric & Electronic', icon: '⚡', pin_color: '#065f46' },
  { name: 'Plumbing & Water',      icon: '🚿', pin_color: '#5b21b6' },
  { name: 'Cleaning & Pest Control', icon: '🧹', pin_color: '#be185d' },
  { name: 'Construction & Repair', icon: '🔨', pin_color: '#92400e' },
  { name: 'Auto & Transport',      icon: '🚗', pin_color: '#334155' },
  { name: 'Home & Lifestyle',      icon: '🏠', pin_color: '#c2410c' },
]

// Seed works — the 16 legacy categories, each slotted under a parent. The
// `name` values are intentionally identical to the legacy category names so
// the one-time backfill can repoint partner prices / requests / jobs without
// rewriting any values (legacy `category_name` already holds these strings).
const WORKS = [
  { name: 'Electrician',  category: 'Electric & Electronic',   icon: '⚡',  pin_color: '#065f46' },
  { name: 'AC Repair',    category: 'Electric & Electronic',   icon: '❄️',  pin_color: '#0e7490' },
  { name: 'TV Repair',    category: 'Electric & Electronic',   icon: '📺',  pin_color: '#7c3aed' },
  { name: 'Plumber',      category: 'Plumbing & Water',        icon: '🚿',  pin_color: '#5b21b6' },
  { name: 'Cleaning',     category: 'Cleaning & Pest Control', icon: '🧹',  pin_color: '#be185d' },
  { name: 'Pest Control', category: 'Cleaning & Pest Control', icon: '🐛',  pin_color: '#7c2d12' },
  { name: 'Laundry',      category: 'Cleaning & Pest Control', icon: '👕',  pin_color: '#0369a1' },
  { name: 'Carpenter',    category: 'Construction & Repair',   icon: '🔨',  pin_color: '#92400e' },
  { name: 'Welding',      category: 'Construction & Repair',   icon: '🔩',  pin_color: '#1f2937' },
  { name: 'Tiling',       category: 'Construction & Repair',   icon: '🔲',  pin_color: '#374151' },
  { name: 'Painter',      category: 'Construction & Repair',   icon: '🎨',  pin_color: '#b45309' },
  { name: 'Mechanic',     category: 'Auto & Transport',        icon: '🔧',  pin_color: '#1e40af' },
  { name: 'Driver',       category: 'Auto & Transport',        icon: '🚗',  pin_color: '#334155' },
  { name: 'Cooking',      category: 'Home & Lifestyle',        icon: '🍳',  pin_color: '#c2410c' },
  { name: 'Gardening',    category: 'Home & Lifestyle',        icon: '🌱',  pin_color: '#15803d' },
  { name: 'Security',     category: 'Home & Lifestyle',        icon: '🔒',  pin_color: '#111827' },
]

// work name → parent category name. Derived from WORKS; used by the schema
// backfill and by controllers that need to resolve a work's parent.
const WORK_PARENT = WORKS.reduce((m, w) => { m[w.name] = w.category; return m }, {})

// Skills keyed by WORK name (legacy category name). Client-side search only.
const CATEGORY_SKILLS = {
  'Carpenter':    ['Door Repair','Door Fitting','Cabinet Making','Furniture Repair','Wood Polish','Teak Work','Wardrobe Fitting','Renovation','Carpentry','Wood Work','Modular'],
  'Electrician':  ['Wiring','Fan Installation','Switchboard','Inverter Setup','Solar Panel','Electrical Repair','Power Issues'],
  'Plumber':      ['Pipe Repair','Tap Fitting','Bathroom','Water Tank','Drainage','Leakage Fix','Plumbing','Sanitary'],
  'Mechanic':     ['Car Repair','Bike Repair','Engine Fix','Tyre Change','Oil Change','Vehicle Service','Auto Repair'],
  'Painter':      ['Wall Painting','Interior Painting','Exterior','Whitewash','Texture Paint','Enamel Paint'],
  'AC Repair':    ['AC Service','AC Repair','Air Conditioner','Cooling Issue','AC Gas Refill','AC Installation','AC Cleaning'],
  'Cleaning':     ['Deep Cleaning','Home Cleaning','Sofa Cleaning','Bathroom Cleaning','Kitchen Cleaning','Floor Cleaning'],
  'Tiling':       ['Floor Tiling','Wall Tiling','Tile Repair','Mosaic','Grouting','Tile Work'],
  'Welding':      ['Iron Welding','Gate Welding','Railing','Metal Work'],
  'Pest Control': ['Cockroach','Termite','Bedbugs','Rat Control','Mosquito','Pest Spray'],
  'Laundry':      ['Washing','Dry Cleaning','Ironing','Steam Iron'],
  'Gardening':    ['Garden Maintenance','Plant Care','Lawn Mowing','Trimming','Landscaping'],
  'TV Repair':    ['TV Repair','LED Repair','Set Top Box','Home Theater','Display Fix','Electronics Repair'],
  'Cooking':      ['Home Cook','Party Cooking','Catering','Meal Prep','Chef','Tiffin Service'],
  'Driver':       ['Car Driver','Cab Driver','Designated Driver','School Cab','Driver Service'],
  'Security':     ['Security Guard','Night Watch','CCTV Installation','Access Control'],
}

const ROLES            = ['user', 'partner', 'admin']
const USER_STATUSES    = ['active', 'inactive', 'suspended', 'pending']
const AVATAR_CLASSES   = ['pav-a','pav-b','pav-c','pav-d','pav-e']
const REQUEST_STATUS   = ['live','accepted','declined','expired','cancelled']
const JOB_STATES       = ['accepted','priceConfirmed','travelling','arrived','working','completed','paid','cancelled']
const SCHED_STATUS     = ['pending','accepted','declined','cancelled','converted']
const PAYMENT_STATUS   = ['initiated','processing','completed','failed']
const PAYMENT_METHODS  = ['upi','card','netbanking']
const TX_TYPES         = ['credit','pending']
const WD_STATUS        = ['processing','completed','cancelled']
const NOTIF_TYPES      = ['job_completed','price_updated','request_accepted','new_review','promo','schedule_accepted','schedule_declined','schedule_cancelled','job_cancelled','payment_received','dispute_opened','safety_sos']
const ACT_TYPES        = [
  // jobs
  'request_received','request_accepted','request_declined','price_updated','price_confirmed',
  'travelling','arrived','work_started','work_completed','job_cancelled','customer_rated',
  'schedule_accepted','schedule_declined','schedule_cancelled',
  // earnings
  'payment_received','withdrawal_initiated','withdrawal_completed','withdrawal_cancelled',
  // account
  'bank_linked','bank_updated','bank_removed','online_toggled','setting_changed','profile_updated',
]
const AVAIL_DAYS       = ['Mon-Sat','Mon-Sun','Mon-Fri','Weekends only']
const AVAIL_HOURS      = ['8am-8pm','6am-10pm','9am-6pm','24/7']

const PENDING_CLEAR_DELAY_MS  = 5000
const WD_PROCESSING_DELAY_MS  = 6000
const REQUEST_TIMER_SECONDS   = 600   // 10 min default; overridden per partner via timer_seconds in request body
const MIN_WITHDRAW            = 1500
const ACTIVITY_LOG_CAP        = 500

module.exports = {
  CATEGORIES, WORKS, WORK_PARENT, CATEGORY_SKILLS,
  ROLES, USER_STATUSES, AVATAR_CLASSES,
  REQUEST_STATUS, JOB_STATES, SCHED_STATUS,
  PAYMENT_STATUS, PAYMENT_METHODS, TX_TYPES, WD_STATUS,
  NOTIF_TYPES, ACT_TYPES,
  AVAIL_DAYS, AVAIL_HOURS,
  PENDING_CLEAR_DELAY_MS, WD_PROCESSING_DELAY_MS,
  REQUEST_TIMER_SECONDS, MIN_WITHDRAW, ACTIVITY_LOG_CAP,
}
