const { z } = require('zod');
const { badRequest } = require('../utils/errors');

/**
 * Validates and replaces req.body / req.query / req.params with the parsed
 * (typed, trimmed, unknown keys removed) values.
 *   router.post('/x', validate({ body: schema }), handler)
 */
function validate(schemas) {
  return (req, res, next) => {
    for (const part of ['body', 'query', 'params']) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        const first = result.error.issues[0];
        const field = first.path.join('.');
        const message = first.message.startsWith('Required')
          ? `${field || 'A field'} is required`
          : first.message;
        return next(
          badRequest(message, 'VALIDATION_ERROR', result.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          }))),
        );
      }
      if (part === 'query') {
        // req.query is a getter in some Express versions; copy into it.
        Object.keys(req.query).forEach((k) => delete req.query[k]);
        Object.assign(req.query, result.data);
      } else {
        req[part] = result.data;
      }
    }
    return next();
  };
}

// Reusable field schemas
const fields = {
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  phone: z
    .string()
    .trim()
    .regex(/^0[789][01]\d{8}$/, 'Enter a valid 11-digit Nigerian phone number'),
  anyPhone: z.string().trim().regex(/^\+?\d{6,15}$/, 'Enter a valid phone number'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(100)
    .regex(/[A-Z]/, 'Password must contain an uppercase letter')
    .regex(/[a-z]/, 'Password must contain a lowercase letter')
    .regex(/\d/, 'Password must contain a number'),
  pin: z.string().regex(/^\d{6}$/, 'PIN must be exactly 6 digits'),
  code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code'),
  /** ₦ amount with up to 2 decimals */
  amount: z.coerce
    .number({ invalid_type_error: 'Enter a valid amount' })
    .positive('Enter a valid amount')
    .max(100_000_000, 'Amount is too large'),
  objectId: z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id'),
  name: z.string().trim().min(2, 'Enter a full name').max(100),
};

module.exports = { validate, z, fields };
