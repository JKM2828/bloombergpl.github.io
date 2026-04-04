// ============================================================
// Admin auth middleware — protects costly/destructive endpoints
// ============================================================
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

function requireAdmin(req, res, next) {
  // If no key configured, skip auth (dev mode)
  if (!ADMIN_API_KEY) return next();

  const header = req.headers.authorization || '';
  const apiKey = req.headers['x-api-key'];

  let token = apiKey;
  if (!token && header.startsWith('Bearer ')) {
    token = header.slice(7);
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required. Provide Authorization: Bearer <key> or X-API-Key header.' });
  }

  if (token !== ADMIN_API_KEY) {
    return res.status(403).json({ error: 'Invalid API key.' });
  }

  next();
}

module.exports = requireAdmin;
