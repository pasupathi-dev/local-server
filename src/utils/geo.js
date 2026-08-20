// Geo helpers shared across controllers (request, job, partner).

const R_KM = 6371

function haversineKm (lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null
  const toRad = (d) => (Number(d) * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2))
          * Math.sin(dLng / 2) ** 2
  return R_KM * 2 * Math.asin(Math.sqrt(a))
}

module.exports = { haversineKm }
