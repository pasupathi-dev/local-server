// Small, human-readable ids. Not cryptographic.
const rnd = (n) => Math.random().toString(36).slice(2, 2 + n)

const initials = (name, fallback = 'U') => {
  if (!name) return fallback
  const parts = String(name).trim().split(/\s+/).slice(0, 2)
  return parts.map((p) => p[0] || '').join('').toUpperCase() || fallback
}

const avatarClass = (seed = '') => {
  const classes = ['pav-a','pav-b','pav-c','pav-d','pav-e']
  let h = 0
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return classes[h % classes.length]
}

module.exports = {
  requestId:  () => `req-${Date.now().toString(36)}-${rnd(4)}`,
  jobId:      () => `SL-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
  scheduleId: () => `SCH-${Date.now().toString(36)}-${rnd(4)}`,
  txId:       () => `tx-${Date.now().toString(36)}-${rnd(4)}`,
  wdId:       () => `wd-${Date.now().toString(36)}-${rnd(4)}`,
  actId:      () => `act-${Date.now().toString(36)}-${rnd(4)}`,
  wdRef:      () => `WD${Math.floor(1000000 + Math.random() * 9000000)}`,
  initials,
  avatarClass,
}
