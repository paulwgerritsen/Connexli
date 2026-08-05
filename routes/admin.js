// routes/admin.js — the pilot control center: approve, inspect, and manage
// professionals and homeowner requests.
const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../middleware');
const H = require('../helpers');
const mailer = require('../mailer');

const router = require('../middleware').safeRouter(express.Router());
const admin = requireRole('admin');

// ---------- main dashboard ----------
router.get('/admin', admin, async (req, res) => {
  const [pending, agents, requests, metrics] = await Promise.all([
    pool.query(
      `SELECT ap.*, u.name, u.email, u.phone FROM agent_profiles ap JOIN users u ON u.id=ap.user_id
       WHERE ap.status='pending' ORDER BY ap.created_at ASC`),
    pool.query(
      `SELECT ap.*, u.name, u.email FROM agent_profiles ap JOIN users u ON u.id=ap.user_id
       WHERE ap.status <> 'pending' ORDER BY ap.reviewed_at DESC NULLS LAST LIMIT 50`),
    pool.query(
      `SELECT r.*, u.name AS seller_name,
         (SELECT COUNT(*) FROM proposals p WHERE p.request_id=r.id)::int AS proposal_count
       FROM requests r JOIN users u ON u.id=r.seller_id ORDER BY r.created_at DESC LIMIT 100`),
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM requests)::int AS total_requests,
        (SELECT COUNT(*) FROM requests WHERE status='open')::int AS open_requests,
        (SELECT COUNT(*) FROM requests WHERE status IN ('closed','connected'))::int AS completed_requests,
        (SELECT COUNT(*) FROM requests WHERE status='connected')::int AS connected_requests,
        (SELECT COUNT(*) FROM users WHERE role='seller')::int AS sellers,
        (SELECT COUNT(*) FROM agent_profiles WHERE status='approved')::int AS approved_agents,
        (SELECT COUNT(*) FROM agent_profiles WHERE status='pending')::int AS pending_agents,
        (SELECT COUNT(*) FROM proposals)::int AS total_proposals,
        COALESCE((SELECT ROUND(AVG(c),1) FROM (
          SELECT COUNT(p.id) AS c FROM requests r LEFT JOIN proposals p ON p.request_id=r.id
          WHERE r.status <> 'open' GROUP BY r.id) sub), 0) AS avg_proposals,
        (SELECT COUNT(*) FROM (
          SELECT r.id FROM requests r JOIN proposals p ON p.request_id=r.id
          WHERE r.status <> 'open' GROUP BY r.id HAVING COUNT(p.id) >= 3) sub2)::int AS requests_with_3plus
    `),
  ]);

  res.render('admin/dashboard', {
    title: 'Admin', H,
    pending: pending.rows, agents: agents.rows, requests: requests.rows, m: metrics.rows[0],
  });
});

// ---------- professional detail ----------
router.get('/admin/agents/:id(\\d+)', admin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ap.*, u.name, u.email, u.phone, u.created_at AS registered_at
     FROM agent_profiles ap JOIN users u ON u.id=ap.user_id WHERE ap.user_id=$1`, [req.params.id]);
  const agent = rows[0];
  if (!agent) return res.status(404).render('error', { title: 'Not found', message: 'That professional does not exist.' });

  const [proposals, oppCount] = await Promise.all([
    pool.query(
      `SELECT p.*, r.city, r.zip, r.property_type, r.price_range, r.status AS request_status
       FROM proposals p JOIN requests r ON r.id=p.request_id
       WHERE p.agent_id=$1 ORDER BY p.created_at DESC`, [req.params.id]),
    // Opportunities received: requests created after approval, within the
    // notification radius of the professional's service ZIP.
    pool.query(`SELECT zip, created_at FROM requests WHERE created_at >= COALESCE(
      (SELECT reviewed_at FROM agent_profiles WHERE user_id=$1), now())`, [req.params.id]),
  ]);
  const opportunities = oppCount.rows.filter(r => {
    const d = mailer.zipDistance(r.zip, agent.service_zip);
    return d === null || d <= mailer.RADIUS_MILES;
  }).length;
  const submitted = proposals.rows.length;
  const wins = proposals.rows.filter(p => p.connected).length;

  res.render('admin/agent-detail', {
    title: agent.name, agent, H,
    proposals: proposals.rows,
    stats: {
      opportunities, submitted, wins,
      successRate: submitted ? Math.round(100 * wins / submitted) + '%' : 'n/a',
    },
  });
});

// ---------- professional actions ----------
router.post('/admin/agents/:id(\\d+)/:action(approve|reject|suspend|reinstate)', admin, async (req, res) => {
  const map = { approve: 'approved', reject: 'rejected', suspend: 'suspended', reinstate: 'approved' };
  const status = map[req.params.action];
  await pool.query(`UPDATE agent_profiles SET status=$1, reviewed_at=now() WHERE user_id=$2`, [status, req.params.id]);
  if (req.params.action === 'approve' || req.params.action === 'reject') {
    const { rows } = await pool.query(`SELECT email, name FROM users WHERE id=$1`, [req.params.id]);
    if (rows[0]) {
      if (status === 'approved') mailer.agentApproved(rows[0].email, rows[0].name); // fire and forget
      else mailer.agentRejected(rows[0].email, rows[0].name);
    }
  }
  res.redirect(req.body.from === 'detail' ? '/admin/agents/' + req.params.id : '/admin');
});

// Permanently remove: deletes the account and all their proposals. Guarded by
// a confirmation on the button; cannot remove admins.
router.post('/admin/agents/:id(\\d+)/remove', admin, async (req, res) => {
  await pool.query(`DELETE FROM users WHERE id=$1 AND role='agent'`, [req.params.id]);
  res.redirect('/admin');
});

// ---------- request detail ----------
router.get('/admin/requests/:id(\\d+)', admin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, u.name AS seller_name, u.email AS seller_email FROM requests r
     JOIN users u ON u.id=r.seller_id WHERE r.id=$1`, [req.params.id]);
  const request = rows[0];
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'That request does not exist.' });

  const [proposals, approvedAgents] = await Promise.all([
    pool.query(
      `SELECT p.*, u.name AS agent_name, ap.brokerage FROM proposals p
       JOIN users u ON u.id=p.agent_id JOIN agent_profiles ap ON ap.user_id=p.agent_id
       WHERE p.request_id=$1 ORDER BY p.created_at ASC`, [req.params.id]),
    pool.query(`SELECT service_zip FROM agent_profiles WHERE status='approved'`),
  ]);
  // How many approved professionals are currently within the notification radius
  const inRange = approvedAgents.rows.filter(a => {
    const d = mailer.zipDistance(request.zip, a.service_zip);
    return d === null || d <= mailer.RADIUS_MILES;
  }).length;

  res.render('admin/request-detail', {
    title: 'Request detail', request, H,
    proposals: proposals.rows, inRange, radius: mailer.RADIUS_MILES,
  });
});

module.exports = router;
