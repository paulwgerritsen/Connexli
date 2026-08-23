// routes/admin.js — the pilot control center: approve, inspect, and manage
// professionals and homeowner requests.
const express = require('express');
const { pool, logEvent } = require('../db');
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
          WHERE r.status <> 'open' GROUP BY r.id HAVING COUNT(p.id) >= 3) sub2)::int AS requests_with_3plus,
        (SELECT COUNT(*) FROM buyer_profiles WHERE status='active' AND published)::int AS active_buyers,
        (SELECT COUNT(*) FROM buyer_profiles WHERE status='active' AND NOT published)::int AS exploring_buyers,
        (SELECT COUNT(*) FROM buyer_proposals)::int AS buyer_proposals,
        (SELECT COUNT(*) FROM buyer_proposals WHERE connected)::int AS buyer_connections
    `),
  ]);

  const { rows: buyers } = await pool.query(
    `SELECT b.*, u.name AS buyer_name, u.email AS buyer_email,
       (SELECT COUNT(*) FROM buyer_proposals p WHERE p.profile_id=b.id)::int AS proposal_count
     FROM buyer_profiles b JOIN users u ON u.id=b.user_id ORDER BY b.created_at DESC LIMIT 50`);

  res.render('admin/dashboard', {
    title: 'Admin', H,
    pending: pending.rows, agents: agents.rows, requests: requests.rows, m: metrics.rows[0], buyers,
  });
});

// ---------- analytics ----------
// Everything is computed from Connexli's own database. Nothing leaves it.
router.get('/admin/analytics', admin, async (req, res) => {
  const [thirty, weekly, feeRows, reqZips, agentZips, firstProps, viewCounts] = await Promise.all([
    // Stat cards: the last 30 days at a glance
    pool.query(`
      SELECT
        (SELECT COUNT(*) FROM users WHERE role='seller' AND created_at > now() - interval '30 days')::int AS new_sellers,
        (SELECT COUNT(*) FROM users WHERE role='agent' AND created_at > now() - interval '30 days')::int AS new_agents,
        (SELECT COUNT(*) FROM requests WHERE created_at > now() - interval '30 days')::int AS new_requests,
        (SELECT COUNT(*) FROM proposals WHERE created_at > now() - interval '30 days')::int AS new_proposals,
        (SELECT COUNT(*) FROM proposals WHERE connected_at > now() - interval '30 days')::int AS new_connections
    `),
    // Weekly marketplace funnel, last 12 weeks
    pool.query(`
      SELECT w.week,
        COALESCE(r.n,0)::int AS requests, COALESCE(p.n,0)::int AS proposals, COALESCE(c.n,0)::int AS connections
      FROM generate_series(date_trunc('week', now()) - interval '11 weeks', date_trunc('week', now()), interval '1 week') AS w(week)
      LEFT JOIN (SELECT date_trunc('week', created_at) wk, COUNT(*) n FROM requests GROUP BY 1) r ON r.wk = w.week
      LEFT JOIN (SELECT date_trunc('week', created_at) wk, COUNT(*) n FROM proposals GROUP BY 1) p ON p.wk = w.week
      LEFT JOIN (SELECT date_trunc('week', connected_at) wk, COUNT(*) n FROM proposals WHERE connected GROUP BY 1) c ON c.wk = w.week
      ORDER BY w.week
    `),
    // Every proposal with what's needed to express its fee as a percentage
    pool.query(`
      SELECT p.created_at, p.fee_type, p.fee_amount::float, r.price_range
      FROM proposals p JOIN requests r ON r.id = p.request_id
    `),
    // Demand: requests per ZIP
    pool.query(`SELECT zip, city, COUNT(*)::int AS n FROM requests GROUP BY zip, city ORDER BY n DESC LIMIT 10`),
    // Supply: approved professionals' service ZIPs
    pool.query(`SELECT service_zip FROM agent_profiles WHERE status='approved'`),
    // Speed: hours from request posted to its first proposal
    pool.query(`
      SELECT EXTRACT(EPOCH FROM (MIN(p.created_at) - r.created_at))/3600.0 AS hours
      FROM requests r JOIN proposals p ON p.request_id = r.id GROUP BY r.id
    `),
    // Engagement from the event log: opportunity views per week
    pool.query(`
      SELECT date_trunc('week', created_at) AS week, COUNT(*)::int AS n
      FROM events WHERE event_type='opportunity_viewed' GROUP BY 1
    `),
  ]);

  // Fee as % of the price range midpoint (flat fees converted).
  const feePct = (p) => p.fee_type === 'pct' ? p.fee_amount : (100 * p.fee_amount / (H.PRICE_RANGES[p.price_range] || 500000));
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  // Median fee % per week (only weeks that had proposals)
  const byWeek = {};
  for (const p of feeRows.rows) {
    const wk = new Date(p.created_at); wk.setHours(0, 0, 0, 0);
    wk.setDate(wk.getDate() - ((wk.getDay() + 6) % 7)); // Monday of that week
    const key = wk.toISOString().slice(0, 10);
    (byWeek[key] = byWeek[key] || []).push(feePct(p));
  }
  const feeTrend = Object.keys(byWeek).sort().slice(-12)
    .map(k => ({ week: k, median: Math.round(median(byWeek[k]) * 100) / 100, count: byWeek[k].length }));

  // Coverage: for each high-demand ZIP, how many approved pros are in range?
  const coverage = reqZips.rows.map(z => ({
    zip: z.zip, city: z.city, requests: z.n,
    agentsInRange: agentZips.rows.filter(a => {
      const d = mailer.zipDistance(z.zip, a.service_zip);
      return d === null || d <= mailer.RADIUS_MILES;
    }).length,
  }));

  const hours = firstProps.rows.map(r => parseFloat(r.hours));
  const viewsByWeek = {};
  for (const v of viewCounts.rows) viewsByWeek[new Date(v.week).toISOString().slice(0, 10)] = v.n;

  // Seller-side funnel (Paul, Aug 18): the at-a-glance mirror of the buyer
  // section, computed entirely from existing tables and existing status
  // definitions — open (window active), closed (awaiting the seller's
  // decision), connected (professional selected).
  const { rows: sellerStats } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM requests)::int AS total_requests,
      (SELECT COUNT(*) FROM requests WHERE status='open')::int AS open_requests,
      (SELECT COUNT(*) FROM requests WHERE status='closed')::int AS awaiting,
      (SELECT COUNT(*) FROM requests WHERE status='connected')::int AS connected_requests,
      (SELECT COUNT(*) FROM proposals)::int AS proposals,
      (SELECT COUNT(*) FROM proposals WHERE connected)::int AS connections
  `);

  // Buyer-side metrics: readiness mix, lender-demand counter, funnel counts.
  const { rows: buyerStats } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM buyer_profiles)::int AS total_profiles,
      (SELECT COUNT(*) FROM buyer_profiles WHERE readiness='ready_now')::int AS ready_now,
      (SELECT COUNT(*) FROM buyer_profiles WHERE readiness='preparing')::int AS preparing,
      (SELECT COUNT(*) FROM buyer_profiles WHERE readiness='exploring')::int AS exploring,
      (SELECT COUNT(*) FROM buyer_profiles WHERE NOT in_utah)::int AS relocating,
      (SELECT COUNT(*) FROM events WHERE event_type='lender_recommendation_requested')::int AS lender_requests,
      (SELECT COUNT(*) FROM events WHERE event_type='buyer_upgraded_ready')::int AS upgrades,
      (SELECT COUNT(*) FROM buyer_proposals)::int AS proposals,
      (SELECT COUNT(*) FROM buyer_proposals WHERE connected)::int AS connections
  `);

  res.render('admin/analytics', {
    title: 'Analytics', H,
    m: thirty.rows[0],
    weekly: weekly.rows.map(w => ({ ...w, week: new Date(w.week).toISOString().slice(0, 10) })),
    feeTrend,
    medianFeeAll: feeRows.rows.length ? Math.round(median(feeRows.rows.map(feePct)) * 100) / 100 : null,
    medianFirstProposalHours: hours.length ? Math.round(median(hours) * 10) / 10 : null,
    coverage,
    viewsByWeek,
    radius: mailer.RADIUS_MILES,
    b: buyerStats[0],
    s: sellerStats[0],
  });
});

// ---------- expansion waitlist (Paul, Aug 23) ----------
// Where should Connexli launch next? Totals, a per-state breakdown by user
// type, and (with ?state=) the individual signups for one state.
router.get('/admin/waitlist', admin, async (req, res) => {
  const state = H.clean(req.query.state, 60);
  const [totals, byState, entries] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE user_type='Real estate professional')::int AS pros,
        COUNT(*) FILTER (WHERE user_type='Homeowner thinking about selling')::int AS sellers,
        COUNT(*) FILTER (WHERE user_type='Buyer looking for a home')::int AS buyers,
        COUNT(*) FILTER (WHERE user_type='Just curious')::int AS curious
      FROM waitlist`),
    pool.query(`
      SELECT state, COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE user_type='Real estate professional')::int AS pros,
        COUNT(*) FILTER (WHERE user_type='Homeowner thinking about selling')::int AS sellers,
        COUNT(*) FILTER (WHERE user_type='Buyer looking for a home')::int AS buyers,
        COUNT(*) FILTER (WHERE user_type='Just curious')::int AS curious
      FROM waitlist GROUP BY state ORDER BY total DESC, state`),
    state
      ? pool.query(`SELECT email, user_type, state, created_at FROM waitlist WHERE state=$1 ORDER BY created_at DESC`, [state])
      : Promise.resolve({ rows: [] }),
  ]);
  res.render('admin/waitlist', {
    title: 'Expansion waitlist', H,
    t: totals.rows[0], byState: byState.rows, state: state || null, entries: entries.rows,
  });
});

// ---------- contact messages (Paul, Aug 23) ----------
router.get('/admin/contact', admin, async (req, res) => {
  const { rows: messages } = await pool.query(
    `SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 500`);
  res.render('admin/contact-messages', { title: 'Contact messages', messages, H });
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

  // Buyer-side statistics (Paul, Aug 11): opportunities in reach since
  // approval, proposals submitted, and buyer clients won.
  const [buyerOppsRows, buyerProps] = await Promise.all([
    pool.query(`SELECT search_areas FROM buyer_profiles WHERE published AND created_at >= COALESCE(
      (SELECT reviewed_at FROM agent_profiles WHERE user_id=$1), now())`, [req.params.id]),
    pool.query(
      `SELECT bp.*, b.search_areas, b.price_range FROM buyer_proposals bp
       JOIN buyer_profiles b ON b.id=bp.profile_id WHERE bp.agent_id=$1 ORDER BY bp.created_at DESC`, [req.params.id]),
  ]);
  const buyerOpportunities = buyerOppsRows.rows.filter(b => {
    const cities = String(b.search_areas).split(',').map(s => s.trim()).filter(Boolean);
    const dists = cities.map(c => mailer.cityDistance(agent.service_zip, c)).filter(d => d !== null);
    return !dists.length || Math.min(...dists) <= mailer.RADIUS_MILES;
  }).length;
  const buyerSubmitted = buyerProps.rows.length;
  const buyerWins = buyerProps.rows.filter(p => p.connected).length;

  res.render('admin/agent-detail', {
    title: agent.name, agent, H,
    proposals: proposals.rows,
    buyerProposals: buyerProps.rows,
    stats: {
      opportunities, submitted, wins,
      buyerOpportunities, buyerSubmitted, buyerWins,
      successRate: submitted ? Math.round(100 * wins / submitted) + '%' : 'n/a',
    },
  });
});

// ---------- buyer request detail (mirrors the seller request detail) ----------
router.get('/admin/buyers/:id(\\d+)', admin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT b.*, u.name AS buyer_name, u.email AS buyer_email, u.phone AS buyer_phone,
       (SELECT COUNT(*) FROM buyer_proposals p WHERE p.profile_id=b.id)::int AS proposal_count
     FROM buyer_profiles b JOIN users u ON u.id=b.user_id WHERE b.id=$1`, [req.params.id]);
  const buyer = rows[0];
  if (!buyer) return res.status(404).render('error', { title: 'Not found', message: 'That buyer request does not exist.' });

  const [{ rows: proposals }, { rows: notifyRounds }, { rows: approvedAgents }, { rows: followups }] = await Promise.all([
    pool.query(
      `SELECT bp.*, u.name AS agent_name, u.email AS agent_email, ap.brokerage
       FROM buyer_proposals bp JOIN users u ON u.id=bp.agent_id JOIN agent_profiles ap ON ap.user_id=bp.agent_id
       WHERE bp.profile_id=$1 ORDER BY bp.created_at ASC`, [req.params.id]),
    pool.query(
      `SELECT round, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE email_sent)::int AS sent
       FROM agent_notifications
       WHERE opportunity_type='buyer' AND opportunity_id=$1 GROUP BY round ORDER BY round`, [req.params.id]),
    pool.query(`SELECT service_zip FROM agent_profiles WHERE status='approved'`),
    pool.query(
      `SELECT kind, recipient_role, due_at, sent_at, skip_reason FROM followups
       WHERE opportunity_type='buyer' AND opportunity_id=$1 ORDER BY due_at`, [req.params.id]),
  ]);

  // Live eligibility (Paul, Aug 21 — buyer detail now mirrors the seller
  // page): approved professionals currently within the radius of ANY of the
  // buyer's cities, counting only computable distances.
  let geo = buyer.search_geo;
  if (typeof geo === 'string') { try { geo = JSON.parse(geo); } catch (e) { geo = null; } }
  const geoPoints = (Array.isArray(geo) && geo.length) ? geo
    : String(buyer.search_areas).split(',').map(s => s.trim()).filter(Boolean)
        .map(c => H.utCity(c)).filter(Boolean);
  const geoKnown = geoPoints.length > 0;
  const inRange = !geoKnown ? 0 : approvedAgents.filter(a => {
    const z = mailer.zipInfo(a.service_zip);
    if (!z) return false;
    return Math.min(...geoPoints.map(g => H.geoMiles(z.latitude, z.longitude, g.lat, g.lng))) <= mailer.RADIUS_MILES;
  }).length;

  res.render('admin/buyer-detail', {
    title: 'Buyer request', buyer, proposals, notifyRounds, H,
    inRange, geoKnown, radius: mailer.RADIUS_MILES, followups,
  });
});

// ---------- professional actions ----------
router.post('/admin/agents/:id(\\d+)/:action(approve|reject|suspend|reinstate)', admin, async (req, res) => {
  const map = { approve: 'approved', reject: 'rejected', suspend: 'suspended', reinstate: 'approved' };
  const status = map[req.params.action];
  await pool.query(`UPDATE agent_profiles SET status=$1, reviewed_at=now() WHERE user_id=$2`, [status, req.params.id]);
  const eventNames = { approve: 'agent_approved', reject: 'agent_rejected', suspend: 'agent_suspended', reinstate: 'agent_reinstated' };
  logEvent(eventNames[req.params.action], { userId: parseInt(req.params.id) });
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
  const { rowCount } = await pool.query(`DELETE FROM users WHERE id=$1 AND role='agent'`, [req.params.id]);
  if (rowCount) logEvent('agent_removed', { userId: parseInt(req.params.id) });
  res.redirect('/admin');
});

// ---------- request detail ----------
router.get('/admin/requests/:id(\\d+)', admin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT r.*, u.name AS seller_name, u.email AS seller_email FROM requests r
     JOIN users u ON u.id=r.seller_id WHERE r.id=$1`, [req.params.id]);
  const request = rows[0];
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'That request does not exist.' });

  const [proposals, approvedAgents, notifyRoundsQ] = await Promise.all([
    pool.query(
      `SELECT p.*, u.name AS agent_name, ap.brokerage FROM proposals p
       JOIN users u ON u.id=p.agent_id JOIN agent_profiles ap ON ap.user_id=p.agent_id
       WHERE p.request_id=$1 ORDER BY p.created_at ASC`, [req.params.id]),
    pool.query(`SELECT service_zip FROM agent_profiles WHERE status='approved'`),
    pool.query(
      `SELECT round, COUNT(*)::int AS n, COUNT(*) FILTER (WHERE email_sent)::int AS sent
       FROM agent_notifications
       WHERE opportunity_type='seller' AND opportunity_id=$1 GROUP BY round ORDER BY round`, [req.params.id]),
  ]);
  // How many approved professionals are currently within the notification
  // radius. Counts only COMPUTABLE distances (Paul, Aug 21) — the old
  // fail-open count showed "17 within 50 mi" for a request whose ZIP wasn't
  // even in the geographic database. zipKnown drives a warning banner.
  const zipKnown = !!mailer.zipInfo(request.zip);
  const inRange = !zipKnown ? 0 : approvedAgents.rows.filter(a => {
    const d = mailer.zipDistance(request.zip, a.service_zip);
    return d !== null && d <= mailer.RADIUS_MILES;
  }).length;

  const { rows: followups } = await pool.query(
    `SELECT kind, recipient_role, due_at, sent_at, skip_reason FROM followups
     WHERE opportunity_type='seller' AND opportunity_id=$1 ORDER BY due_at`, [req.params.id]);

  res.render('admin/request-detail', {
    title: 'Request detail', request, H,
    proposals: proposals.rows, inRange, zipKnown, radius: mailer.RADIUS_MILES,
    notifyRounds: notifyRoundsQ.rows, followups,
  });
});

module.exports = router;
