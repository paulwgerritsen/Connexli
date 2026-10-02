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

// Diagnostic logging (Paul, Sep 25 §1): every RELD call logs the endpoint,
// HTTP status, elapsed time, a SUMMARY of what was sent (counts and states —
// never the API key, never full license lists), and, on an error, RELD's own
// message (truncated) so the cause of a 4xx is visible in the Render logs.
function reldLog(level, msg, details) {
  const line = `[reld] ${msg}` + (details ? ' ' + JSON.stringify(details) : '');
  (level === 'error' ? console.error : console.log)(line);
}
// RELD's error explanation, if any, without echoing anything sensitive back.
function errorMessage(body, text) {
  const m = body && (body.message || body.error || body.detail || body.errors);
  const str = m ? (typeof m === 'string' ? m : JSON.stringify(m)) : (text || '');
  return String(str).replace(/Bearer\s+\S+/gi, 'Bearer ***').slice(0, 500);
}

// Fetch with timeout. Never throws — returns a normalized outcome.
//  unavailable    → outage / auth / 5xx / timeout: statuses must not change
//  invalidRequest → 400/422: RELD rejected WHAT WE SENT (not an outage) —
//                   the batch code retries smaller pieces to isolate it
async function reldFetch(path, options = {}, summary = {}) {
  if (!configured()) return { unavailable: true, error: 'RELD not configured (no RELD_API_KEY)' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  const t0 = Date.now();
  const endpoint = (options.method || 'GET') + ' ' + path.replace(/\?.*$/, '');
  try {
    const res = await fetch(RELD_API_BASE_URL + path, {
      ...options,
      headers: { Authorization: 'Bearer ' + RELD_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
      signal: ctl.signal,
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* non-JSON */ }
    const ms = Date.now() - t0;
    if (res.status === 404) { reldLog('log', 'not found', { endpoint, status: 404, ms, ...summary }); return { notFound: true, body }; }
    if (res.status === 401 || res.status === 403) {
      reldLog('error', 'API key rejected', { endpoint, status: res.status, ms, ...summary, message: errorMessage(body, text) });
      return { unavailable: true, error: `RELD rejected our API key (HTTP ${res.status})`, body };
    }
    if (res.status === 400 || res.status === 422) {
      const message = errorMessage(body, text);
      reldLog('error', 'request rejected by RELD (our payload, not an outage)', { endpoint, status: res.status, ms, ...summary, message });
      return { invalidRequest: true, status: res.status, error: `RELD rejected the request (HTTP ${res.status}${message ? ': ' + message : ''})`, body };
    }
    if (res.status === 429) {
      reldLog('error', 'rate limited', { endpoint, status: 429, ms, ...summary });
      return { unavailable: true, error: 'RELD rate limit reached (HTTP 429) — try again in a few minutes', body };
    }
    if (!res.ok) {
      reldLog('error', 'service error', { endpoint, status: res.status, ms, ...summary, message: errorMessage(body, text) });
      return { unavailable: true, error: `RELD returned HTTP ${res.status}`, body };
    }
    reldLog('log', 'ok', { endpoint, status: res.status, ms, ...summary });
    return { ok: true, body };
  } catch (e) {
    const error = e.name === 'AbortError' ? 'RELD request timed out' : ('RELD unreachable: ' + e.message);
    reldLog('error', 'network failure', { endpoint, ms: Date.now() - t0, ...summary, error });
    return { unavailable: true, error };
  } finally {
    clearTimeout(timer);
  }
}

// RELD wants a two-letter state code and a trimmed license number. Records
// that can't be expressed that way are SKIPPED (reported, never sent) so one
// malformed entry can't sink a whole batch.
// No truncation: "Nevada" must not silently become "NE" (Nebraska). A value
// that is not a two-letter code is reported as skipped by batchProblem.
const cleanState = (s) => String(s || 'UT').trim().toUpperCase();
const cleanNumber = (n) => String(n || '').trim().replace(/\s+/g, ' ');
const LICENSE_OK = /^[A-Za-z0-9][A-Za-z0-9 .\-\/]{1,39}$/;
function batchProblem(item) {
  if (!/^[A-Z]{2}$/.test(cleanState(item.state))) return 'state is not a two-letter code';
  if (!LICENSE_OK.test(cleanNumber(item.license_number))) return 'license number is blank or malformed';
  return null;
}

// Individual verification: GET /api/v1/licensees/verify?state=&license_number=
async function verifyLicense(state, licenseNumber) {
  const q = `?state=${encodeURIComponent(cleanState(state))}&license_number=${encodeURIComponent(cleanNumber(licenseNumber))}`;
  const r = await reldFetch('/api/v1/licensees/verify' + q, {}, { state: cleanState(state) });
  if (r.unavailable) return { unavailable: true, error: r.error };
  if (r.invalidRequest) return { unavailable: true, invalidRequest: true, error: r.error };
  if (r.notFound) return { found: false, raw: r.body };
  // Some APIs answer 200 with a verified:false payload for unknown licenses.
  const verifiedFlag = pick(r.body || {}, 'verified', 'is_verified', 'found', 'exists', 'match');
  if (verifiedFlag === false) return { found: false, raw: r.body };
  return normalizeRecord(r.body);
}

// ---------- batch verification (Paul, Sep 25 §1/§3) ----------
// RELD's documented batch endpoint: POST /api/v1/licensees/batch with
//   { "licenses": [ { "state": "UT", "license_number": "…" }, … ] }   (≤ 100)
// answering { "data": [ { state, license_number, verified, licensee|null } ] }.
// ROOT CAUSE of the HTTP 422 Paul saw: the payload used the key "licensees"
// (the endpoint's noun) instead of "licenses" (the documented field), so
// RELD's validator saw a request with no licenses in it and rejected the
// whole thing. Individual lookups never touched that field, which is why they
// kept working. Fixed here, plus the safeguards below:
//  • chunking to RELD_BATCH_SIZE (default 100, the documented maximum);
//  • results matched by state + license number, not by position;
//  • a chunk RELD still rejects (400/422) is split in halves and retried, so
//    a single bad record isolates itself instead of failing everyone;
//  • malformed records are skipped up front and reported, never sent.
const BATCH_SIZE = Math.max(1, Math.min(100, parseInt(process.env.RELD_BATCH_SIZE, 10) || 100));

function parseBatchBody(body) {
  const list = Array.isArray(body) ? body : (body && (body.data || body.results || body.licenses || body.licensees)) || [];
  const byKey = new Map();
  list.forEach((raw, i) => {
    const st = cleanState(pick(raw, 'state', 'license_state') || (raw && raw.licensee && raw.licensee.state));
    const num = cleanNumber(pick(raw, 'license_number', 'licenseNumber') || (raw && raw.licensee && pick(raw.licensee, 'license_number', 'licenseNumber')));
    const verifiedFlag = pick(raw || {}, 'verified', 'is_verified', 'found', 'exists', 'match');
    const licensee = raw && (raw.licensee || raw.license || raw.result);
    const result = (verifiedFlag === false || (verifiedFlag !== true && !licensee)) ? { found: false, raw } : normalizeRecord(licensee || raw);
    byKey.set(`${st}|${num.toUpperCase()}`, result);
    byKey.set(`#${i}`, result);
  });
  return byKey;
}

// One HTTP call for one chunk. Returns per-item results (same order as items).
let httpCalls = 0; // HTTP requests made by the current batchVerify run
async function batchCall(items) {
  httpCalls++;
  const payload = { licenses: items.map(i => ({ state: cleanState(i.state), license_number: cleanNumber(i.license_number) })) };
  const states = [...new Set(payload.licenses.map(l => l.state))].sort();
  const r = await reldFetch('/api/v1/licensees/batch', { method: 'POST', body: JSON.stringify(payload) }, { count: items.length, states });
  if (r.unavailable) return { unavailable: true, error: r.error };
  if (r.invalidRequest) return { invalidRequest: true, error: r.error };
  const byKey = parseBatchBody(r.body);
  const results = payload.licenses.map((l, i) => byKey.get(`${l.state}|${l.license_number.toUpperCase()}`) || byKey.get(`#${i}`) || { found: false, raw: null });
  return { results };
}

// Recursive isolate-on-422: a rejected chunk is split until the culprit is a
// single record, which is then reported as an API error for that record only.
async function batchChunk(items, depth = 0) {
  const r = await batchCall(items);
  if (r.results) return r.results;
  if (r.unavailable) return items.map(() => ({ unavailable: true, error: r.error }));
  // invalidRequest
  if (items.length === 1) return [{ unavailable: true, invalidRequest: true, error: r.error }];
  const mid = Math.ceil(items.length / 2);
  reldLog('log', 'splitting rejected batch to isolate the bad record', { size: items.length, depth });
  const a = await batchChunk(items.slice(0, mid), depth + 1);
  const b = await batchChunk(items.slice(mid), depth + 1);
  return a.concat(b);
}

// Verify many licenses. Input items: { state, license_number, ...anything }.
// Output: { results: [ per item: {found,...} | {unavailable,error} |
//           {skipped:true, reason} ], calls: n }. Never throws.
async function batchVerify(items) {
  const results = new Array(items.length);
  const sendable = [];
  items.forEach((item, i) => {
    const problem = batchProblem(item);
    if (problem) results[i] = { skipped: true, reason: problem };
    else sendable.push(i);
  });
  httpCalls = 0;
  for (let start = 0; start < sendable.length; start += BATCH_SIZE) {
    const idx = sendable.slice(start, start + BATCH_SIZE);
    const chunkResults = await batchChunk(idx.map(i => items[i]));
    idx.forEach((i, k) => { results[i] = chunkResults[k]; });
  }
  return { results, calls: httpCalls, batchSize: BATCH_SIZE };
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

// Admin-facing note for a Utah "license not found" that goes to manual review.
const UTAH_NOT_FOUND_NOTE = 'RELD could not find the submitted Utah license number. Check that the complete license number, including any applicable suffix, was entered correctly.';

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
    // Utah manual-review rule (Paul, Oct 1): a Utah applicant who is still
    // PENDING and has never been verified is NOT failed/rejected just because
    // RELD says "license not found" — the usual cause is a missing suffix
    // (13529880 instead of 13529880-SA00). They go to Needs Review so an
    // administrator (or the applicant) can correct the number and recheck.
    // Everyone else — other states, accounts already decided, professionals
    // who were verified before — keeps the existing "Failed" result.
    const { rows: ctx } = await pool.query(
      `SELECT license_state, status, reld_first_verified_at, license_override_at FROM agent_profiles WHERE user_id=$1`, [userId]);
    const c = ctx[0] || {};
    const utahReview = (c.license_state || 'UT') === 'UT' && c.status === 'pending' && !c.reld_first_verified_at;
    // "Approve anyway" (Oct 2): an administrator already vouched for this
    // license outside RELD, so a later not-found (recheck or audit) must not
    // flip it to Failed and block their proposals. It stays Needs Review.
    const overridden = !!c.license_override_at;
    status = (utahReview || overridden) ? 'needs_review' : 'failed';
    fields = {
      reld_error: utahReview ? UTAH_NOT_FOUND_NOTE : 'License not found in RELD for this state and number',
      reld_not_found: true, license_recheck_needed: false,
    };
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
      reld_error: null, name_mismatch: !nameRaw, brokerage_mismatch: !brokRaw, reld_not_found: false,
      license_recheck_needed: false, // RELD has now answered for the number on file
    };
  }
  const verified = status === 'verified';
  const cols = { verification_status: status, reld_verified: verified, reld_checked_at: new Date(), ...fields };
  const keys = Object.keys(cols);
  await pool.query(
    `UPDATE agent_profiles SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(', ')}
       ${verified ? ', reld_first_verified_at = COALESCE(reld_first_verified_at, now())' : ''}
     WHERE user_id=$1`,
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
            reld_brokerage, reld_city, reld_record_id, reld_last_verified, reld_not_found
     FROM agent_profiles
     WHERE license_state=$1 AND LOWER(license_number)=LOWER($2)
       AND reld_checked_at > now() - interval '30 days'
       AND verification_status IN ('verified','failed','expired','needs_review')
     ORDER BY reld_checked_at DESC LIMIT 1`, [state, licenseNumber]);
  const r = rows[0];
  if (!r) return null;
  // A definitive "not found" is cached whether it was stored as Failed or as
  // a Utah Needs Review (Oct 1), so a repeated wrong number costs no lookup.
  if (r.verification_status === 'failed' || r.reld_not_found) return { found: false, cached: true };
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
async function autoDecide(userId, status, result, p, approveOnly = false) {
  if (p.account_status !== 'pending') return;
  const mailer = require('./mailer');
  // Utah "license not found" → manual review (Paul, Oct 1): the account stays
  // Pending. Tell the applicant once (most can fix a missing suffix
  // themselves) and tell the admin once that a license needs review.
  if (status === 'needs_review' && !result.unavailable && result.found === false) {
    const { rows: seen } = await pool.query(
      `SELECT 1 FROM events WHERE event_type='agent_license_needs_review' AND user_id=$1 LIMIT 1`, [userId]);
    logEvent('agent_license_needs_review', { userId, meta: { license: (p.license_state || 'UT') + '/' + p.license_number, cached: !!result.cached } });
    if (!seen.length) {
      mailer.agentLicenseNotFound(p.email, p.name, p.license_number); // fire and forget
      mailer.adminLicenseReview(p); // fire and forget
    }
    console.log(`[reld] user=${userId} Utah license not found → needs review (account stays pending)`);
    return;
  }
  if (status === 'verified') {
    const { rowCount } = await pool.query(
      `UPDATE agent_profiles SET status='approved', reviewed_at=now(), reviewed_by='RELD auto-verification'
       WHERE user_id=$1 AND status='pending'`, [userId]);
    if (rowCount) {
      logEvent('agent_auto_approved', { userId, meta: { license: (p.license_state || 'UT') + '/' + p.license_number } });
      mailer.agentApproved(p.email, p.name); // fire and forget
      console.log(`[reld] auto-approved user=${userId} (active license, identity matched)`);
    }
  } else if (!approveOnly && status === 'failed' && !result.unavailable && result.found === false) {
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
// opts.autoDecide — apply the automatic approve/reject rules above (the
//                   post-email-verification signup path and the professional's
//                   own license correction). The value 'approve-only' is used
//                   by the admin Recheck (Oct 1): a PENDING account that now
//                   verifies is approved through the normal process, but an
//                   admin recheck never rejects anyone. NEVER the batch
//                   audit, NEVER anything at deploy/boot.
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
  if (opts.autoDecide) await autoDecide(userId, status, result, p, opts.autoDecide === 'approve-only');
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
  namesMatch, brokeragesMatch, batchProblem, cleanState, cleanNumber,
  VERIFICATION_LABELS, VERIFICATION_BADGE, BLOCKING_STATUSES,
  RELD_API_BASE_URL, BATCH_SIZE, UTAH_NOT_FOUND_NOTE,
};
