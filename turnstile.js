// turnstile.js — Cloudflare Turnstile human verification (Paul, Aug 31).
//
// Managed mode: the widget on the signup page is usually invisible to real
// people; the token it produces is validated SERVER-SIDE here — never trust
// the browser alone. The secret key lives ONLY in the TURNSTILE_SECRET_KEY
// environment variable (the SITE key is public by design and is embedded in
// the signup page). If the keys aren't configured yet, verification is
// skipped so the site keeps working — the admin instructions cover setup.
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY || '';
// Overridable for automated testing against a local mock; production always
// uses Cloudflare's real endpoint.
const VERIFY_URL = process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const configured = () => !!(TURNSTILE_SITE_KEY && TURNSTILE_SECRET_KEY);

// Validate one token. Returns { ok: true } or { ok: false, error }.
// Policy on outages: an explicit "not a human" answer from Cloudflare fails
// closed (registration blocked), but a NETWORK failure reaching Cloudflare
// fails open with a logged error — a Cloudflare outage should not stop every
// legitimate signup on Connexli.
async function verify(token, remoteip) {
  if (!configured()) return { ok: true, skipped: true };
  if (!token) return { ok: false, error: 'missing-input-response' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const params = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: String(token) });
    if (remoteip) params.set('remoteip', remoteip);
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: ctl.signal,
    });
    const body = await res.json().catch(() => null);
    if (body && body.success === true) return { ok: true };
    const codes = (body && body['error-codes']) || [];
    return { ok: false, error: codes.join(', ') || `HTTP ${res.status}` };
  } catch (e) {
    console.error('[turnstile] siteverify unreachable — allowing signup:', e.message);
    return { ok: true, degraded: true };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { configured, verify, TURNSTILE_SITE_KEY };
