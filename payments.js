// payments.js — purchasing proposal credits (Paul, Sep 2 §8–§10; Stripe
// production implementation Sep 25).
//
// The rule that governs everything here (Paul, Aug 31 / Sep 25 §3): a paid
// credit is NEVER added because a browser reached a success page. Credits are
// issued by fulfillOrder(), which is called from (a) Stripe's signed webhook —
// the authoritative path — and (b) the return page, but only after Connexli's
// server has itself asked Stripe whether the session was paid. Both paths are
// idempotent: an order moves 'pending' → 'paid' exactly once, and every
// Stripe event id is recorded before it is acted on, so redeliveries and
// refreshes can never award duplicate credits.
//
// Providers are chosen by environment variables on Render — never by code:
//   PAYMENTS_PROVIDER unset   → purchasing OFF ("Coming soon").
//   PAYMENTS_PROVIDER=stripe  → Stripe Checkout (hosted page; card data never
//                               touches Connexli). Needs STRIPE_SECRET_KEY and
//                               STRIPE_WEBHOOK_SECRET; optional STRIPE_PRICE_*
//                               ids per package and STRIPE_TAX_ENABLED=true.
//                               Test-mode keys (sk_test_…) work identically.
//   PAYMENTS_PROVIDER=mock    → pretend checkout for automated tests and local
//                               demos. REFUSES to run when NODE_ENV=production.
const crypto = require('crypto');
const { pool, CREDIT_BUNDLES, logEvent, insertLedger } = require('./db');

const APP_URL = (process.env.APP_URL || 'https://app.connexli.com').replace(/\/$/, '');
const PROVIDER_NAME = (process.env.PAYMENTS_PROVIDER || '').toLowerCase();
// Testing-only override so automated tests can point Stripe calls at a local
// mock server. Never set on Render.
const STRIPE_API_BASE = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/$/, '');

function packageByKey(key) { return CREDIT_BUNDLES.find(b => b.key === key) || null; }
function pkgLabel(key) { const b = packageByKey(key); return b ? b.label : String(key); }
function singlePackage() { return CREDIT_BUNDLES.find(b => b.single) || CREDIT_BUNDLES[0]; }
// Stripe Price id for a package, from STRIPE_PRICE_<KEY> (e.g.
// STRIPE_PRICE_SINGLE, STRIPE_PRICE_BUNDLE5). Optional: without one, the
// package's configured price is sent as ad-hoc price data instead, so pricing
// still lives in ONE place (CREDIT_BUNDLES) either way.
function stripePriceId(pkg) { return process.env['STRIPE_PRICE_' + String(pkg.key).toUpperCase()] || ''; }

// Only in-app professional pages may be return targets (never an outside URL).
function safeReturnPath(p) {
  p = String(p || '');
  return /^\/agent(\/[A-Za-z0-9\/_-]*)?$/.test(p) ? p : '/agent';
}

// ---------- providers ----------
// Each provider implements:
//   createCheckout(order, req) → { redirectUrl }
//   confirmReturn(order, query) → { paid, details } | { paid:false } | { cancelled:true }
//     (server-side verification when the professional comes back)

const mockProvider = {
  name: 'mock',
  async createCheckout(order) { return { redirectUrl: `/agent/credits/mock-checkout/${order.id}` }; },
  // The mock "payment" is a random token stored on the order when the tester
  // clicks Pay; the return handler must present the same token.
  async confirmReturn(order, query) {
    if (query.cancel) return { cancelled: true };
    if (!query.token || !order.provider_session_id || query.token !== order.provider_session_id) return { paid: false };
    return { paid: true, details: { transactionId: 'mock_pi_' + order.provider_session_id, sessionId: order.provider_session_id, amountCents: order.amount_cents,
      billing: { state: 'UT', postal_code: '84025', country: 'US', city: 'Farmington' }, receiptUrl: null } };
  },
};

// Stripe Checkout via Stripe's REST API — no SDK dependency. Card data never
// touches Connexli: the professional pays on Stripe's hosted page.
const stripeProvider = {
  name: 'stripe',
  key: () => process.env.STRIPE_SECRET_KEY || '',
  async api(path, method = 'GET', form = null) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(STRIPE_API_BASE + '/v1' + path, {
        method, signal: ctl.signal,
        headers: { Authorization: 'Bearer ' + stripeProvider.key(), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form ? new URLSearchParams(Object.fromEntries(Object.entries(form).filter(([, v]) => v !== undefined && v !== null))).toString() : undefined,
      });
      const json = await res.json();
      if (!res.ok) throw new Error('Stripe ' + res.status + ': ' + (json.error && json.error.message || 'request failed'));
      return json;
    } finally { clearTimeout(timer); }
  },
  async createCheckout(order, req) {
    const pkg = packageByKey(order.package_key);
    const priceId = pkg ? stripePriceId(pkg) : '';
    const line = priceId
      ? { 'line_items[0][price]': priceId }
      : {
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(order.amount_cents),
        'line_items[0][price_data][product_data][name]': `Connexli — ${pkg ? pkg.label : order.credits + ' proposal credit(s)'}`,
        'line_items[0][price_data][product_data][description]': `${order.credits} proposal credit${order.credits === 1 ? '' : 's'} for app.connexli.com. Purchased credits never expire.`,
      };
    const session = await stripeProvider.api('/checkout/sessions', 'POST', {
      mode: 'payment',
      ...line,
      'line_items[0][quantity]': '1',
      client_reference_id: String(order.id),
      'metadata[order_id]': String(order.id),
      'metadata[agent_id]': String(order.agent_id),
      'metadata[package_key]': order.package_key,
      'payment_intent_data[metadata][order_id]': String(order.id),
      'payment_intent_data[description]': `Connexli proposal credits — order #${order.id}`,
      customer_email: req && req.session && req.session.user ? req.session.user.email : undefined,
      // Billing address is REQUIRED (Paul, Sep 25 §9): state / ZIP / country
      // are stored with every payment for revenue-by-state and tax work.
      billing_address_collection: 'required',
      // Stripe Tax readiness (§11): OFF unless Paul flips STRIPE_TAX_ENABLED.
      'automatic_tax[enabled]': process.env.STRIPE_TAX_ENABLED === 'true' ? 'true' : 'false',
      allow_promotion_codes: 'true',
      success_url: `${APP_URL}/agent/credits/return?order=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/agent/credits/return?order=${order.id}&cancel=1`,
    });
    await pool.query(`UPDATE credit_orders SET provider_session_id=$2 WHERE id=$1`, [order.id, session.id]);
    return { redirectUrl: session.url };
  },
  // Server-side check when the professional returns from Stripe.
  async confirmReturn(order, query) {
    if (query.cancel) return { cancelled: true };
    if (!query.session_id || query.session_id !== order.provider_session_id) return { paid: false };
    const session = await stripeProvider.api('/checkout/sessions/' + encodeURIComponent(query.session_id));
    if (session.payment_status !== 'paid' || String(session.client_reference_id) !== String(order.id)) return { paid: false };
    return { paid: true, details: detailsFromSession(session) };
  },
  // Receipt link, Stripe fee and net amount from the PaymentIntent's charge
  // and balance transaction. Best effort — a failure here never blocks credits.
  async enrich(paymentIntentId) {
    try {
      const pi = await stripeProvider.api(`/payment_intents/${encodeURIComponent(paymentIntentId)}?expand[]=latest_charge.balance_transaction`);
      const ch = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
      const bt = ch && ch.balance_transaction && typeof ch.balance_transaction === 'object' ? ch.balance_transaction : null;
      return { chargeId: ch ? ch.id : (typeof pi.latest_charge === 'string' ? pi.latest_charge : null), receiptUrl: ch ? ch.receipt_url : null,
        feeCents: bt ? bt.fee : null, netCents: bt ? bt.net : null, amountRefunded: ch ? ch.amount_refunded : null };
    } catch (e) { console.error('stripe enrich failed (credits unaffected):', e.message); return null; }
  },
  // Webhook signature check (Stripe-Signature: t=...,v1=...). HMAC-SHA256 of
  // "<t>.<raw body>" with the endpoint secret; 5-minute replay window.
  verifyWebhook(rawBody, sigHeader) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
    if (!secret || !sigHeader) return null;
    const parts = {};
    for (const kv of String(sigHeader).split(',')) { const i = kv.indexOf('='); if (i > 0) parts[kv.slice(0, i).trim()] = kv.slice(i + 1).trim(); }
    if (!parts.t || !parts.v1) return null;
    const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(parts.v1);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Math.abs(Date.now() / 1000 - parseInt(parts.t, 10)) > 300) return null;
    try { return JSON.parse(rawBody); } catch (e) { return null; }
  },
};

// What we keep from a paid Checkout Session: Stripe references, amounts, and
// the billing geography (§9). Never card data — Stripe never sends it.
function detailsFromSession(s) {
  const addr = (s.customer_details && s.customer_details.address) || {};
  return {
    transactionId: typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || s.id,
    sessionId: s.id, amountCents: s.amount_total, taxCents: s.total_details ? s.total_details.amount_tax : null,
    customerEmail: (s.customer_details && s.customer_details.email) || s.customer_email || null,
    billing: { state: addr.state || null, postal_code: addr.postal_code || null, country: addr.country || null, city: addr.city || null },
  };
}

let warned = false;
const warnOnce = (msg) => { if (!warned) { warned = true; console.error(msg); } };
function provider() {
  if (PROVIDER_NAME === 'stripe') {
    if (!process.env.STRIPE_SECRET_KEY) { warnOnce('PAYMENTS_PROVIDER=stripe but STRIPE_SECRET_KEY is not set — purchasing is OFF.'); return null; }
    if (!process.env.STRIPE_WEBHOOK_SECRET) warnOnce('STRIPE_WEBHOOK_SECRET is not set — the Stripe webhook will reject every event until it is. Purchases still confirm on return, but "closed the browser" payments will not be fulfilled.');
    return stripeProvider;
  }
  if (PROVIDER_NAME === 'mock') {
    if (process.env.NODE_ENV === 'production') { warnOnce('PAYMENTS_PROVIDER=mock is refused in production — purchasing is OFF.'); return null; }
    return mockProvider;
  }
  return null;
}
const enabled = () => provider() !== null;
if (enabled()) console.log(`Credit purchasing ON via ${provider().name}${provider().name === 'stripe' && /^sk_test_/.test(process.env.STRIPE_SECRET_KEY || '') ? ' (TEST MODE keys)' : ''}`);
else console.log('Credit purchasing OFF (set PAYMENTS_PROVIDER + keys in Render env vars to enable)');

// ---------- orders ----------
// Price and credit count are copied from the server-side package table at
// creation — never from anything a browser submitted. The professional's
// service and license state are snapshotted too (§9).
async function createOrder(agentId, packageKey, returnPath) {
  const pkg = packageByKey(packageKey);
  if (!pkg) return null;
  const { rows: ap } = await pool.query(`SELECT service_state, license_state FROM agent_profiles WHERE user_id=$1`, [agentId]);
  const { rows } = await pool.query(
    `INSERT INTO credit_orders (agent_id, package_key, credits, amount_cents, provider, return_path, service_state, license_state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [agentId, pkg.key, pkg.credits, Math.round(pkg.price * 100), provider().name, safeReturnPath(returnPath),
     ap[0] ? ap[0].service_state : null, ap[0] ? ap[0].license_state : null]);
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
async function fulfillOrder(orderId, details, source) {
  const d = details || {};
  const b = d.billing || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE credit_orders SET status='paid', paid_at=now(), completed_at=now(),
         provider_transaction_id=$2, stripe_payment_intent=$3, provider_session_id=COALESCE($4, provider_session_id),
         amount_cents=COALESCE($5, amount_cents), tax_cents=$6, customer_email=$7,
         billing_state=$8, billing_postal_code=$9, billing_country=$10, billing_city=$11
       WHERE id=$1 AND status='pending' RETURNING *`,
      [orderId, d.transactionId || null, d.transactionId || null, d.sessionId || null, d.amountCents == null ? null : d.amountCents, d.taxCents == null ? null : d.taxCents,
       d.customerEmail || null, b.state || null, b.postal_code || null, b.country || null, b.city || null]);
    if (!rows[0]) { await client.query('ROLLBACK'); return false; }
    const o = rows[0];
    await insertLedger(client, o.agent_id, {
      entry_type: 'purchase', funding_source: 'purchased', amount: o.credits,
      reason: `Purchased ${o.credits} proposal credit${o.credits === 1 ? '' : 's'} (order #${o.id})`,
      payment_provider: o.provider, payment_transaction_id: d.transactionId || null, payment_session_id: d.sessionId || null,
      package_key: o.package_key, amount_paid_cents: o.amount_cents, payment_status: 'paid', order_id: o.id,
    });
    await client.query('COMMIT');
    logEvent('credits_purchased', { userId: o.agent_id, meta: { order_id: o.id, package_key: o.package_key, credits: o.credits, amount_cents: o.amount_cents, source, billing_state: b.state || null } });
    console.log(`[payments] order #${o.id} paid via ${source}: +${o.credits} credits for agent ${o.agent_id} (${o.amount_cents}¢, billing ${b.state || '?'})`);
    return true;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Receipt / fee / net from Stripe, stored on the order. Safe to call any
// number of times; never touches credits.
async function enrichOrder(orderId) {
  const p = provider();
  const o = await loadOrder(orderId);
  if (!p || p.name !== 'stripe' || !o || !o.stripe_payment_intent) return;
  const x = await stripeProvider.enrich(o.stripe_payment_intent);
  if (!x) return;
  await pool.query(
    `UPDATE credit_orders SET stripe_charge_id=COALESCE($2, stripe_charge_id), receipt_url=COALESCE($3, receipt_url),
       fee_cents=COALESCE($4, fee_cents), net_cents=COALESCE($5, net_cents) WHERE id=$1`,
    [orderId, x.chargeId, x.receiptUrl, x.feeCents, x.netCents]);
}

async function markOrder(orderId, status) {
  await pool.query(`UPDATE credit_orders SET status=$2, completed_at=now() WHERE id=$1 AND status='pending'`, [orderId, status]);
}

// ---------- refunds (Paul, Sep 25 §8) ----------
// Called with the charge's cumulative amount_refunded. Reverses the matching
// share of the order's credits — but only as many as the professional still
// holds. If the credits were already spent, the shortfall is flagged for
// administrative review instead of driving the balance negative. Idempotent:
// credits already reversed for this order are counted first.
async function applyRefund(orderId, amountRefundedCents, refundId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM credit_orders WHERE id=$1 FOR UPDATE`, [orderId]);
    const o = rows[0];
    if (!o || !['paid', 'refunded', 'partially_refunded'].includes(o.status)) { await client.query('ROLLBACK'); return { ignored: true }; }
    const refunded = Math.min(o.amount_cents, Math.max(0, amountRefundedCents | 0));
    const targetReversal = o.amount_cents ? Math.round(o.credits * refunded / o.amount_cents) : 0;
    const { rows: done } = await client.query(
      `SELECT COALESCE(-SUM(amount),0)::int AS reversed FROM credit_ledger WHERE order_id=$1 AND entry_type='refund'`, [orderId]);
    const need = Math.max(0, targetReversal - done[0].reversed);
    const { rows: bal } = await client.query(`SELECT COALESCE(SUM(amount),0)::int AS bal FROM credit_ledger WHERE agent_id=$1`, [o.agent_id]);
    const reverse = Math.min(need, Math.max(0, bal[0].bal));
    const shortfall = need - reverse;
    if (reverse > 0) {
      await insertLedger(client, o.agent_id, {
        entry_type: 'refund', funding_source: 'purchased', amount: -reverse,
        reason: `Refund of ${(refunded / 100).toFixed(2)} USD on order #${o.id} — ${reverse} credit${reverse === 1 ? '' : 's'} reversed`,
        payment_provider: o.provider, payment_transaction_id: refundId || o.stripe_payment_intent, package_key: o.package_key,
        amount_paid_cents: -refunded, payment_status: 'refunded', order_id: o.id,
      });
    }
    const status = refunded >= o.amount_cents ? 'refunded' : (refunded > 0 ? 'partially_refunded' : o.status);
    const flag = shortfall > 0 ? 'refund_exceeds_balance' : o.review_flag;
    const note = shortfall > 0
      ? `Refund of $${(refunded / 100).toFixed(2)} should reverse ${targetReversal} credit(s) but ${shortfall} had already been used — please review (balance was not driven negative).`
      : o.review_note;
    await client.query(
      `UPDATE credit_orders SET refunded_cents=$2, status=$3, refund_status=$4, review_flag=$5, review_note=$6 WHERE id=$1`,
      [orderId, refunded, status, status === 'refunded' ? 'Refunded in full' : (refunded > 0 ? `Partially refunded ($${(refunded / 100).toFixed(2)})` : null), flag, note]);
    await client.query('COMMIT');
    logEvent('credits_refunded', { userId: o.agent_id, meta: { order_id: o.id, refunded_cents: refunded, credits_reversed: reverse, shortfall } });
    console.log(`[payments] order #${o.id} refund ${refunded}¢ → reversed ${reverse} credit(s)${shortfall ? `, ${shortfall} flagged for review` : ''}`);
    return { reversed: reverse, shortfall, status };
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

// Record a Stripe event id exactly once. Returns false if it was seen before.
async function claimStripeEvent(id, type) {
  const { rowCount } = await pool.query(`INSERT INTO stripe_events (id, type) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING`, [id, type]);
  return rowCount === 1;
}
async function noteStripeEvent(id, orderId, outcome) {
  await pool.query(`UPDATE stripe_events SET order_id=$2, outcome=$3 WHERE id=$1`, [id, orderId, outcome]);
}

// Ledger display labels (Paul, Sep 25 §6 suggested types) for the stored
// entry types — shown to admins and, in plain words, to professionals.
function ledgerType(l) {
  switch (l.entry_type) {
    case 'purchase': return 'PURCHASE';
    case 'proposal_submitted': return l.funding_source === 'purchased' ? 'PROPOSAL_USED' : 'FREE_PROPOSAL_USED';
    case 'refund': return 'REFUND';
    case 'admin_adjustment': return l.amount >= 0 ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT';
    case 'promo': return 'PROMOTIONAL_CREDIT';
    default: return String(l.entry_type).toUpperCase();
  }
}

module.exports = {
  enabled, provider, packageByKey, pkgLabel, singlePackage, stripePriceId, safeReturnPath,
  createOrder, loadOrder, fulfillOrder, enrichOrder, markOrder, applyRefund,
  claimStripeEvent, noteStripeEvent, detailsFromSession, ledgerType,
  stripeProvider, mockProvider, STRIPE_API_BASE,
};
