const router = require('express').Router()
const { verifyToken } = require('../middleware/auth')
const { requireRole } = require('../middleware/requireRole')
const c = require('../controllers/walletController')

// Wallet / earnings / bank are partner-only.
router.get('/',                          verifyToken, requireRole('partner'), c.summary)
router.get('/transactions',              verifyToken, requireRole('partner'), c.transactions)
router.get('/earnings',                  verifyToken, requireRole('partner'), c.earnings)
router.get('/withdrawals',               verifyToken, requireRole('partner'), c.withdrawals)
router.get('/payout-eligibility',        verifyToken, requireRole('partner'), c.payoutEligibility)
router.post('/withdraw',                 verifyToken, requireRole('partner'), c.withdraw)
router.post('/withdraw/:id/cancel',      verifyToken, requireRole('partner'), c.cancelWithdrawal)

router.get('/bank',                      verifyToken, requireRole('partner'), c.getBank)
router.post('/bank',                     verifyToken, requireRole('partner'), c.linkBank)
router.delete('/bank',                   verifyToken, requireRole('partner'), c.removeBank)

module.exports = router
