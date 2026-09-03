// payments.js — purchasing proposal credits (Paul, Sep 2 §8–§10).
//
// The rule that governs everything here (Paul, Aug 31): a paid credit is
// NEVER added to a professional's balance until the payment is confirmed on
// the server. A browser landing on a "success" page proves nothing by
// itself — every order is confirmed with the payment provider before
// fulfillOrder() writes the ledger entry, and fulfillOrder() is idempotent
// (an order can only move from 'pending' to 'paid' once), so a double
// refresh or a duplicate webhook can never add credits twice.
//
// Providers are pluggable. Which one runs is decided by environment
// variables on Render — never by code changes:
//
//   PAYMENTS_PROVIDER unset   → purchasing is OFF. "Buy a credit" is not
//                               shown; the dashboard says "Coming soon".
//                               (Today's state: no processor chosen yet.)
//   PAYMENTS_PROVIDER=stripe  → Stripe Checkout (hosted page; card details
//                               never touch Connexli). Needs STRIPE_SECRET_KEY
//                               and STRIPE_WEBHOOK_SECRET in Render env vars —
//                               never in code, GitHub, or the browser.
//   PAYMENTS_PROVIDER=mock    → a pretend checkout page for automated tests
//                               and local demos. REFUSES to run when
//                               NODE_ENV=production, so it can never be
//                               switched on by accident on the live site.
const crypto = require('crypto');
const { pool, CREDIT_BUNDLES, logEvent } = require('./db');

const APP_URL = (process.env.APP_URL || 'https://app.connexli.com').replace(/\/$/, '');
const PROVIDER_NAME = (process.env.PAYMENTS_PROVIDER || '').toLowerCase();

function packageByKey(key) { return CREDIT_BUNDLES.find(b => b.key === key) || null; }
function singlePackage() { return CREDIT_BUNDLES.find(b => b.single) || CREDIT_BUNDLES[0]; }

// Only in-app professional pages may be return targets (never an outside URL).
function safeReturnPath(p) {
  p = String(p || '');
  return /^\/agent(\/[A-Za-z0-9\/_-]*)?$/.test(p) ? p : '/agent';
}

// ---------- providers ----------
// Each provider implements:
//   createCheckout(order, req) → { redirectUrl }   send the professional off to pay
//   confirmReturn(order, query) → { paid, transactionId, amountCents } | { cancelled }
//     server-side verification when the professional comes back

const mockProvider = {
  name: 'mock',
  async createCheckout(order) {
    return { redirectUrl: `/agent/credits/mock-checkout/${order.id}` };
  },
  // The mock "payment" is a random token stored on the order when the tester
  // clicks Pay; the return handler must present the same token. Anything
  // else is treated as unpaid.
  async confirmReturn(order, query) {
    if (query.cancel) return { cancelled: true };
    if (!query.token || !order.provider_session_id || query.token !== order.provider_session_id) return { paid: false };
    return { paid: true, transactionId: 'mock_' + order.provider_session_id, amountCents: order.amount_cents };
  },
};

// Stripe Checkout via Stripe's REST API — no SDK dependency, so nothing new
// to install. Card data never touches Connexli: the professional pays on
// Stripe's hosted page and is sent back with a session id, which we VERIFY
// with Stripe before adding credits. Webhooks (§ /webhooks/stripe in
// routes/credits.js) are the belt to this suspenders.
const stripeProvider = {
  name: 'stripe',
  key: () => process.env.STRIPE_SECRET_KEY || '',
  async api(path, method = 'GET', form = null) {
    const res = await fetch('https://api.stripe.com/v1' + path, {
      method,
      headers: { Authorization: 'Bearer ' + stripeProvider.key(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form ? new URLSearchParams(Object.fromEntries(Object.entries(form).filter(([, v]) => v !== undefined && v !== null))).toString() : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error('Stripe ' + res.status + ': ' + (json.error && json.error.message || 'request failed'));
    return json;
  },
  async createCheckout(order, req) {
    const pkg = packageByKey(order.package_key);
    const session = await stripeProvider.api('/checkout/sessions', 'POST', {
      mode: 'payment',
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][unit_amount]': String(order.amount_cents),
      'line_items[0][price_data][product_data][name]': `Connexli — ${pkg ? pkg.label : order.credits + ' proposal credit(s)'}`,
      'line_items[0][quantity]': '1',
      client_reference_id: String(order.id),
      'metadata[order_id]': String(order.id),
      'metadata[agent_id]': String(order.agent_id),
      customer_email: req && req.session && req.session.user ? req.session.user.email : undefined,
      allow_promotion_codes: 'true', // dashboard-managed discount codes (referral research, Sep 1)
      success_url: `${APP_URL}/agent/credits/return?order=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/agent/credits/return?order=${order.id}&cancel=1`,
    });
    await pool.query(`UPDATE credit_orders SET provider_session_id=$2 WHERE id=$1`, [order.id, session.id]);
    return { redirectUrl: session.url };
  },
  async confirmReturn(order, query) {
    if (query.cancel) return { cancelled: true };
    if (!query.session_id || query.session_id !== order.provider_session_id) return { paid: false };
    const session = await stripeProvider.api('/checkout/sessions/' + encodeURIComponent(query.session_id));
    const paid = session.payment_status === 'paid' && String(session.client_reference_id) === String(order.id);
    return { paid, transactionId: session.payment_intent || session.id, amountCents: session.amount_total };
  },
  // Webhook signature check (Stripe-Signature: t=...,v1=...). HMAC-SHA256 of
  // "<t>.<raw body>" with the endpoint secret; 5-minute replay window.
  verifyWebhook(rawBody, sigHeader) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
    if (!secret || !sigHeader) return null;
    const parts = Object.fromEntries(String(sigHeader).split(',').map(kv => kv.split('=')));
    if (!parts.t || !parts.v1) return null;
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(parts.v1);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Math.abs(Date.now() / 1000 - parseInt(parts.t, 10)) > 300) return null;
    try { return JSON.parse(rawBody); } catch (e) { return null; }
  },
};

let warned = false;
const warnOnce = (msg) => { if (!warned) { warned = true; console.error(msg); } };
function provider() {
  if (PROVIDER_NAME === 'stripe') {
    if (!process.env.STRIPE_SECRET_KEY) { warnOnce('PAYMENTS_PROVIDER=stripe but STRIPE_SECRET_KEY is not set — purchasing is OFF.'); return null; }
    return stripeProvider;
  }
  if (PROVIDER_NAME === 'mock') {
    if (process.env.NODE_ENV === 'production') { warnOnce('PAYMENTS_PROVIDER=mock is refused in production — purchasing is OFF.'); return null; }
    return mockProvider;
  }
  return null;
}
const enabled = () => provider() !== null;
if (enabled()) console.log(`Credit purchasing ON via ${provider().name}`);
else console.log('Credit purchasing OFF (set PAYMENTS_PROVIDER + keys in Render env vars to enable)');

// ---------- orders ----------
async function createOrder(agentId, packageKey, returnPath) {
  const pkg = packageByKey(packageKey);
  if (!pkg) return null;
  const { rows } = await pool.query(
    `INSERT INTO credit_orders (agent_id, package_key, credits, amount_cents, provider, return_path)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [agentId, pkg.key, pkg.credits, Math.round(pkg.price * 100), provider().name, safeReturnPath(returnPath)]);
  return rows[0];
}

async function loadOrder(id, agentId = null) {
  const { rows } = await pool.query(
    `SELECT * FROM credit_orders WHERE id=$1` + (agentId ? ` AND agent_id=$2` : ''),
    agentId ? [id, agentId] : [id]);
  return rows[0] || null;
}

// The ONLY code path that adds purchased credits. Atomic + idempotent: the
// order row is claimed ('pending' → 'paid') in the same transaction as the
// ledger insert, so a second confirmation of the same order does nothing.
// Returns true if credits were added by THIS call.
async function fulfillOrder(orderId, transactionId, amountCents, source) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE credit_orders SET status='paid', completed_at=now(), provider_transaction_id=$2
       WHERE id=$1 AND status='pending' RETURNING *`, [orderId, transactionId || null]);
    if (!rows[0]) { await client.query('ROLLBACK'); return false; }
    const o = rows[0];
    await client.query(
      `INSERT INTO credit_ledger (agent_id, entry_type, funding_source, amount, reason,
         payment_provider, payment_transaction_id, package_key, amount_paid_cents, payment_status)
       VALUES ($1,'purchase','purchased',$2,$3,$4,$5,$6,$7,'paid')`,
      [o.agent_id, o.credits, `Purchased ${o.credits} proposal credit${o.credits === 1 ? '' : 's'} (order #${o.id})`,
       o.provider, transactionId || null, o.package_key, amountCents != null ? amountCents : o.amount_cents]);
    await client.query('COMMIT');
    logEvent('credits_purchased', { userId: o.agent_id, meta: { order_id: o.id, package_key: o.package_key, credits: o.credits, amount_cents: o.amount_cents, source } });
    return true;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function markOrder(orderId, status) {
  await pool.query(`UPDATE credit_orders SET status=$2, completed_at=now() WHERE id=$1 AND status='pending'`, [orderId, status]);
}

module.exports = {
  enabled, provider, packageByKey, singlePackage, safeReturnPath,
  createOrder, loadOrder, fulfillOrder, markOrder, stripeProvider, mockProvider,
};
