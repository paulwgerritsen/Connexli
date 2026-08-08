// routes/seller.js — the homeowner experience.
const express = require('express');
const { pool, logEvent } = require('../db');
const { requireRole } = require('../middleware');
const H = require('../helpers');
const mailer = require('../mailer');

const router = require('../middleware').safeRouter(express.Router());
const seller = requireRole('seller');

// My requests
router.get('/dashboard', seller, async (req, res) => {
  const { rows: requests } = await pool.query(
    `SELECT r.*, (SELECT COUNT(*) FROM proposals p WHERE p.request_id = r.id)::int AS proposal_count
     FROM requests r WHERE r.seller_id=$1 ORDER BY r.created_at DESC`,
    [req.session.user.id]
  );
  res.render('seller/dashboard', { title: 'My requests', requests, H });
});

// New request form
router.get('/requests/new', seller, (req, res) => {
  res.render('seller/new-request', { title: 'Tell us about your home', H, error: null, form: {} });
});

router.post('/requests/new', seller, async (req, res) => {
  const f = {
    property_type: H.oneOf(req.body.property_type, H.PROPERTY_TYPES, null),
    zip: H.clean(req.body.zip, 10),
    city: H.clean(req.body.city, 60),
    neighborhood: H.clean(req.body.neighborhood, 80),
    beds: H.oneOf(req.body.beds, H.BEDS, '3'),
    baths: H.oneOf(req.body.baths, H.BATHS, '2'),
    sqft_range: H.oneOf(req.body.sqft_range, H.SQFT, H.SQFT[3]),
    year_built: H.oneOf(req.body.year_built, H.YEARS, H.YEARS[2]),
    hoa: req.body.hoa === 'Yes' ? 'Yes' : 'No',
    condition: H.oneOf(req.body.condition, H.CONDITIONS, 'Updated'),
    price_range: Object.keys(H.PRICE_RANGES).includes(req.body.price_range) ? req.body.price_range : null,
    window_hours: [24, 48, 72, 168].includes(parseInt(req.body.window_hours)) ? parseInt(req.body.window_hours) : 72,
  };
  let priorities = req.body.priorities || [];
  if (!Array.isArray(priorities)) priorities = [priorities];
  priorities = priorities.filter(p => H.PRIORITIES.includes(p)).slice(0, 2);

  if (!f.property_type || !f.zip.match(/^\d{5}$/) || !f.city || !f.price_range) {
    return res.status(400).render('seller/new-request', {
      title: 'Tell us about your home', H, form: { ...f, priorities },
      error: 'Please choose a property type, enter a 5-digit ZIP code and city, and pick a price range.',
    });
  }

  const { rows } = await pool.query(
    `INSERT INTO requests (seller_id, property_type, zip, city, neighborhood, beds, baths, sqft_range,
       year_built, hoa, condition, price_range, priorities, window_hours, closes_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() + make_interval(hours => $14))
     RETURNING id`,
    [req.session.user.id, f.property_type, f.zip, f.city, f.neighborhood, f.beds, f.baths, f.sqft_range,
     f.year_built, f.hoa, f.condition, f.price_range, priorities.join(' + '), f.window_hours]
  );
  const { rows: fullRows } = await pool.query(`SELECT * FROM requests WHERE id=$1`, [rows[0].id]);
  mailer.agentsNewRequest(fullRows[0]); // fire and forget: notify nearby approved professionals
  mailer.sellerRequestReceived(req.session.user.email, req.session.user.name, fullRows[0]); // instant confirmation
  logEvent('request_posted', { userId: req.session.user.id, requestId: rows[0].id,
    meta: { zip: f.zip, city: f.city, price_range: f.price_range, window_hours: f.window_hours } });
  res.redirect('/requests/' + rows[0].id);
});

// Load a request owned by this seller (helper)
async function loadRequest(req, res) {
  const { rows } = await pool.query(`SELECT * FROM requests WHERE id=$1 AND seller_id=$2`, [req.params.id, req.session.user.id]);
  if (!rows[0]) { res.status(404).render('error', { title: 'Not found', message: 'That request does not exist.' }); return null; }
  return rows[0];
}

// Request detail: countdown while open, proposals after close
router.get('/requests/:id(\\d+)', seller, async (req, res) => {
  const request = await loadRequest(req, res);
  if (!request) return;

  if (request.status === 'open') {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM proposals WHERE request_id=$1`, [request.id]);
    return res.render('seller/request-open', {
      title: 'Your request is live', request, proposalCount: rows[0].n, H,
      roundCap: request.round * H.ROUND_CAP, // window auto-closes at this count
    });
  }

  const { rows: proposals } = await pool.query(
    `SELECT p.*, u.name AS agent_name, u.email AS agent_email, u.phone AS agent_phone, ap.brokerage, ap.license_number,
       ap.transactions_seller_12mo, ap.transactions_buyer_12mo
     FROM proposals p
     JOIN users u ON u.id = p.agent_id
     JOIN agent_profiles ap ON ap.user_id = p.agent_id
     WHERE p.request_id=$1`,
    [request.id]
  );
  const sort = ['fee', 'newest'].includes(req.query.sort) ? req.query.sort : 'fee';
  proposals.sort((a, b) => sort === 'fee'
    ? H.estFee(a, request.price_range) - H.estFee(b, request.price_range)
    : new Date(b.created_at) - new Date(a.created_at));

  res.render('seller/request-results', { title: 'Your proposals', request, proposals, sort, H });
});

// Compare table
router.get('/requests/:id(\\d+)/compare', seller, async (req, res) => {
  const request = await loadRequest(req, res);
  if (!request) return;
  if (request.status === 'open') return res.redirect('/requests/' + request.id);
  const { rows: proposals } = await pool.query(
    `SELECT p.*, u.name AS agent_name, ap.brokerage, ap.transactions_seller_12mo, ap.transactions_buyer_12mo
     FROM proposals p
     JOIN users u ON u.id=p.agent_id JOIN agent_profiles ap ON ap.user_id=p.agent_id
     WHERE p.request_id=$1 ORDER BY p.shortlisted DESC, p.created_at ASC`,
    [request.id]
  );
  const shortlisted = proposals.filter(p => p.shortlisted);
  res.render('seller/compare', {
    title: 'Compare proposals', request, H,
    proposals: shortlisted.length >= 2 ? shortlisted : proposals,
    usingShortlist: shortlisted.length >= 2,
  });
});

// Request another round of proposals. Reopens the window for the same length
// the seller originally chose, invites up to 10 MORE professionals, and hides
// the request from everyone who already proposed in an earlier round (their
// sealed proposals stay in the stack).
router.post('/requests/:id(\\d+)/rebid', seller, async (req, res) => {
  const request = await loadRequest(req, res);
  if (!request) return;
  if (request.status !== 'closed') return res.redirect('/requests/' + request.id);

  const { rows } = await pool.query(
    `UPDATE requests SET round = round + 1, status='open', closes_at = now() + make_interval(hours => window_hours)
     WHERE id=$1 AND status='closed' RETURNING *`, [request.id]);
  if (!rows[0]) return res.redirect('/requests/' + request.id);

  // Professionals who already proposed are excluded from the new-round emails.
  const { rows: prior } = await pool.query(`SELECT agent_id FROM proposals WHERE request_id=$1`, [request.id]);
  mailer.agentsNewRequest(rows[0], prior.map(p => p.agent_id)); // fire and forget
  logEvent('request_new_round', { userId: req.session.user.id, requestId: request.id,
    meta: { round: rows[0].round, prior_proposals: prior.length } });
  res.redirect('/requests/' + request.id);
});

// Close the window early
router.post('/requests/:id(\\d+)/close', seller, async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE requests SET status='closed', closes_at=now() WHERE id=$1 AND seller_id=$2 AND status='open' RETURNING *`,
    [req.params.id, req.session.user.id]);
  if (rows[0]) {
    logEvent('request_closed_early', { userId: req.session.user.id, requestId: parseInt(req.params.id) });
    // Email the written record too, so "your proposals are ready" always
    // lands in the inbox no matter how the window ended.
    mailer.sellerProposalsReady(req.session.user.email, req.session.user.name, rows[0]); // fire and forget
  }
  res.redirect('/requests/' + req.params.id);
});

// Shortlist toggle
router.post('/requests/:id(\\d+)/shortlist/:pid(\\d+)', seller, async (req, res) => {
  const request = await loadRequest(req, res);
  if (!request) return;
  if (request.status === 'closed') {
    await pool.query(`UPDATE proposals SET shortlisted = NOT shortlisted WHERE id=$1 AND request_id=$2`, [req.params.pid, request.id]);
    logEvent('shortlist_toggled', { userId: req.session.user.id, requestId: request.id, proposalId: parseInt(req.params.pid) });
  }
  res.redirect('/requests/' + request.id + (req.body.from === 'compare' ? '/compare' : ''));
});

// Connect: release contact info to one agent
router.post('/requests/:id(\\d+)/connect/:pid(\\d+)', seller, async (req, res) => {
  const request = await loadRequest(req, res);
  if (!request) return;
  if (request.status !== 'closed') return res.redirect('/requests/' + request.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE proposals SET connected=true, connected_at=now() WHERE id=$1 AND request_id=$2`,
      [req.params.pid, request.id]
    );
    if (rowCount) await client.query(`UPDATE requests SET status='connected' WHERE id=$1`, [request.id]);
    await client.query('COMMIT');
    const { rows: winner } = await pool.query(
      `SELECT u.email, u.name FROM proposals p JOIN users u ON u.id=p.agent_id WHERE p.id=$1`, [req.params.pid]);
    if (winner[0]) mailer.agentWon(winner[0].email, winner[0].name, request); // fire and forget
    if (rowCount) logEvent('connected', { userId: req.session.user.id, requestId: request.id, proposalId: parseInt(req.params.pid) });
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.redirect('/requests/' + request.id);
});

module.exports = router;
