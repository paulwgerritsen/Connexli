// routes/credits.js — buying proposal credits (Paul, Sep 2 §8–§10), from the
// dashboard or from inside an opportunity, with the proposal draft preserved
// across the trip to the payment page and back.
//
// Flow:  [opportunity form] —Buy a credit→ POST /agent/credits/checkout
//        → draft saved → order created → provider's checkout page
//        → GET /agent/credits/return → payment VERIFIED with the provider
//        → credits added (or not) → back to the same opportunity, draft
//          restored, purchased-credit option selected.
const express = require('express');
const { pool, logEvent, creditSummary, CREDIT_BUNDLES } = require('../db');
const { requireRole } = require('../middleware');
const payments = require('../payments');

const router = require('../middleware').safeRouter(express.Router());
const agent = requireRole('agent');

// Fields that belong to the purchase itself, not to the proposal draft.
const NOT_DRAFT = new Set(['_csrf', 'package_key', 'return_to', 'opp_type', 'opp_id', 'credit_choice']);

async function saveDraft(agentId, type, id, body) {
  const data = {};
  for (const [k, v] of Object.entries(body || {})) if (!NOT_DRAFT.has(k)) data[k] = v;
  await pool.query(
    `INSERT INTO proposal_drafts (agent_id, opportunity_type, opportunity_id, data, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (agent_id, opportunity_type, opportunity_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
    [agentId, type, id, JSON.stringify(data)]);
}

async function loadDraft(agentId, type, id) {
  const { rows } = await pool.query(
    `SELECT data FROM proposal_drafts WHERE agent_id=$1 AND opportunity_type=$2 AND opportunity_id=$3`, [agentId, type, id]);
  return rows[0] ? rows[0].data : null;
}

async function clearDraft(agentId, type, id) {
  await pool.query(`DELETE FROM proposal_drafts WHERE agent_id=$1 AND opportunity_type=$2 AND opportunity_id=$3`, [agentId, type, id]);
}

// Start a purchase. Called by "Buy a credit" inside an opportunity (with the
// whole proposal form posted along, so the draft is saved first) and by the
// dashboard bundle buttons (no draft).
router.post('/agent/credits/checkout', agent, async (req, res) => {
  const { rows: prof } = await pool.query(`SELECT status FROM agent_profiles WHERE user_id=$1`, [req.session.user.id]);
  if (!prof[0] || prof[0].status !== 'approved') return res.redirect('/agent');

  const oppType = ['seller', 'buyer'].includes(req.body.opp_type) ? req.body.opp_type : null;
  const oppId = parseInt(req.body.opp_id, 10);
  let returnPath = payments.safeReturnPath(req.body.return_to);
  if (oppType && Number.isInteger(oppId) && oppId > 0) {
    // §10 — "this is critical": nothing typed into the proposal may be lost.
    await saveDraft(req.session.user.id, oppType, oppId, req.body);
    returnPath = oppType === 'buyer' ? `/agent/buyers/${oppId}` : `/agent/opportunities/${oppId}`;
  }

  if (!payments.enabled()) {
    // No processor configured yet: the draft is saved, nothing is charged,
    // and the professional lands back where they were with a clear note.
    return res.redirect(returnPath + '?purchase=unavailable');
  }
  const pkg = payments.packageByKey(req.body.package_key) || payments.singlePackage();
  const order = await payments.createOrder(req.session.user.id, pkg.key, returnPath);
  logEvent('credit_checkout_started', { userId: req.session.user.id, meta: { order_id: order.id, package_key: pkg.key, from: oppType ? `${oppType}:${oppId}` : 'dashboard' } });
  try {
    const { redirectUrl } = await payments.provider().createCheckout(order, req);
    res.redirect(redirectUrl);
  } catch (e) {
    console.error('createCheckout failed:', e.message);
    await payments.markOrder(order.id, 'failed');
    res.redirect(returnPath + '?purchase=failed');
  }
});

// Back from the payment page — success or cancel. The payment is verified
// with the provider here; the redirect alone never adds credits.
router.get('/agent/credits/return', agent, async (req, res) => {
  const order = await payments.loadOrder(parseInt(req.query.order, 10) || 0, req.session.user.id);
  if (!order) return res.redirect('/agent?purchase=failed');
  const back = payments.safeReturnPath(order.return_path);
  if (order.status === 'paid') return res.redirect(back + '?purchase=success'); // refresh / webhook got here first
  if (order.status !== 'pending') return res.redirect(back + '?purchase=cancelled');

  let result;
  try { result = await payments.provider().confirmReturn(order, req.query); }
  catch (e) { console.error('confirmReturn failed:', e.message); result = { paid: false, error: true }; }

  if (result.cancelled) {
    await payments.markOrder(order.id, 'cancelled');
    logEvent('credit_checkout_cancelled', { userId: req.session.user.id, meta: { order_id: order.id } });
    return res.redirect(back + '?purchase=cancelled');
  }
  if (!result.paid) {
    // Not confirmed (yet). Stripe can take a moment; the webhook will still
    // fulfill a genuinely paid order, so the order stays pending — but the
    // professional is told plainly that no credit has been added.
    return res.redirect(back + '?purchase=pending');
  }
  await payments.fulfillOrder(order.id, result.transactionId, result.amountCents, 'return');
  res.redirect(back + '?purchase=success');
});

// ---------- mock checkout (tests / local demos only; refused in production) ----------
router.get('/agent/credits/mock-checkout/:id(\\d+)', agent, async (req, res) => {
  const p = payments.provider();
  if (!p || p.name !== 'mock') return res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  const order = await payments.loadOrder(parseInt(req.params.id, 10), req.session.user.id);
  if (!order || order.status !== 'pending') return res.redirect('/agent');
  res.render('agent/mock-checkout', { title: 'Test checkout', order, pkg: payments.packageByKey(order.package_key) });
});

router.post('/agent/credits/mock-checkout/:id(\\d+)', agent, async (req, res) => {
  const p = payments.provider();
  if (!p || p.name !== 'mock') return res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  const order = await payments.loadOrder(parseInt(req.params.id, 10), req.session.user.id);
  if (!order || order.status !== 'pending') return res.redirect('/agent');
  if (req.body.action !== 'pay') return res.redirect(`/agent/credits/return?order=${order.id}&cancel=1`);
  const token = require('crypto').randomBytes(16).toString('hex');
  await pool.query(`UPDATE credit_orders SET provider_session_id=$2 WHERE id=$1`, [order.id, token]);
  res.redirect(`/agent/credits/return?order=${order.id}&token=${token}`);
});

// ---------- Stripe webhook ----------
// Mounted in server.js BEFORE the session/CSRF layers with a raw body, which
// signature verification requires. Adds credits for a paid Checkout Session
// even if the professional closed the browser before returning.
async function stripeWebhook(req, res) {
  const p = payments.provider();
  if (!p || p.name !== 'stripe') return res.status(404).end();
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
  const event = payments.stripeProvider.verifyWebhook(raw, req.get('stripe-signature'));
  if (!event) return res.status(400).send('invalid signature');
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const s = event.data && event.data.object;
      if (s && s.payment_status === 'paid') {
        const { rows } = await pool.query(
          `SELECT * FROM credit_orders WHERE provider='stripe' AND (provider_session_id=$1 OR id=$2)`,
          [s.id, parseInt(s.client_reference_id, 10) || 0]);
        if (rows[0]) await payments.fulfillOrder(rows[0].id, s.payment_intent || s.id, s.amount_total, 'webhook');
      }
    }
    res.json({ received: true });
  } catch (e) {
    console.error('stripe webhook error:', e.message);
    res.status(500).end();
  }
}

// Human-readable banner for ?purchase=… on the pages the professional
// returns to (opportunity pages and the dashboard).
function purchaseNotice(query, credits) {
  switch (query.purchase) {
    case 'success': return { kind: 'success', text: `Payment confirmed — your purchased credit${credits && credits.purchased === 1 ? ' is' : 's are'} ready to use. Your draft was restored exactly as you left it.` };
    case 'cancelled': return { kind: 'info', text: 'Checkout was cancelled. Nothing was charged and no credit was added — your draft is saved below.' };
    case 'pending': return { kind: 'info', text: "We couldn't confirm the payment yet. If it went through, the credit will appear on your dashboard within a few minutes; nothing has been added until then." };
    case 'failed': return { kind: 'error', text: 'The payment could not be started. Nothing was charged. Please try again in a moment, or contact us if it keeps happening.' };
    case 'unavailable': return { kind: 'info', text: 'Credit purchases are not open yet — your draft has been saved so nothing is lost. Purchasing opens once payments are enabled.' };
    default: return null;
  }
}

module.exports = router;
module.exports.stripeWebhook = stripeWebhook;
module.exports.saveDraft = saveDraft;
module.exports.loadDraft = loadDraft;
module.exports.clearDraft = clearDraft;
module.exports.purchaseNotice = purchaseNotice;
module.exports.CREDIT_BUNDLES = CREDIT_BUNDLES;
module.exports.creditSummary = creditSummary;
