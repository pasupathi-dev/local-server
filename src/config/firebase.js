// src/config/firebase.js
// Firebase Admin SDK — server-only. Verifies Firebase id tokens.
//
// Setup:
//   1. Firebase Console → Project Settings → Service Accounts
//   2. Generate new private key → save as firebase-service-account.json
//   3. Set FIREBASE_SERVICE_ACCOUNT_PATH in .env (default: ./firebase-service-account.json)

const admin = require('firebase-admin')
const path  = require('path')
const fs    = require('fs')

const configured = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || './firebase-service-account.json'
const serviceAccountPath = path.isAbsolute(configured)
  ? configured
  : path.resolve(process.cwd(), configured)

if (!admin.apps.length) {
  if (fs.existsSync(serviceAccountPath)) {
    try {
      const serviceAccount = require(serviceAccountPath)
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) })
      console.log('✅ Firebase Admin initialized')
    } catch (err) {
      console.error('❌ Firebase Admin init failed:', err.message)
    }
  } else {
    console.warn('⚠️  firebase-service-account.json not found at:', serviceAccountPath)
    console.warn('    Token verification will fail until the key is added.')
    console.warn('    Firebase Console → Project Settings → Service Accounts → Generate new private key')
  }
}

module.exports = admin
