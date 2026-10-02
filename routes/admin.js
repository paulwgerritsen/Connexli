// routes/admin.js — the pilot control center: approve, inspect, and manage
// professionals and homeowner requests.
const express = require('express');
const { pool, logEvent, creditSummary, insertLedger } = require('../db');
const payments = require('../payments');
const { requireRole } = require('../middleware');
const H = require('../helpers');
const mailer = require('../mailer');
const reld = require('../reld');

const router = require('../middleware').safeRouter(express.Router());
const admin = requireRole('admin');

// ---------- main dashboard ----------
router.get('/admin', admin, async (req, res) => {
  const [pending, agents, requests, metrics] = await Promise.all([
    pool.query(
      `SELECT ap.*, u.name, u.email, u.phone, u.email_verified FROM agent_profiles ap JOIN users u ON u.id=ap.user_id
       WHERE ap.status='pending' ORDER BY ap.created_at ASC`),
    // Approved (and suspended) professionals — the primary operational list.
    // Rejected registrations live in their own section (Paul, Aug 31 §13/§14)
    // so a fraudulent signup never sits next to real approved professionals.
    pool.query(
      `SELECT ap.*, u.name, u.email FROM agent_profiles ap JOIN users u ON u.id=ap.user_id
       WHERE ap.status IN ('approved','suspended') ORDER BY ap.reviewed_at DESC NULLS LAST LIMIT 50`),
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

  // Rejected professional registrations (Paul, Aug 31 §14): kept — never
  // deleted — with full history, in their own section.
  const { rows: rejected } = await pool.query(
    `SELECT ap.*, u.name, u.email, u.created_at AS registered_at
     FROM agent_profiles ap JOIN users u ON u.id=ap.user_id
     WHERE ap.status='rejected' ORDER BY ap.reviewed_at DESC NULLS LAST LIMIT 100`);

  const pay = await paymentReport();
  res.render('admin/dashboard', {
    title: 'Admin', H,
    pending: pending.rows, agents: agents.rows, rejected, requests: requests.rows, m: metrics.rows[0], buyers,
    pay, paymentsEnabled: payments.enabled(),
    reldConfigured: reld.configured(),
    VL: reld.VERIFICATION_LABELS, VB: reld.VERIFICATION_BADGE,
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

  // Seller requests by marketing source (Paul, Sep 28 /fsbo): how many seller
  // requests each landing page produced. "(direct)" = no source recorded.
  const { rows: sourceStats } = await pool.query(`
    WITH src AS (
      SELECT COALESCE(signup_source, '(direct)') AS s FROM users WHERE role='seller'
      UNION SELECT COALESCE(source, '(direct)') FROM requests)
    SELECT src.s AS source,
      (SELECT COUNT(*) FROM users u WHERE u.role='seller' AND COALESCE(u.signup_source, '(direct)') = src.s)::int AS accounts,
      (SELECT COUNT(*) FROM requests r WHERE COALESCE(r.source, '(direct)') = src.s)::int AS requests,
      (SELECT COUNT(*) FROM requests r WHERE COALESCE(r.source, '(direct)') = src.s AND r.created_at > now() - interval '30 days')::int AS last_30,
      (SELECT COUNT(*) FROM requests r WHERE COALESCE(r.source, '(direct)') = src.s AND r.status='connected')::int AS connected
    FROM src ORDER BY requests DESC, accounts DESC`);

  // Connection feedback rollup (Paul, Aug 25): structured survey responses
  // by role — connect rate, agreement rate, average ratings, recommend score.
  const { rows: feedbackStats } = await pool.query(`
    SELECT respondent_role,
      COUNT(*)::int AS responses,
      COUNT(*) FILTER (WHERE q_connected='Yes')::int AS connected_yes,
      COUNT(*) FILTER (WHERE q_agreement='Yes')::int AS agreement_yes,
      COUNT(*) FILTER (WHERE q_agreement IS NOT NULL)::int AS agreement_answered,
      ROUND(AVG(rating_counterpart), 2)::float AS avg_counterpart,
      ROUND(AVG(rating_connexli), 2)::float AS avg_connexli,
      ROUND(AVG(rating_recommend), 2)::float AS avg_recommend
    FROM connection_feedback GROUP BY respondent_role`);
  const fb = { client: null, professional: null };
  for (const r of feedbackStats) fb[r.respondent_role] = r;

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
    title: 'Analytics', H, sourceStats,
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
    fb,
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

// ---------- connection feedback responses (Paul, Aug 25) ----------
router.get('/admin/feedback', admin, async (req, res) => {
  const { rows: responses } = await pool.query(
    `SELECT cf.*, ru.name AS respondent_name, au.name AS agent_name
     FROM connection_feedback cf
     JOIN users ru ON ru.id = cf.respondent_id
     LEFT JOIN users au ON au.id = cf.counterpart_agent_id
     ORDER BY cf.created_at DESC LIMIT 500`);
  res.render('admin/feedback', { title: 'Connection feedback', responses, H });
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
    `SELECT ap.*, u.name, u.email, u.phone, u.created_at AS registered_at, u.email_verified
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

  // Proposal credits + ledger (Paul, Aug 29): the balance the professional
  // sees, plus the raw ledger entries and an adjustment form for support.
  const [credits, ledgerQ, ordersQ] = await Promise.all([
    creditSummary(req.params.id),
    pool.query(`SELECT * FROM credit_ledger WHERE agent_id=$1 ORDER BY created_at DESC, id DESC LIMIT 200`, [req.params.id]),
    pool.query(`SELECT * FROM credit_orders WHERE agent_id=$1 AND status <> 'pending' ORDER BY created_at DESC LIMIT 200`, [req.params.id]),
  ]);

  res.render('admin/agent-detail', {
    title: agent.name, agent, H,
    proposals: proposals.rows,
    buyerProposals: buyerProps.rows,
    stats: {
      opportunities, submitted, wins,
      buyerOpportunities, buyerSubmitted, buyerWins,
      successRate: submitted ? Math.round(100 * wins / submitted) + '%' : 'n/a',
    },
    credits, ledger: ledgerQ.rows, orders: ordersQ.rows, ledgerType: payments.ledgerType, pkgLabel: payments.pkgLabel,
    reldConfigured: reld.configured(),
    VL: reld.VERIFICATION_LABELS, VB: reld.VERIFICATION_BADGE,
    // Repeat-click guard: the Recheck button disables when a check ran in the
    // last 60 seconds, so an accidental double-click can't burn two lookups.
    recentCheck: agent.reld_checked_at && (Date.now() - new Date(agent.reld_checked_at).getTime() < 60000),
    creditMsg: req.query.credit === 'saved' ? 'Credit adjustment recorded.' : (req.query.credit === 'error' ? 'Adjustment not saved — enter a whole-number amount (not zero) and a reason.' : null),
    licenseEdits: (await pool.query(
      `SELECT meta, created_at FROM events WHERE event_type='admin_license_edited' AND user_id=$1 ORDER BY created_at DESC LIMIT 10`, [req.params.id])).rows,
    overrideMsg: { done: 'Approved by administrator override — recorded with your name and reason. The professional has been emailed.',
      reason: 'Not approved — please enter a reason of at least 10 characters (for example where you confirmed the license).' }[req.query.override] || null,
    licenseMsg: { saved: 'License number saved. Nothing has been verified yet — click Recheck license to check it with RELD.',
      reopened: 'License number saved and the account was reopened to Pending. Nothing has been verified yet — click Recheck license to check it with RELD.',
      invalid: 'License number not saved — use letters, numbers, spaces, dots, dashes or slashes only (2–40 characters).',
      same: 'That is already the license on file — nothing changed.' }[req.query.license] || null,
    recheckMsg: req.query.recheck === 'approved' ? 'License verified by RELD — the account met the normal approval rules and was approved automatically. The professional has been emailed.'
      : req.query.recheck === 'done' ? 'License recheck complete — the result below is current.'
      : (req.query.recheck === 'skipped' ? 'A check ran less than a minute ago — result below is already current, no second lookup was spent.'
      : (req.query.recheck === 'unconfigured' ? 'RELD is not configured yet (RELD_API_KEY is not set), so no lookup was made.' : null)),
    reviewMsg: req.query.review === 'resolved' ? 'Identity confirmed — the review flag is cleared and this professional now shows as Verified.' : null,
  });
});

// ---------- RELD verification actions (Paul, Aug 29) ----------
// Recheck one professional. Deliberate admin action — one API lookup.
router.post('/admin/agents/:id(\\d+)/recheck', admin, async (req, res) => {
  if (!reld.configured()) return res.redirect('/admin/agents/' + req.params.id + '?recheck=unconfigured');
  const { rows } = await pool.query(`SELECT reld_checked_at FROM agent_profiles WHERE user_id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).render('error', { title: 'Not found', message: 'That professional does not exist.' });
  // Guard against accidental repeat clicks: at most one lookup per minute.
  if (rows[0].reld_checked_at && Date.now() - new Date(rows[0].reld_checked_at).getTime() < 60000) {
    return res.redirect('/admin/agents/' + req.params.id + '?recheck=skipped');
  }
  // Deliberate admin action: always a fresh API lookup (no cache). Since
  // Oct 1 (Paul): if the account is still PENDING and the license now
  // verifies, it is approved through the normal automatic process (same
  // rules as signup). A recheck NEVER rejects anyone, and it never changes
  // an account that is already approved, suspended or rejected.
  const before = await pool.query(`SELECT status FROM agent_profiles WHERE user_id=$1`, [req.params.id]);
  const status = await reld.verifyProfessional(parseInt(req.params.id, 10), { useCache: false, autoDecide: 'approve-only' });
  const after = await pool.query(`SELECT status FROM agent_profiles WHERE user_id=$1`, [req.params.id]);
  const approvedNow = before.rows[0].status === 'pending' && after.rows[0].status === 'approved';
  logEvent('reld_recheck', { userId: parseInt(req.params.id, 10), meta: { result: status, by: req.session.user.email, auto_approved: approvedNow } });
  res.redirect('/admin/agents/' + req.params.id + '?recheck=' + (approvedNow ? 'approved' : 'done'));
});

// ---------- approve anyway (Paul, Oct 2) ----------
// Admin override for the rare case where RELD can't find a license that the
// administrator has confirmed another way (e.g. the state's own lookup).
// Only offered when normal Approve is hidden for a license reason. A written
// reason is REQUIRED and is stored with who/when. The license check is shown
// as Needs Review (never "Verified" — RELD did not verify it), which does
// not block proposals, and a later RELD not-found will not undo the override.
router.post('/admin/agents/:id(\\d+)/approve-override', admin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ap.status, ap.verification_status, ap.reld_not_found, ap.license_recheck_needed, u.email, u.name
     FROM agent_profiles ap JOIN users u ON u.id=ap.user_id WHERE ap.user_id=$1`, [req.params.id]);
  const p = rows[0];
  if (!p) return res.status(404).render('error', { title: 'Not found', message: 'That professional does not exist.' });
  const blocked = p.verification_status === 'failed' || (p.verification_status === 'needs_review' && p.reld_not_found)
    || (p.license_recheck_needed && p.verification_status === 'needs_verification');
  if (!blocked || !['pending', 'rejected'].includes(p.status)) return res.redirect('/admin/agents/' + req.params.id);
  const reason = H.clean(req.body.reason, 300);
  if (reason.length < 10) return res.redirect('/admin/agents/' + req.params.id + '?override=reason');
  await pool.query(
    `UPDATE agent_profiles SET status='approved', reviewed_at=now(), reviewed_by=$1, rejection_reason=NULL,
       verification_status='needs_review', license_recheck_needed=false,
       license_override_at=now(), license_override_by=$2, license_override_reason=$3
     WHERE user_id=$4`, [req.session.user.email + ' (manual override)', req.session.user.email, reason, req.params.id]);
  logEvent('agent_approved_override', { userId: parseInt(req.params.id, 10), meta: { by: req.session.user.email, reason, was: p.status + '/' + p.verification_status } });
  mailer.agentApproved(p.email, p.name); // fire and forget
  res.redirect('/admin/agents/' + req.params.id + '?override=done');
});

// ---------- edit license number (Paul, Oct 1) ----------
// Admin-only. Fixes a formatting error in the submitted license — e.g.
// 13529880 → 13529880-SA00 — WITHOUT verifying anything: the license check
// resets to "Not yet checked" and the admin then clicks Recheck license, so
// RELD (not a person) decides. A rejected account is reopened to Pending so
// a legitimate professional doesn't have to register again. Every edit is
// recorded (who, old → new) in the event log.
router.post('/admin/agents/:id(\\d+)/license', admin, async (req, res) => {
  const { rows } = await pool.query(`SELECT license_state, license_number, status FROM agent_profiles WHERE user_id=$1`, [req.params.id]);
  const p = rows[0];
  if (!p) return res.status(404).render('error', { title: 'Not found', message: 'That professional does not exist.' });
  const license_state = H.LICENSE_STATE_CODES.includes(req.body.license_state) ? req.body.license_state : (p.license_state || 'UT');
  const license_number = H.clean(req.body.license_number, 40);
  if (!/^[A-Za-z0-9][A-Za-z0-9 .\-\/]{1,39}$/.test(license_number)) {
    return res.redirect('/admin/agents/' + req.params.id + '?license=invalid');
  }
  if (license_number === p.license_number && license_state === (p.license_state || 'UT')) {
    return res.redirect('/admin/agents/' + req.params.id + '?license=same');
  }
  const reopen = p.status === 'rejected';
  await pool.query(
    `UPDATE agent_profiles SET license_state=$1, license_number=$2,
       verification_status='needs_verification', reld_verified=false, reld_not_found=false, reld_error=NULL, reld_checked_at=NULL,
       license_recheck_needed=true,
       reld_name=NULL, reld_license_type=NULL, reld_license_status=NULL, reld_expiration=NULL, reld_brokerage=NULL,
       reld_city=NULL, reld_record_id=NULL, reld_last_verified=NULL, name_mismatch=false, brokerage_mismatch=false,
       status = CASE WHEN status='rejected' THEN 'pending' ELSE status END,
       rejection_reason = CASE WHEN status='rejected' THEN NULL ELSE rejection_reason END,
       reviewed_by = CASE WHEN status='rejected' THEN NULL ELSE reviewed_by END,
       reviewed_at = CASE WHEN status='rejected' THEN NULL ELSE reviewed_at END
     WHERE user_id=$3`, [license_state, license_number, req.params.id]);
  logEvent('admin_license_edited', { userId: parseInt(req.params.id, 10),
    meta: { by: req.session.user.email, from: (p.license_state || 'UT') + '/' + p.license_number, to: license_state + '/' + license_number, reopened: reopen } });
  res.redirect('/admin/agents/' + req.params.id + '?license=' + (reopen ? 'reopened' : 'saved'));
});

// ---------- confirm identity / clear review (Paul, Sep 1 — PDF 2) ----------
// When the admin confirms the professional IS the person on the license
// (e.g. preferred name "Pablo Gerri" vs registry "PAUL GERRITSEN"), this
// clears the Needs Review flag: verification becomes Verified, the confirmed
// registry name/brokerage are remembered so future rechecks don't re-flag,
// and who/when/why is recorded. The original mismatch flags stay in the
// record — the audit trail is preserved, only the active warning clears.
router.post('/admin/agents/:id(\\d+)/resolve-review', admin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT verification_status, reld_name, reld_brokerage FROM agent_profiles WHERE user_id=$1`, [req.params.id]);
  const p = rows[0];
  if (!p) return res.status(404).render('error', { title: 'Not found', message: 'That professional does not exist.' });
  if (p.verification_status !== 'needs_review' || !p.reld_name) {
    return res.redirect('/admin/agents/' + req.params.id);
  }
  const reason = H.clean(req.body.reason, 300) || 'Confirmed preferred-name / brokerage difference — same person as the licensed individual';
  await pool.query(
    `UPDATE agent_profiles SET verification_status='verified', reld_verified=true,
       reld_first_verified_at = COALESCE(reld_first_verified_at, now()),
       confirmed_reld_name=reld_name, confirmed_reld_brokerage=reld_brokerage,
       review_resolved_at=now(), review_resolved_by=$1, review_resolution=$2
     WHERE user_id=$3`,
    [req.session.user.email, reason, req.params.id]);
  logEvent('review_resolved', { userId: parseInt(req.params.id, 10), meta: { by: req.session.user.email, reason } });
  res.redirect('/admin/agents/' + req.params.id + '?review=resolved');
});

// Batch audit of every professional with a license on file (Paul, Sep 25 §3).
// Triggered only by this explicit admin action — never on a schedule, never
// on page load. reld.batchVerify() chunks to RELD's documented maximum,
// isolates any record RELD rejects, and reports one of four outcomes per
// professional. An outage or API error NEVER downgrades a verified status.
router.post('/admin/reld-audit', admin, async (req, res) => {
  if (!reld.configured()) {
    return res.status(400).render('error', { title: 'RELD not configured', message: 'Set RELD_API_KEY (and RELD_API_BASE_URL if needed) in Render before running the audit.' });
  }
  const { rows: pros } = await pool.query(
    `SELECT ap.user_id, ap.license_state, ap.license_number, ap.brokerage, ap.verification_status,
            ap.confirmed_reld_name, ap.confirmed_reld_brokerage, u.name, u.email
     FROM agent_profiles ap JOIN users u ON u.id=ap.user_id
     WHERE COALESCE(ap.license_number,'') <> '' ORDER BY ap.license_state, ap.user_id`);
  const view = (extra) => res.render('admin/reld-results', { title: 'RELD audit', H, mode: 'audit', error: null, rows: [], raw: null, parsed: null, summary: null, VL: reld.VERIFICATION_LABELS, VB: reld.VERIFICATION_BADGE, ...extra });
  if (!pros.length) return view({ error: 'No professionals with a license number on file.' });

  const batch = await reld.batchVerify(pros.map(p => ({ state: p.license_state || 'UT', license_number: p.license_number })));
  const outcomes = [];
  const summary = { verified: 0, failed: 0, api_error: 0, skipped: 0, needs_review: 0, calls: batch.calls, batchSize: batch.batchSize, total: pros.length };
  for (let i = 0; i < pros.length; i++) {
    const p = pros[i]; const r = batch.results[i];
    let after, category, note = '';
    if (r.skipped) {
      after = p.verification_status; category = 'skipped'; note = 'Not sent — ' + r.reason; summary.skipped++;
    } else {
      after = await reld.applyResult(p.user_id, p.name, p.brokerage, r, p.verification_status, { name: p.confirmed_reld_name, brokerage: p.confirmed_reld_brokerage });
      if (r.unavailable) { category = 'api_error'; note = r.error; summary.api_error++; }
      else if (after === 'verified') { category = 'verified'; summary.verified++; }
      else if (after === 'needs_review') { category = 'needs_review'; note = r.found === false ? 'Utah license number not found — check for a missing suffix (manual review)' : 'Registry record found; name or brokerage differs'; summary.needs_review++; }
      else { category = 'failed'; note = after === 'expired' ? 'License found but not active' : 'License not found for this state and number'; summary.failed++; }
    }
    outcomes.push({ user_id: p.user_id, name: p.name, email: p.email, license: (p.license_state || 'UT') + ' ' + p.license_number, before: p.verification_status, after, category, note });
  }
  logEvent('reld_audit', { userId: req.session.user.id, meta: { ...summary } });
  console.log(`[reld] audit complete — Verified: ${summary.verified} | Failed verification: ${summary.failed} | API errors: ${summary.api_error} | Skipped: ${summary.skipped} | Needs review: ${summary.needs_review} (${summary.calls} batch call${summary.calls === 1 ? '' : 's'})`);
  view({ rows: outcomes, summary });
});

// ---------- test-account cleanup (Paul, Sep 25 §2) ----------
// Lists professional accounts that have NEVER passed RELD verification —
// reld_first_verified_at is NULL, they are not currently verified, and no
// administrator has confirmed their identity. A later outage, failed recheck,
// or expired license can never make a once-verified professional eligible.
async function neverVerifiedProfessionals() {
  const { rows } = await pool.query(
    `SELECT ap.user_id, ap.license_state, ap.license_number, ap.brokerage, ap.status, ap.verification_status,
            ap.reld_error, u.name, u.email, u.created_at AS registered_at,
            (SELECT COUNT(*) FROM proposals p WHERE p.agent_id=ap.user_id)::int
              + (SELECT COUNT(*) FROM buyer_proposals bp WHERE bp.agent_id=ap.user_id)::int AS proposals,
            (SELECT COUNT(*) FROM credit_orders o WHERE o.agent_id=ap.user_id AND o.status IN ('paid','refunded','partially_refunded'))::int AS purchases
     FROM agent_profiles ap JOIN users u ON u.id=ap.user_id
     WHERE u.role='agent'
       AND ap.reld_first_verified_at IS NULL
       AND ap.reld_verified = false
       AND ap.verification_status <> 'verified'
       AND ap.confirmed_reld_name IS NULL
     ORDER BY u.created_at ASC`);
  return rows;
}

router.get('/admin/reld-cleanup', admin, async (req, res) => {
  const rows = await neverVerifiedProfessionals();
  res.render('admin/reld-cleanup', { title: 'Remove never-verified professionals', H, rows,
    VL: reld.VERIFICATION_LABELS, VB: reld.VERIFICATION_BADGE, done: req.query.done ? parseInt(req.query.done, 10) : null });
});

// Two confirmations: the checkbox list + count on the page, then the typed
// word DELETE. Only ids that are STILL eligible at execution time are removed
// (a professional verified between preview and confirm is protected).
router.post('/admin/reld-cleanup', admin, async (req, res) => {
  const eligible = await neverVerifiedProfessionals();
  const eligibleIds = new Set(eligible.map(r => r.user_id));
  let ids = req.body.ids || [];
  if (!Array.isArray(ids)) ids = [ids];
  ids = ids.map(x => parseInt(x, 10)).filter(x => eligibleIds.has(x));
  if (req.body.confirm !== 'DELETE' || !ids.length) {
    return res.status(400).render('admin/reld-cleanup', { title: 'Remove never-verified professionals', H, rows: eligible,
      VL: reld.VERIFICATION_LABELS, VB: reld.VERIFICATION_BADGE, done: null,
      error: !ids.length ? 'No eligible accounts were selected.' : 'Type DELETE (in capitals) to confirm.' });
  }
  const removed = eligible.filter(r => ids.includes(r.user_id));
  const { rowCount } = await pool.query(
    `DELETE FROM users u USING agent_profiles ap
     WHERE u.id = ap.user_id AND u.role='agent' AND u.id = ANY($1::int[])
       AND ap.reld_first_verified_at IS NULL AND ap.reld_verified = false
       AND ap.verification_status <> 'verified' AND ap.confirmed_reld_name IS NULL`, [ids]);
  logEvent('reld_cleanup', { userId: req.session.user.id, meta: { deleted: rowCount, accounts: removed.map(r => ({ id: r.user_id, email: r.email, license: (r.license_state || 'UT') + '/' + r.license_number })) } });
  console.log(`[admin] RELD cleanup by ${req.session.user.email}: deleted ${rowCount} never-verified professional account(s)`);
  res.redirect('/admin/reld-cleanup?done=' + rowCount);
});

// Connection test: one lookup, raw response shown, nothing stored. Lets Paul
// confirm the field mapping on the very first live call without touching any
// professional's record.
router.post('/admin/reld-test', admin, async (req, res) => {
  if (!reld.configured()) {
    return res.status(400).render('error', { title: 'RELD not configured', message: 'Set RELD_API_KEY (and RELD_API_BASE_URL if needed) in Render first.' });
  }
  const state = (H.clean(req.body.state, 2) || 'UT').toUpperCase();
  const number = H.clean(req.body.license_number, 40);
  if (!number) return res.status(400).render('error', { title: 'License number required', message: 'Enter a license number to test against RELD.' });
  const result = await reld.verifyLicense(state, number);
  logEvent('reld_test', { userId: req.session.user.id, meta: { state, number } });
  res.render('admin/reld-results', { title: 'RELD connection test', H, mode: 'test', error: result.unavailable ? result.error : null, rows: [], raw: JSON.stringify(result.raw || result, null, 2), parsed: result, VL: reld.VERIFICATION_LABELS, VB: reld.VERIFICATION_BADGE });
});

// ---------- proposal credit adjustment (Paul, Aug 29 §16) ----------
// Adds or removes PURCHASED credits with an explicit amount and reason.
// Every adjustment is a ledger entry — nothing is ever silently overwritten.
router.post('/admin/agents/:id(\\d+)/credits', admin, async (req, res) => {
  const amount = parseInt(req.body.amount, 10);
  const reason = H.clean(req.body.reason, 300);
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000 || !reason) {
    return res.redirect('/admin/agents/' + req.params.id + '?credit=error');
  }
  const { rows } = await pool.query(`SELECT user_id FROM agent_profiles WHERE user_id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).render('error', { title: 'Not found', message: 'That professional does not exist.' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertLedger(client, parseInt(req.params.id, 10), { entry_type: 'admin_adjustment', funding_source: 'purchased', amount,
      reason: reason + ' (by ' + req.session.user.email + ')' });
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  logEvent('credit_adjustment', { userId: parseInt(req.params.id, 10), meta: { amount, reason } });
  res.redirect('/admin/agents/' + req.params.id + '?credit=saved');
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
    rounds: await require('../rounds').roundHistory('buyer', buyer),
    inRange, geoKnown, radius: mailer.RADIUS_MILES, followups,
  });
});

// ---------- professional actions ----------
router.post('/admin/agents/:id(\\d+)/:action(approve|reject|suspend|reinstate)', admin, async (req, res) => {
  const map = { approve: 'approved', reject: 'rejected', suspend: 'suspended', reinstate: 'approved' };
  const status = map[req.params.action];
  // Optional rejection reason (Paul, Aug 31 §14) — captured from the detail
  // page's reject form and shown in the Rejected professionals section.
  // Preserved on the record even after a reinstate, for history.
  if (req.params.action === 'reject' && H.clean(req.body.reason, 300)) {
    await pool.query(`UPDATE agent_profiles SET rejection_reason=$1 WHERE user_id=$2`, [H.clean(req.body.reason, 300), req.params.id]);
  }
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

// ---------- payments & revenue (Paul, Sep 25 §7/§10) ----------
// One query feeds the dashboard section, the report page, and the CSV so the
// numbers can never disagree. Gross = amount paid; refunds = amount refunded;
// net = gross − refunds − Stripe fee (fee only when Stripe reported it).
const PAYMENT_ROWS_SQL = `
  SELECT o.*, u.name, u.email, ap.service_state, ap.service_zip, ap.license_state AS current_license_state,
         (o.amount_cents - o.refunded_cents - COALESCE(o.fee_cents, 0)) AS net_after_fee_cents
  FROM credit_orders o JOIN users u ON u.id=o.agent_id LEFT JOIN agent_profiles ap ON ap.user_id=o.agent_id
  WHERE o.status IN ('paid','refunded','partially_refunded')`;

async function paymentReport() {
  const [rows, totals, byState, byMonth, flagged] = await Promise.all([
    pool.query(PAYMENT_ROWS_SQL + ` ORDER BY o.paid_at DESC NULLS LAST, o.id DESC LIMIT 200`),
    pool.query(`SELECT COUNT(*)::int AS purchases, COALESCE(SUM(amount_cents),0)::bigint AS gross, COALESCE(SUM(refunded_cents),0)::bigint AS refunds,
                       COALESCE(SUM(fee_cents),0)::bigint AS fees, COALESCE(SUM(credits),0)::int AS credits,
                       COALESCE(SUM(amount_cents - refunded_cents - COALESCE(fee_cents,0)),0)::bigint AS net,
                       COALESCE(SUM(amount_cents) FILTER (WHERE paid_at >= date_trunc('month', now() AT TIME ZONE 'America/Denver') AT TIME ZONE 'America/Denver'),0)::bigint AS gross_this_month
                FROM credit_orders WHERE status IN ('paid','refunded','partially_refunded')`),
    pool.query(`SELECT COALESCE(billing_state, '(no billing state)') AS state, COUNT(*)::int AS purchases, SUM(credits)::int AS credits,
                       SUM(amount_cents)::bigint AS gross, SUM(refunded_cents)::bigint AS refunds, SUM(amount_cents - refunded_cents - COALESCE(fee_cents,0))::bigint AS net
                FROM credit_orders WHERE status IN ('paid','refunded','partially_refunded') GROUP BY 1 ORDER BY gross DESC`),
    pool.query(`SELECT to_char(paid_at AT TIME ZONE 'America/Denver', 'YYYY-MM') AS month, COUNT(*)::int AS purchases, SUM(credits)::int AS credits,
                       SUM(amount_cents)::bigint AS gross, SUM(refunded_cents)::bigint AS refunds, SUM(amount_cents - refunded_cents - COALESCE(fee_cents,0))::bigint AS net
                FROM credit_orders WHERE status IN ('paid','refunded','partially_refunded') GROUP BY 1 ORDER BY 1 DESC`),
    pool.query(`SELECT o.id, o.review_flag, o.review_note, u.name, u.email FROM credit_orders o JOIN users u ON u.id=o.agent_id WHERE o.review_flag IS NOT NULL ORDER BY o.id DESC`),
  ]);
  return { orders: rows.rows, totals: totals.rows[0], byState: byState.rows, byMonth: byMonth.rows, flagged: flagged.rows };
}

router.get('/admin/payments', admin, async (req, res) => {
  const report = await paymentReport();
  res.render('admin/payments', { title: 'Payments & revenue', H, ...report, paymentsEnabled: payments.enabled(), pkgLabel: payments.pkgLabel,
    providerName: payments.enabled() ? payments.provider().name : null, testMode: /^sk_test_/.test(process.env.STRIPE_SECRET_KEY || ''),
    cleared: req.query.cleared === '1' });
});

// Full transaction export for accounting and tax work (§10) — every paid,
// refunded, or partially refunded order, one row each, with both the billing
// geography and the professional's service/license state at purchase time.
router.get('/admin/payments.csv', admin, async (req, res) => {
  const { rows } = await pool.query(PAYMENT_ROWS_SQL + ` ORDER BY o.paid_at ASC NULLS LAST, o.id ASC`);
  const cols = ['order_id', 'paid_at_mountain', 'professional', 'email', 'service_state', 'service_zip', 'license_state_at_purchase', 'billing_state', 'billing_postal_code', 'billing_country', 'billing_city',
    'package', 'credits', 'gross_usd', 'tax_usd', 'stripe_fee_usd', 'refunded_usd', 'net_usd', 'status', 'refund_status', 'review_flag', 'provider', 'stripe_payment_intent', 'stripe_charge', 'stripe_session'];
  const q = (v) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const usd = (c) => c == null ? '' : (c / 100).toFixed(2);
  const lines = [cols.join(',')];
  for (const o of rows) {
    lines.push([o.id, o.paid_at ? new Date(o.paid_at).toLocaleString('en-US', { timeZone: 'America/Denver' }) : '', o.name, o.email, o.service_state, o.service_zip, o.license_state,
      o.billing_state, o.billing_postal_code, o.billing_country, o.billing_city, o.package_key, o.credits, usd(o.amount_cents), usd(o.tax_cents), usd(o.fee_cents), usd(o.refunded_cents),
      usd(o.net_after_fee_cents), o.status, o.refund_status, o.review_flag, o.provider, o.stripe_payment_intent, o.stripe_charge_id, o.provider_session_id].map(q).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="connexli-payments-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

// Clear a refund review flag once an administrator has dealt with it.
router.post('/admin/payments/:id(\\d+)/clear-flag', admin, async (req, res) => {
  await pool.query(`UPDATE credit_orders SET review_flag=NULL, review_note=COALESCE(review_note,'') || ' [reviewed by ' || $2 || ']' WHERE id=$1`, [req.params.id, req.session.user.email]);
  logEvent('payment_flag_cleared', { userId: req.session.user.id, meta: { order_id: parseInt(req.params.id, 10) } });
  res.redirect('/admin/payments?cleared=1');
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
    rounds: await require('../rounds').roundHistory('seller', request),
    proposals: proposals.rows, inRange, zipKnown, radius: mailer.RADIUS_MILES,
    notifyRounds: notifyRoundsQ.rows, followups,
  });
});

module.exports = router;
