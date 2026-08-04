// routes/admin.js — approve agents, monitor the pilot.
const express = require('express');
const { pool } = require('../db');
const { requireRole } = require('../middleware');
const H = require('../helpers');
const mailer = require('../mailer');

const router = require('../middleware').safeRouter(express.Router());
const admin = requireRole('admin');

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
        (SELECT COUNT(*) FROM requests WHERE status='connected')::int AS connected_requests,
        (SELECT COUNT(*) FROM users WHERE role='seller')::int AS sellers,
        (SELECT COUNT(*) FROM agent_profiles WHERE status='approved')::int AS approved_agents,
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

router.post('/admin/agents/:id(\\d+)/:action(approve|reject)', admin, async (req, res) => {
  const status = req.params.action === 'approve' ? 'approved' : 'rejected';
  await pool.query(`UPDATE agent_profiles SET status=$1, reviewed_at=now() WHERE user_id=$2`, [status, req.params.id]);
  const { rows } = await pool.query(`SELECT email, name FROM users WHERE id=$1`, [req.params.id]);
  if (rows[0]) {
    if (status === 'approved') mailer.agentApproved(rows[0].email, rows[0].name); // fire and forget
    else mailer.agentRejected(rows[0].email, rows[0].name);
  }
  res.redirect('/admin');
});

module.exports = router;
