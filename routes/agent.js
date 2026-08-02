// routes/agent.js — the professional experience.
const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../middleware');
const H = require('../helpers');

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

// Opportunity detail + proposal form
router.get('/agent/opportunities/:id(\\d+)', agent, async (req, res) => {
  const profile = await profileOf(req.session.user.id);
  if (!profile || profile.status !== 'approved') return res.redirect('/agent');

  const { rows } = await pool.query(`SELECT * FROM requests WHERE id=$1`, [req.params.id]);
  const request = rows[0];
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'That opportunity does not exist.' });

  const { rows: mine } = await pool.query(
    `SELECT * FROM proposals WHERE request_id=$1 AND agent_id=$2`, [request.id, req.session.user.id]);

  res.render('agent/opportunity', { title: 'Opportunity', request, proposal: mine[0] || null, H, error: null });
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

  await pool.query(
    `INSERT INTO proposals (request_id, agent_id, fee_type, fee_amount, services, marketing_plan, cancellation_terms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (request_id, agent_id) DO UPDATE SET
       fee_type=EXCLUDED.fee_type, fee_amount=EXCLUDED.fee_amount, services=EXCLUDED.services,
       marketing_plan=EXCLUDED.marketing_plan, cancellation_terms=EXCLUDED.cancellation_terms, updated_at=now()`,
    [request.id, req.session.user.id, fee_type, fee_amount, services.join(', '), marketing_plan, cancellation_terms]
  );
  res.redirect('/agent/opportunities/' + request.id);
});

// Withdraw a proposal (only while the window is open)
router.post('/agent/opportunities/:id(\\d+)/withdraw', agent, async (req, res) => {
  await pool.query(
    `DELETE FROM proposals p USING requests r
     WHERE p.request_id=r.id AND r.id=$1 AND p.agent_id=$2 AND r.status='open'`,
    [req.params.id, req.session.user.id]
  );
  res.redirect('/agent');
});

module.exports = router;
