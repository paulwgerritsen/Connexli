// routes/buyer.js — "Find Your Buyer's Agent."
// A homeowner/buyer account (role 'seller') can hold ONE active buyer
// profile. Readiness is computed, never judged: Ready Now and Preparing
// profiles publish to agents; Exploring profiles get the Get Ready track.
const express = require('express');
const { pool, logEvent, PRIORITY_HOURS } = require('../db');
const { requireRole, assertEmailVerified } = require('../middleware');
const H = require('../helpers');
const mailer = require('../mailer');
const schedule = require('../schedule');
const golive = require('../golive');

const router = require('../middleware').safeRouter(express.Router());
const consumer = requireRole('seller'); // homeowner/buyer accounts share one role

// The profile ongoing operations act on: the newest request that is either
// still active or connected (connect/boost/rebid/etc. all check status).
async function activeProfile(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM buyer_profiles WHERE user_id=$1 AND status IN ('active','connected')
     ORDER BY created_at DESC LIMIT 1`, [userId]);
  return rows[0] || null;
}

// The only thing that BLOCKS starting a new buying request: an OPEN one
// (Paul, Aug 14 #2). A connected request is finished — its history stays on
// the dashboard, and the buyer is free to start a fresh search.
// Request details are frozen once any professional has responded (or a
// later round exists) — 2nd Sep 30 update #5: every professional, in every
// round, responds to materially identical information. Something materially
// different = a new request (withdraw this one, then start fresh).
async function detailsLocked(profile) {
  if (!profile || !profile.published) return false;
  if (profile.round > 1) return true;
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM buyer_proposals WHERE profile_id=$1`, [profile.id]);
  return rows[0].n > 0;
}

async function openProfile(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM buyer_profiles WHERE user_id=$1 AND status='active'
     ORDER BY created_at DESC LIMIT 1`, [userId]);
  return rows[0] || null;
}

// ---------- my buyer profile (hub page) ----------
// Mirrors the seller flow: while the window is open the buyer sees only the
// sealed count + countdown; proposals reveal together when the window closes.
async function renderProfile(req, res, profile) {
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM buyer_proposals WHERE profile_id=$1`, [profile.id]);
  profile.proposal_count = cnt[0].n;
  // Scheduled = published overnight, opens at 7:00 AM Mountain (Paul, Sep 2 §6).
  const scheduled = profile.status === 'active' && profile.published && new Date(profile.live_at).getTime() > Date.now();
  const open = profile.status === 'active' && profile.published && H.windowOpen(profile);

  // While a round is open only EARLIER rounds' proposals are visible (and
  // still selectable — 2nd Sep 30 update #7); the current round stays
  // private until it closes. Once it closes, every proposal shows.
  let proposals = [];
  if (!open || profile.round > 1) {
    ({ rows: proposals } = await pool.query(
      `SELECT bp.*, u.name AS agent_name, u.email AS agent_email, u.phone AS agent_phone,
              ap.brokerage, ap.license_number, ap.transactions_seller_12mo, ap.transactions_buyer_12mo
       FROM buyer_proposals bp
       JOIN users u ON u.id = bp.agent_id
       JOIN agent_profiles ap ON ap.user_id = bp.agent_id
       WHERE bp.profile_id=$1 AND ($2::boolean OR bp.round < $3) ORDER BY bp.created_at ASC`, [profile.id, !open, profile.round]));
  }
  // Has this buyer already left feedback on this connection? (Paul, Aug 25)
  let feedbackGiven = false;
  if (profile.status === 'connected') {
    const { rows: fb } = await pool.query(
      `SELECT 1 FROM connection_feedback WHERE opportunity_type='buyer' AND opportunity_id=$1 AND respondent_role='client'`, [profile.id]);
    feedbackGiven = fb.length > 0;
  }
  res.render('buyer/profile', { title: 'My buyer profile', profile, proposals, windowIsOpen: open, H, existingNote: req.query.existing === '1', feedbackGiven,
    locked: await detailsLocked(profile), lockedNote: req.query.locked === '1',
    scheduled, liveAtText: schedule.describe(profile.live_at) });
}

router.get('/buyer', consumer, async (req, res) => {
  // Prefer the open request; otherwise show the most recent connected one.
  const profile = (await openProfile(req.session.user.id)) || (await activeProfile(req.session.user.id));
  if (!profile) return res.render('buyer/start', { title: "Find Your Buyer's Agent", H });
  return renderProfile(req, res, profile);
});

// A specific past or present buying request (dashboard history "View" links).
router.get('/buyer/requests/:id(\\d+)', consumer, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM buyer_profiles WHERE id=$1 AND user_id=$2`, [req.params.id, req.session.user.id]);
  if (!rows[0]) return res.status(404).render('error', { title: 'Not found', message: "That buying request wasn't found on your account." });
  return renderProfile(req, res, rows[0]);
});

// Side-by-side comparison (Paul, Aug 18) — the buyer twin of the seller
// compare table. Available once the window has closed (same rule as the
// seller side: sealed proposals are never compared mid-window).
router.get('/buyer/requests/:id(\\d+)/compare', consumer, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM buyer_profiles WHERE id=$1 AND user_id=$2`, [req.params.id, req.session.user.id]);
  const profile = rows[0];
  if (!profile) return res.status(404).render('error', { title: 'Not found', message: "That buying request wasn't found on your account." });

  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM buyer_proposals WHERE profile_id=$1`, [profile.id]);
  profile.proposal_count = cnt[0].n;
  const open = profile.status === 'active' && profile.published && H.windowOpen(profile);
  if (open && profile.round <= 1) {
    return res.redirect('/buyer/requests/' + profile.id); // still sealed
  }

  // During a later round, compare the earlier rounds' proposals only.
  const { rows: proposals } = await pool.query(
    `SELECT bp.*, u.name AS agent_name,
            ap.brokerage, ap.transactions_seller_12mo, ap.transactions_buyer_12mo
     FROM buyer_proposals bp
     JOIN users u ON u.id = bp.agent_id
     JOIN agent_profiles ap ON ap.user_id = bp.agent_id
     WHERE bp.profile_id=$1 AND ($2::boolean OR bp.round < $3) ORDER BY bp.created_at ASC`, [profile.id, !open, profile.round]);
  res.render('buyer/compare', { title: 'Compare proposals', profile, proposals, H });
});

// ---------- create (Step 1: the ~2-minute core) ----------
router.get('/buyer/new', consumer, async (req, res) => {
  // One OPEN buying request per account (BBA / procuring-cause safety and no
  // duplicate agent notifications). Once it's connected — or expired or
  // withdrawn — the buyer can start a new one; "+ New buying request" on an
  // open request lands on its hub with an explanatory note.
  if (await openProfile(req.session.user.id)) return res.redirect('/buyer?existing=1');
  // Verify email BEFORE the form (Paul, Aug 31): a published profile notifies
  // professionals, and gating here means no one loses a filled-out form.
  if (!(await assertEmailVerified(req, res))) return;
  res.render('buyer/new', { title: "Find Your Buyer's Agent", H, error: null, form: {} });
});

router.post('/buyer/new', consumer, async (req, res) => {
  if (await openProfile(req.session.user.id)) return res.redirect('/buyer');
  if (!(await assertEmailVerified(req, res))) return; // server-side gate, not a hidden button

  const f = {
    financing_type: H.oneOf(req.body.financing_type, H.B_FINANCING, null),
    lender_status: H.oneOf(req.body.lender_status, H.B_LENDER, null),
    down_payment: H.oneOf(req.body.down_payment, H.B_DOWN, null),
    current_situation: H.oneOf(req.body.current_situation, H.B_SITUATION, 'Rent'),
    need_to_sell: H.oneOf(req.body.need_to_sell, H.B_SELL_FIRST, 'No'),
    search_areas: H.clean(req.body.search_areas, 200),
    price_range: Object.keys(H.PRICE_RANGES).includes(req.body.price_range) ? req.body.price_range : null,
    timeline: H.oneOf(req.body.timeline, H.B_TIMELINE, null),
    // Buyer's own touring estimate (Paul, Sep 1 UX #1) — optional, an
    // estimate only, never a contractual limit on showings.
    expected_tours: H.oneOf(req.body.expected_tours, H.B_EXPECTED_TOURS, null),
    in_utah: req.body.in_utah !== 'no',
    origin_state: H.oneOf(req.body.origin_state, H.US_STATES, ''), // dropdown: standardized state names only
    move_reason: H.clean(req.body.move_reason, 120),
    visit_dates: H.clean(req.body.visit_dates, 80),
    video_tours: req.body.video_tours === 'yes',
    purchase_purpose: H.oneOf(req.body.purchase_purpose, H.B_PURPOSE, 'Primary residence'),
    bba: H.oneOf(req.body.bba, H.B_BBA, 'No'),
    bba_expires: H.clean(req.body.bba_expires, 40),
    // One standard window for every round (2nd Sep 30 update #3): up to 48
    // hours or 10 proposals. Buyers no longer choose; anything a stale
    // browser tab still posts is ignored.
    window_hours: H.ROUND_WINDOW_HOURS,
  };
  const fail = (msg) => res.status(400).render('buyer/new', { title: "Find Your Buyer's Agent", H, error: msg, form: { ...f, in_utah: f.in_utah ? 'yes' : 'no', video_tours: f.video_tours ? 'yes' : 'no' } });

  if (!f.financing_type || !f.lender_status || !f.down_payment || !f.timeline || !f.price_range) {
    return fail('Please answer the financing, lender, down payment, timeline, and price range questions.');
  }
  if (!f.search_areas) return fail('Please list at least one city or area you want to search in.');
  if (!f.in_utah && !f.origin_state) return fail("Please tell us which state you're moving from.");

  // Standardize cities (Paul, Aug 14 #2): ONLY canonical Utah cities are
  // stored — each entry must match the city index, and the stored value is
  // the index's spelling with lat/lng saved alongside. Anything else (only
  // possible by bypassing the picker) is dropped; zero valid cities fails.
  // Consistent location data is what drives agent notifications.
  const cityEntries = f.search_areas.split(',').map(s => s.trim()).filter(Boolean);
  const searchGeo = [];
  const canonical = [];
  for (const c of cityEntries) {
    const known = H.utCity(c);
    if (known && !canonical.includes(known.name)) { canonical.push(known.name); searchGeo.push(known); }
  }
  f.search_areas = canonical.join(', ');
  if (!canonical.length) {
    return fail('Please pick at least one Utah city from the suggestion list — start typing and choose a match. This is how we know which nearby agents to notify.');
  }

  // Buyer Broker Agreement screening: an active exclusive agreement blocks a
  // new profile (protects agents from procuring-cause disputes).
  if (f.bba === 'Yes — currently active') {
    logEvent('buyer_blocked_bba', { userId: req.session.user.id });
    return res.render('buyer/bba-blocked', { title: 'One thing first', H, bba_expires: f.bba_expires });
  }

  const badge = H.readiness(f);
  const published = badge !== 'exploring';
  // Go-live timing (Paul, Sep 2 §2–§4): a profile published overnight (7 PM
  // – 6:59:59 AM Mountain) is saved now and opens at the next 7:00 AM; the
  // proposal window and the purchased-credit priority window both start
  // from that go-live moment. Unpublished (Exploring) profiles get their
  // timing when they publish via upgrade instead.
  const liveAt = published ? schedule.goLiveAt(schedule.now(req)) : null; // null = right now
  const { rows } = await pool.query(
    `INSERT INTO buyer_profiles (user_id, readiness, published, financing_type, lender_status, down_payment,
       current_situation, need_to_sell, search_areas, price_range, timeline, expected_tours, in_utah, origin_state,
       move_reason, visit_dates, video_tours, purchase_purpose, bba, bba_expires,
       window_hours, live_at, live_notified, closes_at, priority_until, search_geo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       $21, COALESCE($24::timestamptz, now()), NOT $3::boolean,
       COALESCE($24::timestamptz, now()) + make_interval(hours => $21),
       CASE WHEN $3::boolean THEN COALESCE($24::timestamptz, now()) + make_interval(mins => $23) ELSE NULL END,
       $22) RETURNING *`,
    [req.session.user.id, badge, published, f.financing_type, f.lender_status, f.down_payment,
     f.current_situation, f.need_to_sell, f.search_areas, f.price_range, f.timeline, f.expected_tours, f.in_utah,
     f.origin_state, f.move_reason, f.visit_dates, f.video_tours, f.purchase_purpose, f.bba, f.bba_expires,
     f.window_hours, JSON.stringify(searchGeo), Math.round(PRIORITY_HOURS * 60), liveAt]
  );
  const profile = rows[0];

  logEvent('buyer_profile_created', { userId: req.session.user.id, meta: { readiness: badge, published, in_utah: f.in_utah, price_range: f.price_range } });
  if (f.lender_status === "No — I'd like a recommendation") {
    logEvent('lender_recommendation_requested', { userId: req.session.user.id }); // the Phase-2 demand counter
  }
  if (published) {
    logEvent('buyer_profile_published', { userId: req.session.user.id, meta: { readiness: badge, scheduled_for: liveAt ? liveAt.toISOString() : null } });
    // Professionals are notified by the go-live sweep — immediately for a
    // daytime request, at 7:00 AM for an overnight one (§5: never overnight).
    golive.activateSoon();
    mailer.buyerProfileLive(req.session.user.email, req.session.user.name, profile); // instant confirmation
  }

  // Published buyers land back on the dashboard, where their new buying
  // request is immediately visible (Paul, Aug 10). Exploring buyers still get
  // the Get Ready guidance page.
  if (published) return res.redirect('/dashboard?buyerlive=' + (liveAt ? 'scheduled' : '1'));
  const crossSell = f.need_to_sell.startsWith('Yes');
  res.render('buyer/created', { title: "Let's get you ready", H, profile, published, badge, crossSell });
});

// ---------- Step 2: optional profile booster ----------
router.get('/buyer/boost', consumer, async (req, res) => {
  const profile = await activeProfile(req.session.user.id);
  if (!profile) return res.redirect('/buyer/new');
  if (await detailsLocked(profile)) return res.redirect('/buyer?locked=1');
  res.render('buyer/boost', { title: 'Boost your profile', H, profile, error: null });
});

router.post('/buyer/boost', consumer, async (req, res) => {
  const profile = await activeProfile(req.session.user.id);
  if (!profile) return res.redirect('/buyer/new');
  if (await detailsLocked(profile)) return res.redirect('/buyer?locked=1'); // server-side, not just a hidden button

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
  if (await detailsLocked(profile)) return res.redirect('/buyer?locked=1');
  // Publishing makes the profile live to professionals → verified email only.
  if (!profile.published && !(await assertEmailVerified(req, res))) return;
  const updated = { ...profile, lender_status: 'Yes — preapproved' };
  const badge = H.readiness(updated);
  const published = badge !== 'exploring';
  // Publishing starts the proposal window — and the purchased-credit
  // priority window — fresh from the go-live moment (now, or 7:00 AM
  // Mountain if this happens overnight).
  const liveAt = (published && !profile.published) ? schedule.goLiveAt(schedule.now(req)) : null;
  const { rows: upd } = await pool.query(`UPDATE buyer_profiles SET lender_status='Yes — preapproved', readiness=$1, published=$2,
      live_at = CASE WHEN $2 AND NOT published THEN COALESCE($5::timestamptz, now()) ELSE live_at END,
      live_notified = CASE WHEN $2 AND NOT published THEN false ELSE live_notified END,
      window_hours = CASE WHEN $2 AND NOT published THEN $6 ELSE window_hours END,
      closes_at = CASE WHEN $2 AND NOT published THEN COALESCE($5::timestamptz, now()) + make_interval(hours => $6) ELSE closes_at END,
      priority_until = CASE WHEN $2 AND NOT published THEN COALESCE($5::timestamptz, now()) + make_interval(mins => $4) ELSE priority_until END
    WHERE id=$3 RETURNING *`,
    [badge, published, profile.id, Math.round(PRIORITY_HOURS * 60), liveAt, H.ROUND_WINDOW_HOURS]);
  logEvent('buyer_upgraded_ready', { userId: req.session.user.id, meta: { readiness: badge } });
  if (published && !profile.published) {
    golive.activateSoon(); // notifies now, or at 7:00 AM for an overnight publish
    mailer.buyerProfileLive(req.session.user.email, req.session.user.name, upd[0] || profile); // instant confirmation
    logEvent('buyer_profile_published', { userId: req.session.user.id, meta: { readiness: badge, via: 'upgrade', scheduled_for: liveAt ? liveAt.toISOString() : null } });
  }
  res.redirect('/buyer');
});

// ---------- "Get 10 more proposals" ----------
// 2nd Sep 30 update: once a round has closed (time or cap) and no agent has
// been chosen, the buyer can open another round on this SAME request —
// identical to the seller side. Every round runs up to 48 hours or until it
// gets 10 NEW proposals (cap = proposals so far + 10, however many the last
// round got). Agents who already proposed are excluded from the new round's
// notifications and can't submit again; earlier proposals stay selectable.
router.post('/buyer/rebid', consumer, async (req, res) => {
  const profile = await activeProfile(req.session.user.id);
  if (!H.EXTRA_ROUNDS || !profile || profile.status !== 'active' || !profile.published) return res.redirect('/buyer');
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM buyer_proposals WHERE profile_id=$1`, [profile.id]);
  profile.proposal_count = cnt[0].n;
  if (H.windowOpen(profile)) return res.redirect('/buyer'); // round still open — nothing to reopen

  // A fresh round becomes newly available to professionals who haven't
  // proposed, so the purchased-credit priority window restarts with it —
  // and a round opened overnight goes live at 7:00 AM Mountain, exactly
  // like a new request (Paul, Sep 2 §11).
  const liveAt = schedule.goLiveAt(schedule.now(req));
  const { rows } = await pool.query(
    `UPDATE buyer_profiles SET round = round + 1, proposal_cap = $2::int + $6::int, window_notified = false, window_hours = $5,
       live_at = COALESCE($4::timestamptz, now()), live_notified = false,
       closes_at = COALESCE($4::timestamptz, now()) + make_interval(hours => $5),
       expires_at = GREATEST(expires_at, COALESCE($4::timestamptz, now()) + interval '30 days'),
       priority_until = COALESCE($4::timestamptz, now()) + make_interval(mins => $3)
     WHERE id=$1 AND status='active' RETURNING *`,
    [profile.id, cnt[0].n, Math.round(PRIORITY_HOURS * 60), liveAt, H.ROUND_WINDOW_HOURS, H.ROUND_CAP]);
  if (!rows[0]) return res.redirect('/buyer');

  golive.activateSoon(); // prior bidders are excluded by the sweep
  logEvent('buyer_new_round', { userId: req.session.user.id,
    meta: { profile_id: profile.id, round: rows[0].round, prior_proposals: cnt[0].n, cap: rows[0].proposal_cap,
      closes_at: rows[0].closes_at, scheduled_for: liveAt ? liveAt.toISOString() : null } });
  res.redirect('/buyer');
});

// ---------- one-time 24-hour extension ----------
// If the window expired with fewer proposals than the cap, keep the same
// request open 24 more hours — once. OFF (H.WINDOW_EXTENSION): every round
// is a standard 48-hour round, buyers and sellers alike.
router.post('/buyer/extend', consumer, async (req, res) => {
  const profile = await activeProfile(req.session.user.id);
  if (!H.WINDOW_EXTENSION) return res.redirect('/buyer');
  if (!profile || profile.status !== 'active' || !profile.published || profile.extended) return res.redirect('/buyer');
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM buyer_proposals WHERE profile_id=$1`, [profile.id]);
  profile.proposal_count = cnt[0].n;
  if (H.windowOpen(profile) || cnt[0].n >= profile.proposal_cap) return res.redirect('/buyer');
  const { rowCount } = await pool.query(
    `UPDATE buyer_profiles SET closes_at = now() + interval '24 hours', extended = true, window_notified = false
     WHERE id=$1 AND status='active' AND extended = false`, [profile.id]);
  if (rowCount) logEvent('buyer_request_extended', { userId: req.session.user.id, meta: { profile_id: profile.id, proposals_at_extension: cnt[0].n } });
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
  // Mirror the seller flow: a proposal is selectable once its round has
  // closed — any proposal after the window closes, earlier-round proposals
  // while a later round is still open (2nd Sep 30 update #7).
  if (profile.status !== 'active') return res.redirect('/buyer');
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM buyer_proposals WHERE profile_id=$1`, [profile.id]);
  profile.proposal_count = cnt[0].n;
  const open = profile.published && H.windowOpen(profile);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE buyer_proposals SET connected=true, connected_at=now() WHERE id=$1 AND profile_id=$2 AND ($3::boolean OR round < $4)`,
      [req.params.pid, profile.id, !open, profile.round]);
    if (rowCount) await client.query(`UPDATE buyer_profiles SET status='connected', published=false WHERE id=$1`, [profile.id]);
    await client.query('COMMIT');
    if (rowCount) {
      const { rows: winner } = await pool.query(
        `SELECT u.email, u.name FROM buyer_proposals bp JOIN users u ON u.id=bp.agent_id WHERE bp.id=$1`, [req.params.pid]);
      if (winner[0]) mailer.buyerAgentWon(winner[0].email, winner[0].name, profile); // fire and forget
      if (winner[0]) {
        require('../db').scheduleFollowups('buyer', profile.id,
          { email: req.session.user.email, name: req.session.user.name }, winner[0]);
      }
      logEvent('buyer_connected', { userId: req.session.user.id, proposalId: parseInt(req.params.pid), meta: { profile_id: profile.id, round: profile.round } });
    }
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.redirect('/buyer');
});

module.exports = router;
