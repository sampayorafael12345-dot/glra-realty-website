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
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Account, AuditLog, RevokedToken, RETIRED_PERMISSION_KEYS, defaultPermissionsForRole } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

// ── TOKEN HELPERS ──────────────────────────────────────────
// Every token carries its own id (jti) so one sign-in can be ended on its own
// ("Sign out") without ending the account's other devices.
function signToken(account) {
  return jwt.sign(
    { sub: account._id.toString(), email: account.email, role: account.role, name: account.name, tv: account.tokenVersion || 0 },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, jwtid: crypto.randomBytes(12).toString('hex') }
  );
}

// ── SLIDING RENEWAL (audit 15 Oct, ADM-SESS-1) ─────────────
// A 9:00 sign-in used to expire at 17:00 in the middle of the workday and the
// dashboard reloaded, throwing away unsaved work. Any authenticated request
// made while the token has less than RENEW_WINDOW_MS left gets a fresh token
// (same claims, a new full lifetime) in the X-Renewed-Token response header;
// admin.html / agent.html swap it in. Someone who stops using the dashboard
// still drops out when the token runs out.
const RENEW_WINDOW_MS = 2 * 60 * 60 * 1000;
function renewedToken(payload) {
  return jwt.sign(
    { sub: payload.sub, email: payload.email, role: payload.role, name: payload.name, tv: payload.tv || 0 },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN, jwtid: crypto.randomBytes(12).toString('hex') }
  );
}

// ── SIGNED-OUT TOKENS ──────────────────────────────────────
// jti -> expiry (ms). Loaded once from the RevokedToken collection (so a
// restart does not bring a signed-out token back to life) and kept in memory,
// so the check costs nothing per request. Expired entries are dropped.
const _revoked = new Map();
let _revokedLoaded = null;
function loadRevoked() {
  if (_revokedLoaded) return _revokedLoaded;
  _revokedLoaded = RevokedToken.find({ exp: { $gt: new Date() } }).select('jti exp').lean()
    .then(rows => { rows.forEach(r => _revoked.set(r.jti, new Date(r.exp).getTime())); })
    .catch(e => { _revokedLoaded = null; console.warn('Revoked-token list not loaded yet:', e.message); });
  return _revokedLoaded;
}
function isRevoked(jti) {
  if (!jti) return false;
  const exp = _revoked.get(jti);
  if (exp === undefined) return false;
  if (exp < Date.now()) { _revoked.delete(jti); return false; }
  return true;
}
// End one sign-in. payload is the verified JWT payload (req.user).
async function revokeToken(payload) {
  if (!payload || !payload.jti) return false;
  const expMs = (payload.exp ? payload.exp * 1000 : Date.now() + 8 * 3600e3);
  _revoked.set(payload.jti, expMs);
  if (_revoked.size > 20000) {                     // bounded: drop the expired ones
    const now = Date.now();
    for (const [k, v] of _revoked) if (v < now) _revoked.delete(k);
  }
  try {
    await RevokedToken.updateOne({ jti: payload.jti }, { $set: { jti: payload.jti, exp: new Date(expMs) } }, { upsert: true });
  } catch (e) { console.error('Could not store signed-out token:', e.message); }
  return true;
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
  const acc = await Account.findById(userId).select('isActive status role tokenVersion permissions').lean();
  const state = acc
    ? { exists: true, isActive: acc.isActive !== false, status: acc.status, role: acc.role,
        tv: acc.tokenVersion || 0, permissions: acc.permissions || null }
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

  // A token whose account id is not even an id is refused outright (it used
  // to throw inside the lookup and be let through as a "database error").
  if (!payload || !mongoose.isValidObjectId(String(payload.sub || ''))) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (mongoose.connection.readyState === 1) await loadRevoked();
  if (isRevoked(payload.jti)) {
    return res.status(401).json({ error: 'You signed out. Please sign in again.' });
  }
  try {
    const state = await loadAccountState(payload.sub);
    if (!state.exists) return res.status(401).json({ error: 'Account no longer exists' });
    if (!state.isActive) return res.status(403).json({ error: 'Account is inactive' });
    if ((payload.tv || 0) !== state.tv) {
      return res.status(401).json({ error: 'This sign-in has ended (password changed or signed out everywhere). Please sign in again.' });
    }
    if (state.status === 'pending') {
      return res.status(403).json({ error: 'Account is awaiting admin approval' });
    }
    // Trust the stored role over the token claim, so a demotion applies at once.
    payload.role = state.role || payload.role;
  } catch (e) {
    // A database that is down or unreachable must not lock the owner out of
    // her own dashboard, so a signed token is still accepted then. Any other
    // failure is refused rather than waved through.
    const dbDown = mongoose.connection.readyState !== 1 || /Mongo(Network|ServerSelection)Error|ECONN|ETIMEDOUT/.test(String(e && (e.name + ' ' + e.message)));
    if (!dbDown) {
      console.error('Account state check failed (refusing token):', e.message);
      return res.status(401).json({ error: 'Please sign in again.' });
    }
    console.error('Account state check failed, database unreachable (allowing token):', e.message);
  }

  req.user = payload;
  touchLastSeen(payload.sub); // best-effort presence tracking
  // Sliding renewal: a token in its last 2 hours is replaced on this response.
  if (payload.exp && payload.exp * 1000 - Date.now() < RENEW_WINDOW_MS) {
    try {
      res.set('X-Renewed-Token', renewedToken(payload));
      res.set('Access-Control-Expose-Headers', 'X-Renewed-Token');
    } catch (e) { console.error('Token renewal failed:', e.message); }
  }
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
      // Same short-lived cache verifyToken already filled: a staff member's request no longer
      // costs a second database lookup. Saving an account clears it (invalidateAccountState).
      const st = await loadAccountState(req.user.sub);
      const account = st.exists ? { permissions: st.permissions, isActive: st.isActive, role: st.role, status: st.status } : null;
      if (!account || account.isActive === false) {
        return res.status(403).json({ error: 'Account is inactive' });
      }
      if (account.status === 'pending') {
        return res.status(403).json({ error: 'Account is awaiting admin approval' });
      }
      if (account.role === 'admin') return next();
      // Retired keys (the old Notarial tab) are never granted to staff, even
      // when an old account still has `true` stored for them.
      if (RETIRED_PERMISSION_KEYS.includes(key)) {
        return res.status(403).json({ error: `You don't have permission to perform this action (${key}).` });
      }
      // A key the account has never had set (a permission added after the
      // account was made) follows the role's default, which is also what
      // /api/admin/me reports to the dashboard, so the two never disagree.
      const own = account.permissions ? account.permissions[key] : undefined;
      const granted = own === undefined ? defaultPermissionsForRole(account.role || 'employee')[key] === true : own === true;
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

// The same rule as requirePermission, as a yes/no for a route that needs a
// second permission only for part of what it does (e.g. a submission's notes
// need submissions_view, changing its status needs submissions_import).
async function userHasPermission(user, key) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const st = await loadAccountState(user.sub);
  if (!st.exists || st.isActive === false || st.status === 'pending') return false;
  if (st.role === 'admin') return true;
  if (RETIRED_PERMISSION_KEYS.includes(key)) return false;
  const own = st.permissions ? st.permissions[key] : undefined;
  return own === undefined ? defaultPermissionsForRole(st.role || 'employee')[key] === true : own === true;
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
      // The example value from .env.example (or a short one) would be a
      // password anyone reading the public repository knows.
      if (/change-me|replace-with|password/i.test(seedPassword) || seedPassword.length < 12) {
        console.error('❌ ADMIN_PASSWORD is the example value or shorter than 12 characters. Not creating the admin account.');
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
  revokeToken,
  verifyToken,
  invalidateAccountState,
  loadAccountState,
  requireAdmin,
  requirePermission,
  userHasPermission,
  logAudit,
  seedDefaultAdmin
};
