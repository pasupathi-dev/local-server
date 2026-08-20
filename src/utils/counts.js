// Shared "online counts changed" broadcaster. Emits the global
// `categories:counts` event with both the per-PARENT rollup (`counts`, used by
// the home category grid) and the per-WORK breakdown (`workCounts`, used by the
// works grid + partner list badges), plus the platform-wide `totalOnline`.
//
// io.js is required lazily to avoid a load-time circular dependency
// (io.js → models → … ). All callers used to inline this Promise.all block;
// centralising it guarantees workCounts ships everywhere counts change.
const Partner = require('../models/Partner')

async function broadcastCounts () {
  try {
    const { emitGlobal } = require('../realtime/io')
    const [totalOnline, workCounts, counts] = await Promise.all([
      Partner.countOnline(),
      Partner.onlineCountsByWork(),
      Partner.onlineCountsByCategory(),
    ])
    emitGlobal('categories:counts', { counts, workCounts, totalOnline })
  } catch { /* non-fatal — counts are a UI nicety */ }
}

module.exports = { broadcastCounts }
