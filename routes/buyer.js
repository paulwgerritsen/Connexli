// routes/buyer.js — "Find Your Buyer's Agent."
// A homeowner/buyer account (role 'seller') can hold ONE active buyer
// profile. Readiness is computed, never judged: Ready Now and Preparing
// profiles publish to agents; Exploring profiles get the Get Ready track.
const express = require('express');
const { pool, logEvent } = require('../db');
const { requireRole } = require('../middleware');
const H = require('../helpers');
const mailer = require('../mailer');

const router = require('../middleware').safeRouter(express.Router());
const consumer = requireRole('seller'); // homeowner/buyer accounts share one role

async function activeProfile(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM buyer_profiles WHERE user_id=$1 AND status IN ('active','connected')
     ORDER BY created_at DESC LIMIT 1`, [userId]);
  return rows[0] || null;
}

// ---------- my buyer profile (hub page) ----------
// Mirrors the seller flow: while the window is open the buyer sees only the
// sealed count + countdown; proposals reveal together when the window closes.
router.get('/buyer', consumer, async (req, res) => {
  const profile = await activeProfile(req.session.user.id);
  if (!profile) return res.render('buyer/start', { title: "Find Your Buyer's Agent", H });

  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM buyer_proposals WHERE profile_id=$1`, [profile.id]);
  profile.proposal_count = cnt[0].n;
  const open = profile.status === 'active' && profile.published && H.windowOpen(profile);

  let proposals = [];
  if (!open) {
    ({ rows: proposals } = await pool.query(
      `SELECT bp.*, u.name AS agent_name, u.email AS agent_email, u.phone AS agent_phone,
              ap.brokerage, ap.license_number, ap.transactions_seller_12mo, ap.transactions_buyer_12mo
       FROM buyer_proposals bp
       JOIN users u ON u.id = bp.agent_id
       JOIN agent_profiles ap ON ap.user_id = bp.agent_id
       WHERE bp.profile_id=$1 ORDER BY bp.created_at ASC`, [profile.id]));
  }
  res.render('buyer/profile', { title: 'My buyer profile', profile, proposals, windowIsOpen: open, H });
});

// ---------- create (Step 1: the ~2-minute core) ----------
router.get('/buyer/new', consumer, async (req, res) => {
  if (await activeProfile(req.session.user.id)) return res.redirect('/buyer');
  res.render('buyer/new', { title: "Find Your Buyer's Agent", H, error: null, form: {} });
});

router.post('/buyer/new', consumer, async (req, res) => {
  if (await activeProfile(req.session.user.id)) return res.redirect('/buyer');

  const f = {
    financing_type: H.oneOf(req.body.financing_type, H.B_FINANCING, null),
    lender_status: H.oneOf(req.body.lender_status, H.B_LENDER, null),
    down_payment: H.oneOf(req.body.down_payment, H.B_DOWN, null),
    current_situation: H.oneOf(req.body.current_situation, H.B_SITUATION, 'Rent'),
    need_to_sell: H.oneOf(req.body.need_to_sell, H.B_SELL_FIRST, 'No'),
    search_areas: H.clean(req.body.search_areas, 200),
    price_range: Object.keys(H.PRICE_RANGES).includes(req.body.price_range) ? req.body.price_range : null,
    timeline: H.oneOf(req.body.timeline, H.B_TIMELINE, null),
    in_utah: req.body.in_utah !== 'no',
    origin_state: H.oneOf(req.body.origin_state, H.US_STATES, ''), // dropdown: standardized state names only
    move_reason: H.clean(req.body.move_reason, 120),
    visit_dates: H.clean(req.body.visit_dates, 80),
    video_tours: req.body.video_tours === 'yes',
    purchase_purpose: H.oneOf(req.body.purchase_purpose, H.B_PURPOSE, 'Primary residence'),
    bba: H.oneOf(req.body.bba, H.B_BBA, 'No'),
    bba_expires: H.clean(req.body.bba_expires, 40),
    window_hours: [24, 48, 72, 168].includes(parseInt(req.body.window_hours)) ? parseInt(req.body.window_hours) : 48,
  };
  const fail = (msg) => res.status(400).render('buyer/new', { title: "Find Your Buyer's Agent", H, error: msg, form: { ...f, in_utah: f.in_utah ? 'yes' : 'no', video_tours: f.video_tours ? 'yes' : 'no' } });

  if (!f.financing_type || !f.lender_status || !f.down_payment || !f.timeline || !f.price_range) {
    return fail('Please answer the financing, lender, down payment, timeline, and price range questions.');
  }
  if (!f.search_areas) return fail('Please list at least one city or area you want to search in.');
  if (!f.in_utah && !f.origin_state) return fail("Please tell us which state you're moving from.");

  // Buyer Broker Agreement screening: an active exclusive agreement blocks a
  // new profile (protects agents from procuring-cause disputes).
  if (f.bba === 'Yes — currently active') {
    logEvent('buyer_blocked_bba', { userId: req.session.user.id });
    return res.render('buyer/bba-blocked', { title: 'One thing first', H, bba_expires: f.bba_expires });
  }

  const badge = H.readiness(f);
  const published = badge !== 'exploring';
  const { rows } = await pool.query(
    `INSERT INTO buyer_profiles (user_id, readiness, published, financing_type, lender_status, down_payment,
       current_situation, need_to_sell, search_areas, price_range, timeline, in_utah, origin_state,
       move_reason, visit_dates, video_tours, purchase_purpose, bba, bba_expires,
       window_hours, closes_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
       $20, now() + make_interval(hours => $20)) RETURNING *`,
    [req.session.user.id, badge, published, f.financing_type, f.lender_status, f.down_payment,
     f.current_situation, f.need_to_sell, f.search_areas, f.price_range, f.timeline, f.in_utah,
     f.origin_state, f.move_reason, f.visit_dates, f.video_tours, f.purchase_purpose, f.bba, f.bba_expires,
     f.window_hours]
  );
  const profile = rows[0];

  logEvent('buyer_profile_created', { userId: req.session.user.id, meta: { readiness: badge, published, in_utah: f.in_utah, price_range: f.price_range } });
  if (f.lender_status === "No — I'd like a recommendation") {
    logEvent('lender_recommendation_requested', { userId: req.session.user.id }); // the Phase-2 demand counter
  }
  if (published) {
    logEvent('buyer_profile_published', { userId: req.session.user.id, meta: { readiness: badge } });
    mailer.agentsNewBuyerProfile(profile, H.READINESS_LABELS[badge]); // fire and forget
    mailer.buyerProfileLive(req.session.user.email, req.session.user.name, profile); // instant confirmation
  }

  // Published buyers land back on the dashboard, where their new buying
  // request is immediately visible (Paul, Aug 10). Exploring buyers still get
  // the Get Ready guidance page.
  if (published) return res.redirect('/dashboard?buyerlive=1');
  const crossSell = f.need_to_sell.startsWith('Yes');
  res.render('buyer/created', { title: "Let's get you ready", H, profile, published, badge, crossSell });
});

// ---------- Step 2: optional profile booster ----------
router.get('/buyer/boost', consumer, async (req, res) => {
  const profile = await activeProfile(req.session.user.id);
  if (!profile) return res.redirect('/buyer/new');
  res.render('buyer/boost', { title: 'Boost your profile', H, profile, error: null });
});

router.post('/buyer/boost', consumer, async (req, res) => {
  const profile = await activeProfile(req.session.user.id);
  if (!profile) return res.redirect('/buyer/new');

  let priorities = req.body.priorities || [];
  if (!Array.isArray(priorities)) priorities = [priorities];
  priorities = priorities.filter(p => H.B_PRIORITIES.includes(p)).slice(0, 3);

  await pool.query(
    `UPDATE buyer_profiles SET property_prefs=$1, priorities=$2, availability=$3, first_time=$4, notes=$5 WHERE id=$6`,
    [H.clean(req.body.property_prefs, 400), priorities.join(' + '), H.clean(req.body.availability, 120),
     req.body.first_time === 'yes', H.clean(req.body.notes, 500), profile.id]
  );
  logEvent('buyer_profile_boosted', { userId: req.session.user.id });
  res.redirect('/buyer');
});

// ---------- the Get Ready track ----------
router.get('/buyer/get-ready', consumer, async (req, res) => {
  logEvent('buyer_get_ready_viewed', { userId: req.session.user.id });
  res.render('buyer/get-ready', { title: 'Get ready to buy', H });
});

// "I'm preapproved now" — upgrade an Exploring profile and publish it.
router.post('/buyer/upgrade', consumer, async (req, res) => {
  const profile = await activeProfile(req.session.user.id);
  if (!profile) return res.redirect('/buyer/new');
  const updated = { ...profile, lender_status: 'Yes — preapproved' };
  const badge = H.readiness(updated);
  const published = badge !== 'exploring';
  // Publishing starts the proposal window fresh from this moment.
  await pool.query(`UPDATE buyer_profiles SET lender_status='Yes — preapproved', readiness=$1, published=$2,
      closes_at = CASE WHEN $2 AND NOT published THEN now() + make_interval(hours => window_hours) ELSE closes_at END
    WHERE id=$3`,
    [badge, published, profile.id]);
  logEvent('buyer_upgraded_ready', { userId: req.session.user.id, meta: { readiness: badge } });
  if (published && !profile.published) {
    mailer.agentsNewBuyerProfile({ ...profile, lender_status: 'Yes — preapproved' }, H.READINESS_LABELS[badge]);
    mailer.buyerProfileLive(req.session.user.email, req.session.user.name, profile); // instant confirmation
    logEvent('buyer_profile_published', { userId: req.session.user.id, meta: { readiness: badge, via: 'upgrade' } });
  }
  res.redirect('/buyer');
});

// ---------- receive 10 more proposals ----------
// Available whenever the window has CLOSED (time or cap) and no agent has
// been chosen — mirrors the seller "request another round". Opens exactly 10
// fresh slots (cap = current count + 10), restarts the same window length,
// extends the profile, and notifies only agents who haven't proposed yet.
router.post('/buyer/rebid', consumer, async (req, res) => {
  const profile = await activeProfile(req.session.user.id);
  if (!profile || profile.status !== 'active' || !profile.published) return res.redirect('/buyer');
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM buyer_proposals WHERE profile_id=$1`, [profile.id]);
  profile.proposal_count = cnt[0].n;
  if (H.windowOpen(profile)) return res.redirect('/buyer'); // window still open — nothing to reopen

  const { rows } = await pool.query(
    `UPDATE buyer_profiles SET round = round + 1, proposal_cap = $2 + 10, window_notified = false,
       closes_at = now() + make_interval(hours => window_hours), expires_at = now() + interval '30 days'
     WHERE id=$1 AND status='active' RETURNING *`, [profile.id, cnt[0].n]);
  if (!rows[0]) return res.redirect('/buyer');

  const { rows: prior } = await pool.query(`SELECT agent_id FROM buyer_proposals WHERE profile_id=$1`, [profile.id]);
  mailer.agentsNewBuyerProfile(rows[0], H.READINESS_LABELS[rows[0].readiness], prior.map(p => p.agent_id)); // fire and forget
  logEvent('buyer_new_round', { userId: req.session.user.id,
    meta: { profile_id: profile.id, round: rows[0].round, prior_proposals: prior.length } });
  res.redirect('/buyer');
});

// ---------- renew / withdraw ----------
router.post('/buyer/renew', consumer, async (req, res) => {
  await pool.query(`UPDATE buyer_profiles SET expires_at = now() + interval '30 days'
    WHERE user_id=$1 AND status='active'`, [req.session.user.id]);
  logEvent('buyer_profile_renewed', { userId: req.session.user.id });
  res.redirect('/buyer');
});

router.post('/buyer/withdraw', consumer, async (req, res) => {
  await pool.query(`UPDATE buyer_profiles SET status='withdrawn', published=false
    WHERE user_id=$1 AND status='active'`, [req.session.user.id]);
  logEvent('buyer_profile_withdrawn', { userId: req.session.user.id });
  res.redirect('/buyer');
});

// ---------- connect: release contact info to ONE agent ----------
router.post('/buyer/connect/:pid(\\d+)', consumer, async (req, res) => {
  const profile = await activeProfile(req.session.user.id);
  if (!profile) return res.redirect('/buyer');
  // Mirror the seller flow: connecting happens after the window closes.
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM buyer_proposals WHERE profile_id=$1`, [profile.id]);
  profile.proposal_count = cnt[0].n;
  if (profile.published && H.windowOpen(profile)) return res.redirect('/buyer');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE buyer_proposals SET connected=true, connected_at=now() WHERE id=$1 AND profile_id=$2`,
      [req.params.pid, profile.id]);
    if (rowCount) await client.query(`UPDATE buyer_profiles SET status='connected', published=false WHERE id=$1`, [profile.id]);
    await client.query('COMMIT');
    if (rowCount) {
      const { rows: winner } = await pool.query(
        `SELECT u.email, u.name FROM buyer_proposals bp JOIN users u ON u.id=bp.agent_id WHERE bp.id=$1`, [req.params.pid]);
      if (winner[0]) mailer.buyerAgentWon(winner[0].email, winner[0].name, profile); // fire and forget
      logEvent('buyer_connected', { userId: req.session.user.id, proposalId: parseInt(req.params.pid), meta: { profile_id: profile.id } });
    }
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.redirect('/buyer');
});

module.exports = router;
