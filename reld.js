// reld.js — RELD (Real Estate License Database) integration. Paul, Aug 29.
//
// HARD RULES:
//  - The API key lives ONLY in the RELD_API_KEY environment variable.
//  - RELD is called ONLY on deliberate events (signup, license change, admin
//    Recheck, admin batch audit, admin connection test) — never on page loads.
//  - An API outage must never label a professional's license invalid: on
//    'unavailable' we record the error but never downgrade an existing status
//    to failed.
//
// Field names are parsed tolerantly (several plausible spellings accepted)
// because the integration was built against RELD's documented shape; the
// admin "Test RELD connection" page shows the raw response so any mapping
// difference is visible on the very first live lookup.
const { pool, logEvent } = require('./db');

const RELD_API_KEY = process.env.RELD_API_KEY || '';
const RELD_API_BASE_URL = (process.env.RELD_API_BASE_URL || 'https://app.realestatelicensedatabase.com').replace(/\/$/, '');

const configured = () => !!RELD_API_KEY;

// Tolerant field extraction: first present, non-empty candidate wins.
function pick(obj, ...names) {
  if (!obj || typeof obj !== 'object') return null;
  for (const n of names) {
    if (obj[n] !== undefined && obj[n] !== null && obj[n] !== '') return obj[n];
  }
  return null;
}

// Normalize one licensee record from any plausible RELD response shape.
function normalizeRecord(raw) {
  const rec = pick(raw, 'licensee', 'license', 'result', 'data') || raw;
  return {
    found: true,
    licenseNumber: pick(rec, 'license_number', 'licenseNumber', 'number'),
    name: pick(rec, 'name', 'full_name', 'fullName', 'licensee_name', 'licenseeName'),
    licenseType: pick(rec, 'license_type', 'licenseType', 'type'),
    licenseStatus: String(pick(rec, 'license_status', 'licenseStatus', 'status') || ''),
    state: pick(rec, 'state', 'license_state', 'licenseState'),
    expiration: pick(rec, 'expiration_date', 'expirationDate', 'expires_at', 'expiration', 'expires'),
    brokerage: pick(rec, 'brokerage', 'brokerage_name', 'brokerageName', 'company', 'office'),
    city: pick(rec, 'city', 'licensee_city'),
    recordId: pick(rec, 'id', 'record_id', 'recordId', 'uuid'),
    lastVerified: pick(rec, 'last_verified', 'lastVerified', 'last_verification_date', 'verified_at'),
    raw,
  };
}

const ACTIVE_WORDS = ['active', 'current', 'valid', 'licensed'];
function isActive(status) {
  return ACTIVE_WORDS.some(w => String(status || '').toLowerCase().includes(w));
}

// Fetch with timeout. Never throws — returns a normalized outcome.
async function reldFetch(path, options = {}) {
  if (!configured()) return { unavailable: true, error: 'RELD not configured (no RELD_API_KEY)' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(RELD_API_BASE_URL + path, {
      ...options,
      headers: { Authorization: 'Bearer ' + RELD_API_KEY, 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: ctl.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* non-JSON */ }
    if (res.status === 404) return { notFound: true, body };
    if (res.status === 401 || res.status === 403) return { unavailable: true, error: `RELD rejected our API key (HTTP ${res.status})`, body };
    if (!res.ok) return { unavailable: true, error: `RELD returned HTTP ${res.status}`, body };
    return { ok: true, body };
  } catch (e) {
    return { unavailable: true, error: e.name === 'AbortError' ? 'RELD request timed out' : ('RELD unreachable: ' + e.message) };
  } finally {
    clearTimeout(timer);
  }
}

// Individual verification: GET /api/v1/licensees/verify?state=&license_number=
async function verifyLicense(state, licenseNumber) {
  const q = `?state=${encodeURIComponent(state)}&license_number=${encodeURIComponent(licenseNumber)}`;
  const r = await reldFetch('/api/v1/licensees/verify' + q);
  if (r.unavailable) return { unavailable: true, error: r.error };
  if (r.notFound) return { found: false, raw: r.body };
  // Some APIs answer 200 with a verified:false payload for unknown licenses.
  const verifiedFlag = pick(r.body || {}, 'verified', 'is_verified', 'found', 'exists', 'match');
  if (verifiedFlag === false) return { found: false, raw: r.body };
  return normalizeRecord(r.body);
}

// Batch: POST /api/v1/licensees/batch — up to 100, results in input order.
async function batchVerify(items) {
  const r = await reldFetch('/api/v1/licensees/batch', {
    method: 'POST',
    body: JSON.stringify({ licensees: items.map(i => ({ state: i.state, license_number: i.license_number })) }),
  });
  if (r.unavailable) return { unavailable: true, error: r.error };
  const list = Array.isArray(r.body) ? r.body
    : (r.body && (r.body.results || r.body.licensees || r.body.data)) || [];
  return {
    results: items.map((item, i) => {
      const raw = list[i];
      if (!raw) return { found: false };
      const verifiedFlag = pick(raw, 'verified', 'is_verified', 'found', 'exists', 'match');
      if (verifiedFlag === false) return { found: false, raw };
      return normalizeRecord(raw);
    }),
  };
}

// Fuzzy name comparison: minor differences (middle initial, shortened first
// name, punctuation, suffix, capitalization) must NOT fail verification.
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v']);
function nameTokens(name) {
  return String(name || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
    .filter(t => t && !SUFFIXES.has(t));
}
function namesMatch(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return true; // nothing to compare — don't flag
  if (ta[ta.length - 1] !== tb[tb.length - 1]) return false; // last names differ
  const fa = ta[0], fb = tb[0];
  return fa === fb || fa[0] === fb[0] || fa.startsWith(fb) || fb.startsWith(fa);
}
// Brokerage comparison (Paul, Sep 1): tolerate harmless FORMATTING
// differences — capitalization, punctuation, "&" vs "and", "Co." vs
// "Company", suffixes, whitespace — so "JODY DEAMER & COMPANY" matches
// "Jody Deamer and Co.". Substantially different brokerages do NOT match
// (they go to Needs Review, never auto-rejection).
const BROKERAGE_NOISE = new Set(['and', 'the', 'of', 'co', 'company', 'companies', 'inc', 'incorporated',
  'llc', 'lc', 'llp', 'lp', 'ltd', 'corp', 'corporation', 'pllc', 'pc', 'group', 'team']);
function brokerageTokens(s) {
  return String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(t => t && !BROKERAGE_NOISE.has(t));
}
function brokeragesMatch(a, b) {
  const na = brokerageTokens(a).join(''), nb = brokerageTokens(b).join('');
  if (!na || !nb) return true; // nothing to compare — don't flag
  return na === nb || na.includes(nb) || nb.includes(na);
}
// Exact-identity comparison used for admin-confirmed values: once an admin
// confirms "PAUL GERRITSEN" belongs to this account, any future RELD response
// with that same (normalized) name is accepted without re-flagging.
const normEq = (a, b) => a && b &&
  String(a).toLowerCase().replace(/[^a-z0-9]/g, '') === String(b).toLowerCase().replace(/[^a-z0-9]/g, '');

// Apply one verification result to a professional's stored record and return
// the resulting verification_status. NEVER touches account status here —
// account decisions (auto-approve/auto-reject) live in autoDecide below.
// `confirmed` carries admin-confirmed registry name/brokerage: a value the
// admin already confirmed belongs to this professional never re-flags.
async function applyResult(userId, connexliName, connexliBrokerage, result, prevStatus, confirmed = {}) {
  let status, fields;
  if (result.unavailable) {
    // Outage rule: never downgrade a real status because RELD was down.
    status = (prevStatus === 'needs_verification' || !prevStatus) ? 'unable_to_verify' : prevStatus;
    fields = { reld_error: result.error };
  } else if (!result.found) {
    status = 'failed';
    fields = { reld_error: 'License not found in RELD for this state and number' };
  } else {
    const active = isActive(result.licenseStatus);
    const nameRaw = namesMatch(connexliName, result.name);
    const brokRaw = brokeragesMatch(connexliBrokerage, result.brokerage);
    const nameOk = nameRaw || normEq(result.name, confirmed.name);
    const brokOk = brokRaw || normEq(result.brokerage, confirmed.brokerage);
    if (!active) status = 'expired';
    else if (!nameOk) status = 'needs_review';
    else if (!brokOk) status = 'needs_review'; // substantial brokerage difference → review, never rejection (Paul, Sep 1)
    else status = 'verified';
    fields = {
      reld_name: result.name, reld_license_type: result.licenseType,
      reld_license_status: result.licenseStatus, reld_expiration: result.expiration,
      reld_brokerage: result.brokerage, reld_city: result.city,
      reld_record_id: result.recordId ? String(result.recordId) : null,
      reld_last_verified: result.lastVerified ? String(result.lastVerified) : null,
      reld_error: null, name_mismatch: !nameRaw, brokerage_mismatch: !brokRaw,
    };
  }
  const verified = status === 'verified';
  const cols = { verification_status: status, reld_verified: verified, reld_checked_at: new Date(), ...fields };
  const keys = Object.keys(cols);
  await pool.query(
    `UPDATE agent_profiles SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')} WHERE user_id=$1`,
    [userId, ...keys.map(k => cols[k])]);
  return status;
}

// Duplicate-lookup protection (Paul, Sep 1 §8): before spending a RELD API
// request, reuse a recent DEFINITIVE stored result for the same state +
// license number (any account, last 30 days). Registry data is cached;
// per-professional decisions (name/brokerage comparison) are always re-run
// against THIS applicant. Temporary errors are never cached. A repeat
// submission of an already-not-found fake license costs zero lookups.
async function cachedResult(state, licenseNumber) {
  const { rows } = await pool.query(
    `SELECT verification_status, reld_name, reld_license_type, reld_license_status, reld_expiration,
            reld_brokerage, reld_city, reld_record_id, reld_last_verified
     FROM agent_profiles
     WHERE license_state=$1 AND LOWER(license_number)=LOWER($2)
       AND reld_checked_at > now() - interval '30 days'
       AND verification_status IN ('verified','failed','expired','needs_review')
     ORDER BY reld_checked_at DESC LIMIT 1`, [state, licenseNumber]);
  const r = rows[0];
  if (!r) return null;
  if (r.verification_status === 'failed') return { found: false, cached: true };
  if (!r.reld_name && !r.reld_license_status) return null; // no usable registry data stored
  return {
    found: true, cached: true,
    name: r.reld_name, licenseType: r.reld_license_type, licenseStatus: r.reld_license_status,
    expiration: r.reld_expiration, brokerage: r.reld_brokerage, city: r.reld_city,
    recordId: r.reld_record_id, lastVerified: r.reld_last_verified,
  };
}

// Automatic account decision after a signup/correction verification
// (Paul, Sep 1). ONLY acts on accounts still 'pending':
//  - verified (active license + strong name + reasonable brokerage, no other
//    warnings) → auto-APPROVE, recorded as 'RELD auto-verification'.
//  - failed (RELD answered definitively: no such license) → auto-REJECT with
//    an audit reason. The record is preserved, never deleted.
//  - expired / needs_review / unable_to_verify → no account change; an
//    administrator (or a retry, for outages) decides. An API error can
//    therefore never reject anyone.
async function autoDecide(userId, status, result, p) {
  if (p.account_status !== 'pending') return;
  const mailer = require('./mailer');
  if (status === 'verified') {
    const { rowCount } = await pool.query(
      `UPDATE agent_profiles SET status='approved', reviewed_at=now(), reviewed_by='RELD auto-verification'
       WHERE user_id=$1 AND status='pending'`, [userId]);
    if (rowCount) {
      logEvent('agent_auto_approved', { userId, meta: { license: (p.license_state || 'UT') + '/' + p.license_number } });
      mailer.agentApproved(p.email, p.name); // fire and forget
      console.log(`[reld] auto-approved user=${userId} (active license, identity matched)`);
    }
  } else if (status === 'failed' && !result.unavailable && result.found === false) {
    const { rowCount } = await pool.query(
      `UPDATE agent_profiles SET status='rejected', reviewed_at=now(), reviewed_by='RELD auto-verification',
         rejection_reason='Automatically rejected — RELD returned license not found for the submitted state and license number.'
       WHERE user_id=$1 AND status='pending'`, [userId]);
    if (rowCount) {
      logEvent('agent_auto_rejected', { userId, meta: { license: (p.license_state || 'UT') + '/' + p.license_number, cached: !!result.cached } });
      mailer.agentRejected(p.email, p.name); // fire and forget
      console.log(`[reld] auto-rejected user=${userId} (license not found)`);
    }
  }
}

// Verify one professional by user id.
// opts.useCache   — reuse a recent definitive result for this state+number
//                   instead of spending an API lookup (signup/correction path).
// opts.autoDecide — apply the automatic approve/reject rules above (ONLY the
//                   post-email-verification signup path and the professional's
//                   own license correction; NEVER admin recheck, NEVER the
//                   batch audit, NEVER anything at deploy/boot).
async function verifyProfessional(userId, opts = {}) {
  const { rows } = await pool.query(
    `SELECT ap.license_state, ap.license_number, ap.brokerage, ap.verification_status,
            ap.confirmed_reld_name, ap.confirmed_reld_brokerage, ap.status AS account_status,
            u.name, u.email
     FROM agent_profiles ap JOIN users u ON u.id = ap.user_id WHERE ap.user_id=$1`, [userId]);
  if (!rows[0]) return null;
  const p = rows[0];
  let result = opts.useCache ? await cachedResult(p.license_state || 'UT', p.license_number) : null;
  if (!result) result = await verifyLicense(p.license_state || 'UT', p.license_number);
  const status = await applyResult(userId, p.name, p.brokerage, result, p.verification_status,
    { name: p.confirmed_reld_name, brokerage: p.confirmed_reld_brokerage });
  console.log(`[reld] verify user=${userId} license=${p.license_state}/${p.license_number} → ${status}${result.cached ? ' (cached — no API call)' : ''}`);
  if (opts.autoDecide) await autoDecide(userId, status, result, p);
  return status;
}

// Human labels + badge colors shared by the views.
const VERIFICATION_LABELS = {
  verified: '✓ Verified', failed: '✗ Failed', expired: 'Expired/inactive',
  needs_review: 'Needs review', unable_to_verify: 'Unable to verify', needs_verification: 'Not yet checked',
};
const VERIFICATION_BADGE = {
  verified: 'connected', failed: 'closed', expired: 'closed',
  needs_review: 'pending', unable_to_verify: 'pending', needs_verification: 'pending',
};
// Statuses that block proposal submission (credits never override this).
const BLOCKING_STATUSES = ['failed', 'expired'];

module.exports = {
  configured, verifyLicense, batchVerify, verifyProfessional, applyResult,
  namesMatch, brokeragesMatch,
  VERIFICATION_LABELS, VERIFICATION_BADGE, BLOCKING_STATUSES,
  RELD_API_BASE_URL,
};
