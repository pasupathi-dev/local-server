// src/validators/locationValidator.js
// express-validator rules for location endpoints.

const { body } = require('express-validator')

const saveLocationRules = [
  body('lat')
    .notEmpty().withMessage('lat is required')
    .isFloat({ min: -90,  max: 90  }).withMessage('lat must be between -90 and 90'),

  body('lng')
    .notEmpty().withMessage('lng is required')
    .isFloat({ min: -180, max: 180 }).withMessage('lng must be between -180 and 180'),

  body('city')
    .optional()
    .isString().withMessage('city must be a string')
    .isLength({ max: 255 }).withMessage('city max 255 chars'),

  body('country')
    .optional()
    .isString().withMessage('country must be a string')
    .isLength({ max: 255 }).withMessage('country max 255 chars'),

  body('accuracy')
    .optional()
    .isFloat({ min: 0 }).withMessage('accuracy must be a positive number'),

  body('source')
    .optional()
    .isIn(['gps', 'cached', 'manual']).withMessage('source must be gps, cached, or manual'),
]

module.exports = { saveLocationRules }
