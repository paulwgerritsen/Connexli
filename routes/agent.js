// routes/agent.js — the professional experience.
const express = require('express');
const { pool, logEvent } = require('../db');
const { requireRole } = require('../middleware');
const H = require('../helpers');
const mailer = require('../mailer');

const router = require('../middleware').safeRouter(express.Router());
const agent = requireRole('agent');

async function profileOf(userId) {
  const { rows } = await pool.query(`SELECT * FROM agent_profiles WHERE user_id=$1`, [userId]);
  return rows[0];
}

// Agent dashboard: verification status, stats, opportunities, activity
router.get('/agent', agent, async (req, res) => {
  const profile = await profileOf(req.session.user.id);
  if (!profile) return res.status(500).render('error', { title: 'Profile missing', message: 'Your professional profile was not found. Contact support.' });

  if (profile.status !== 'approved') {
    return res.render('agent/pending', { title: 'Verification in progress', profile });
  }

  const uid = req.session.user.id;
  const [opps, mine, stats] = await Promise.all([
    pool.query(
      `SELECT r.*,
         (SELECT COUNT(*) FROM proposals p WHERE p.request_id=r.id AND p.agent_id=$1)::int AS mine
       FROM requests r WHERE r.status='open' ORDER BY r.closes_at ASC`, [uid]),
    pool.query(
      `SELECT p.*, r.city, r.zip, r.property_type, r.price_range, r.status AS request_status, r.closes_at
       FROM proposals p JOIN requests r ON r.id=p.request_id
       WHERE p.agent_id=$1 ORDER BY p.created_at DESC`, [uid]),
    pool.query(
      `SELECT
         COUNT(*)::int AS submitted,
         COUNT(*) FILTER (WHERE shortlisted)::int AS shortlisted,
         COUNT(*) FILTER (WHERE connected)::int AS connected
       FROM proposals WHERE agent_id=$1`, [uid]),
  ]);

  // Won clients: connected proposals reveal the seller's contact info.
  const { rows: wins } = await pool.query(
    `SELECT p.id, u.name AS seller_name, u.email AS seller_email, u.phone AS seller_phone,
            r.city, r.zip, r.property_type, r.price_range
     FROM proposals p JOIN requests r ON r.id=p.request_id JOIN users u ON u.id=r.seller_id
     WHERE p.agent_id=$1 AND p.connected ORDER BY p.connected_at DESC`, [req.session.user.id]);

  res.render('agent/dashboard', {
    title: 'Opportunities', profile, H,
    opportunities: opps.rows, myProposals: mine.rows, stats: stats.rows[0], wins,
  });
});

// ---------- account settings ----------
// Open to every professional regardless of status, so pending agents can fix
// their information before review.
async function renderSettings(req, res, opts = {}) {
  const { rows } = await pool.query(
    `SELECT ap.*, u.name, u.email, u.phone FROM agent_profiles ap
     JOIN users u ON u.id = ap.user_id WHERE ap.user_id=$1`, [req.session.user.id]);
  if (!rows[0]) return res.status(500).render('error', { title: 'Profile missing', message: 'Your professional profile was not found. Contact support.' });
  // On a validation error, keep whatever the professional just typed so they
  // can fix one field without re-entering the rest.
  const p = { ...rows[0], ...(opts.form || {}) };
  res.status(opts.error ? 400 : 200).render('agent/settings', { title: 'Account settings', p, error: opts.error || null, saved: opts.saved || false });
}

router.get('/agent/settings', agent, (req, res) => renderSettings(req, res, { saved: req.query.saved === '1' }));

router.post('/agent/settings', agent, async (req, res) => {
  const name = H.clean(req.body.name, 100);
  const email = H.clean(req.body.email, 120).toLowerCase();
  const phone = H.clean(req.body.phone, 30);
  const brokerage = H.clean(req.body.brokerage, 100);
  const service_zip = H.clean(req.body.service_zip, 10);
  // Transactions are optional; blank means "not provided", zero is a real answer.
  const txn = (v) => {
    if (String(v || '').trim() === '') return null;
    const n = parseInt(v, 10);
    return (Number.isInteger(n) && n >= 0 && n <= 500) ? n : NaN;
  };
  const txnSeller = txn(req.body.transactions_seller_12mo);
  const txnBuyer = txn(req.body.transactions_buyer_12mo);

  const form = { name, email, phone, brokerage, service_zip,
    transactions_seller_12mo: String(req.body.transactions_seller_12mo || '').trim() === '' ? null : req.body.transactions_seller_12mo,
    transactions_buyer_12mo: String(req.body.transactions_buyer_12mo || '').trim() === '' ? null : req.body.transactions_buyer_12mo };
  const fail = (error) => renderSettings(req, res, { error, form });

  if (!name || !email.includes('@')) return fail('Please enter your name and a valid email address.');
  if (!brokerage) return fail('Please enter your brokerage.');
  if (!service_zip.match(/^\d{5}$/)) return fail('Please enter the 5-digit ZIP code at the center of your service area.');
  if (Number.isNaN(txnSeller) || Number.isNaN(txnBuyer)) return fail('Transaction counts must be whole numbers between 0 and 500 (or left blank).');
  const geo = mailer.zipInfo(service_zip);
  if (!geo) return fail('We could not find that ZIP code. Please double-check your primary service ZIP.');

  try {
    await pool.query(`UPDATE users SET name=$1, email=$2, phone=$3 WHERE id=$4`,
      [name, email, phone, req.session.user.id]);
  } catch (e) {
    if (e.code === '23505') return fail('Another account already uses that email address.');
    throw e;
  }
  await pool.query(
    `UPDATE agent_profiles SET brokerage=$1, service_zip=$2, service_city=$3, service_state=$4,
       latitude=$5, longitude=$6, transactions_seller_12mo=$7, transactions_buyer_12mo=$8
     WHERE user_id=$9`,
    [brokerage, service_zip, geo.city, geo.state, geo.latitude, geo.longitude, txnSeller, txnBuyer, req.session.user.id]);

  // Keep the header greeting and session in sync with the new details.
  req.session.user.name = name;
  req.session.user.email = email;
  logEvent('agent_settings_updated', { userId: req.session.user.id, meta: { service_zip } });
  res.redirect('/agent/settings?saved=1');
});

// Opportunity detail + proposal form
router.get('/agent/opportunities/:id(\\d+)', agent, async (req, res) => {
  const profile = await profileOf(req.session.user.id);
  if (!profile || profile.status !== 'approved') return res.redirect('/agent');

  const { rows } = await pool.query(`SELECT * FROM requests WHERE id=$1`, [req.params.id]);
  const request = rows[0];
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'That opportunity does not exist.' });

  const { rows: mine } = await pool.query(
    `SELECT * FROM proposals WHERE request_id=$1 AND agent_id=$2`, [request.id, req.session.user.id]);

  logEvent('opportunity_viewed', { userId: req.session.user.id, requestId: request.id });
  res.render('agent/opportunity', { title: 'Opportunity', request, proposal: mine[0] || null, H, error: null });
});

// Confirmation page after a proposal is submitted or updated
router.get('/agent/opportunities/:id(\\d+)/submitted', agent, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.updated_at, p.created_at, r.* FROM proposals p JOIN requests r ON r.id = p.request_id
     WHERE p.request_id=$1 AND p.agent_id=$2`, [req.params.id, req.session.user.id]);
  if (!rows[0]) return res.redirect('/agent');
  res.render('agent/submitted', {
    title: req.query.updated === '1' ? 'Proposal updated' : 'Proposal submitted',
    request: rows[0],
    wasUpdate: req.query.updated === '1',
    H,
  });
});

// Create or update a sealed proposal (allowed while the window is open)
router.post('/agent/opportunities/:id(\\d+)/propose', agent, async (req, res) => {
  const profile = await profileOf(req.session.user.id);
  if (!profile || profile.status !== 'approved') return res.redirect('/agent');

  const { rows } = await pool.query(`SELECT * FROM requests WHERE id=$1 AND status='open'`, [req.params.id]);
  const request = rows[0];
  if (!request) return res.status(400).render('error', { title: 'Window closed', message: 'This proposal window has already closed.' });

  const fee_type = req.body.fee_type === 'flat' ? 'flat' : 'pct';
  const fee_amount = parseFloat(String(req.body.fee_amount).replace(/[^0-9.]/g, ''));
  let services = req.body.services || [];
  if (!Array.isArray(services)) services = [services];
  services = services.filter(s => H.SERVICES.includes(s));
  const marketing_plan = H.clean(req.body.marketing_plan, 1000);
  const cancellation_terms = H.oneOf(req.body.cancellation_terms, H.CANCELLATION, H.CANCELLATION[0]);

  const mineBefore = await pool.query(
    `SELECT 1 FROM proposals WHERE request_id=$1 AND agent_id=$2`, [request.id, req.session.user.id]);

  const bad = !fee_amount || fee_amount <= 0 ||
    (fee_type === 'pct' && fee_amount > 10) ||
    (fee_type === 'flat' && fee_amount > 200000);
  if (bad) {
    return res.status(400).render('agent/opportunity', {
      title: 'Opportunity', request, H,
      proposal: { fee_type, fee_amount: req.body.fee_amount, services: services.join(', '), marketing_plan, cancellation_terms },
      error: fee_type === 'pct'
        ? 'Please enter a percentage fee between 0.1 and 10.'
        : 'Please enter a flat fee amount in dollars (up to $200,000).',
    });
  }

  const { rows: saved } = await pool.query(
    `INSERT INTO proposals (request_id, agent_id, fee_type, fee_amount, services, marketing_plan, cancellation_terms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (request_id, agent_id) DO UPDATE SET
       fee_type=EXCLUDED.fee_type, fee_amount=EXCLUDED.fee_amount, services=EXCLUDED.services,
       marketing_plan=EXCLUDED.marketing_plan, cancellation_terms=EXCLUDED.cancellation_terms, updated_at=now()
     RETURNING id`,
    [request.id, req.session.user.id, fee_type, fee_amount, services.join(', '), marketing_plan, cancellation_terms]
  );
  const wasUpdate = mineBefore.rows.length > 0;
  logEvent(wasUpdate ? 'proposal_updated' : 'proposal_submitted', {
    userId: req.session.user.id, requestId: request.id, proposalId: saved[0].id,
    meta: { fee_type, fee_amount, price_range: request.price_range },
  });
  res.redirect('/agent/opportunities/' + request.id + '/submitted' + (wasUpdate ? '?updated=1' : ''));
});

// Withdraw a proposal (only while the window is open)
router.post('/agent/opportunities/:id(\\d+)/withdraw', agent, async (req, res) => {
  const { rowCount } = await pool.query(
    `DELETE FROM proposals p USING requests r
     WHERE p.request_id=r.id AND r.id=$1 AND p.agent_id=$2 AND r.status='open'`,
    [req.params.id, req.session.user.id]
  );
  if (rowCount) logEvent('proposal_withdrawn', { userId: req.session.user.id, requestId: parseInt(req.params.id) });
  res.redirect('/agent');
});

module.exports = router;
