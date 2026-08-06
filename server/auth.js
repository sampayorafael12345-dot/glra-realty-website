// =============================================================================
// AUTH + AUDIT HELPERS
// =============================================================================
// JWT signing/verifying, the verifyToken / requireAdmin / requirePermission
// middlewares, the logAudit helper, and the one-time default-admin seeder.
//
// Reads JWT_SECRET / JWT_EXPIRES_IN from process.env — server.js validates
// these on startup before any route is registered, so they're always present
// by the time anything here runs.
// =============================================================================
const jwt = require('jsonwebtoken');
const { Account, AuditLog, defaultPermissionsForRole } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

// ── TOKEN HELPERS ──────────────────────────────────────────
function signToken(account) {
  return jwt.sign(
    { sub: account._id.toString(), email: account.email, role: account.role, name: account.name },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

// In-memory throttle for lastSeen writes: { userId: lastWriteMs }. Avoids a DB
// write on every single authenticated request — one write per user per ~60s is
// plenty to power the dashboard's "who's online" view. Resets on server restart.
const _lastSeenWrites = new Map();
const LAST_SEEN_THROTTLE_MS = 60 * 1000;
function touchLastSeen(userId) {
  if (!userId) return;
  const now = Date.now();
  const prev = _lastSeenWrites.get(userId) || 0;
  if (now - prev < LAST_SEEN_THROTTLE_MS) return;
  _lastSeenWrites.set(userId, now);
  // Fire-and-forget: never block the request or surface an error to the client.
  Account.updateOne({ _id: userId }, { $set: { lastSeen: new Date() } }).catch(() => {});
}

// Live account-state cache for verifyToken: { userId: {at, state} }.
// A JWT is valid for JWT_EXPIRES_IN (8h by default) and carries role/identity
// as *claims* — so before this check, deactivating or demoting someone left
// their existing token working at full privilege until it expired. Re-reading
// the account on every request would add a DB round-trip to every API call,
// so the state is cached briefly: revocation takes effect within ACCOUNT_TTL_MS
// instead of within 8 hours.
const _accountState = new Map();
const ACCOUNT_TTL_MS = 30 * 1000;

async function loadAccountState(userId) {
  const hit = _accountState.get(userId);
  if (hit && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.state;
  const acc = await Account.findById(userId).select('isActive status role').lean();
  const state = acc
    ? { exists: true, isActive: acc.isActive !== false, status: acc.status, role: acc.role }
    : { exists: false };
  _accountState.set(userId, { at: Date.now(), state });
  return state;
}

// Call after changing an account so the next request sees it immediately
// rather than waiting out the cache window.
function invalidateAccountState(userId) {
  if (userId) _accountState.delete(String(userId));
}

async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    const state = await loadAccountState(payload.sub);
    if (!state.exists) return res.status(401).json({ error: 'Account no longer exists' });
    if (!state.isActive) return res.status(403).json({ error: 'Account is inactive' });
    if (state.status === 'pending') {
      return res.status(403).json({ error: 'Account is awaiting admin approval' });
    }
    // Trust the stored role over the token claim, so a demotion applies at once.
    payload.role = state.role || payload.role;
  } catch (e) {
    // A transient DB error must not lock the owner out of her own dashboard.
    // The signature is still cryptographically valid, so fall through to the
    // pre-existing behaviour and log it rather than failing the request.
    console.error('Account state check failed (allowing token):', e.message);
  }

  req.user = payload;
  touchLastSeen(payload.sub); // best-effort presence tracking
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Granular permission middleware. Usage: requirePermission('properties_delete')
// Admins bypass the check (they always have everything).
// For employees, looks up the live account record so permission changes take
// effect immediately without forcing them to log out.
function requirePermission(key) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (req.user.role === 'admin') return next();
    try {
      const account = await Account.findById(req.user.sub).select('permissions isActive role status').lean();
      if (!account || account.isActive === false) {
        return res.status(403).json({ error: 'Account is inactive' });
      }
      if (account.status === 'pending') {
        return res.status(403).json({ error: 'Account is awaiting admin approval' });
      }
      if (account.role === 'admin') return next();
      const granted = account.permissions && account.permissions[key] === true;
      if (!granted) {
        return res.status(403).json({ error: `You don't have permission to perform this action (${key}).` });
      }
      next();
    } catch (e) {
      console.error('Permission check error:', e);
      res.status(500).json({ error: 'Permission check failed' });
    }
  };
}

// ── AUDIT LOG WRITER ───────────────────────────────────────
// Uses the verified JWT payload (req.user), not request headers — so callers
// can't spoof who they are by setting a custom header.
async function logAudit(req, action, target, targetId, targetTitle, changes) {
  try {
    const u = req.user || {};
    await AuditLog.create({
      actor: u.email || 'anonymous',
      actorName: u.name || '',
      actorRole: u.role || 'unknown',
      action,
      target,
      targetId: targetId || '',
      targetTitle: targetTitle || '',
      changes: changes || null,
      ip: req.ip || req.connection?.remoteAddress || '',
      userAgent: req.headers?.['user-agent'] || '',
      timestamp: new Date()
    });
  } catch (e) { console.error('Audit log error:', e.message); }
}

// ── ONE-TIME ADMIN SEEDER ──────────────────────────────────
// Runs once on first boot if no admin exists in the DB. Pulls credentials from
// ADMIN_EMAIL / ADMIN_PASSWORD env vars. The first thing the human should do
// after this fires is sign in and change the password.
async function seedDefaultAdmin() {
  try {
    const existing = await Account.findOne({ role: 'admin' });
    if (!existing) {
      const seedEmail = process.env.ADMIN_EMAIL;
      const seedPassword = process.env.ADMIN_PASSWORD;
      if (!seedEmail || !seedPassword) {
        console.warn('⚠️ No admin exists and ADMIN_EMAIL/ADMIN_PASSWORD not set. Skipping seed.');
        return;
      }
      await Account.create({
        email: seedEmail,
        password: seedPassword, // hashed by pre-save hook
        name: 'GLRA Admin',
        role: 'admin',
        permissions: defaultPermissionsForRole('admin')
      });
      console.log(`✅ Default admin account created: ${seedEmail}`);
      console.log('⚠️  Change this password immediately after first login.');
    }
  } catch (e) { console.error('Seed error:', e.message); }
}

module.exports = {
  signToken,
  verifyToken,
  invalidateAccountState,
  requireAdmin,
  requirePermission,
  logAudit,
  seedDefaultAdmin
};
