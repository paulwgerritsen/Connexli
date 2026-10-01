// routes/seller.js — the homeowner experience.
const express = require('express');
const { pool, logEvent, PRIORITY_HOURS } = require('../db');
const { requireRole, assertEmailVerified } = require('../middleware');
const H = require('../helpers');
const mailer = require('../mailer');
const schedule = require('../schedule');
const golive = require('../golive');

const router = require('../middleware').safeRouter(express.Router());
const seller = requireRole('seller');

// My requests — selling AND buying, side by side.
router.get('/dashboard', seller, async (req, res) => {
  const [{ rows: requests }, { rows: buyerRequests }] = await Promise.all([
    pool.query(
      `SELECT r.*, (SELECT COUNT(*) FROM proposals p WHERE p.request_id = r.id)::int AS proposal_count
       FROM requests r WHERE r.seller_id=$1 ORDER BY r.created_at DESC`,
      [req.session.user.id]),
    pool.query(
      `SELECT b.*, (SELECT COUNT(*) FROM buyer_proposals p WHERE p.profile_id = b.id)::int AS proposal_count
       FROM buyer_profiles b WHERE b.user_id=$1 AND b.status IN ('active','connected')
       ORDER BY b.created_at DESC`,
      [req.session.user.id]),
  ]);
  // Which connections this user has already left feedback on (Paul, Aug 25).
  const { rows: fbRows } = await pool.query(
    `SELECT opportunity_type, opportunity_id FROM connection_feedback
     WHERE respondent_role='client' AND respondent_id=$1`, [req.session.user.id]);
  const feedbackDone = new Set(fbRows.map(f => f.opportunity_type + ':' + f.opportunity_id));
  res.render('seller/dashboard', {
    title: 'My requests', requests, buyerRequests, H, feedbackDone,
    buyerLive: req.query.buyerlive === 'scheduled' ? 'scheduled' : req.query.buyerlive === '1', // success banner right after publishing
  });
});

// ---------- account settings (buyers & sellers) ----------
// Professionals have /agent/settings; this is the consumer equivalent —
// contact details plus the email-notifications toggle (Paul, Aug 16).
async function renderConsumerSettings(req, res, opts = {}) {
  const { rows } = await pool.query(
    `SELECT name, email, phone, email_notifications FROM users WHERE id=$1`, [req.session.user.id]);
  const p = { ...rows[0], ...(opts.form || {}) };
  res.status(opts.error ? 400 : 200).render('seller/settings', { title: 'Account settings', p, error: opts.error || null, saved: opts.saved || false });
}

router.get('/settings', seller, (req, res) => renderConsumerSettings(req, res, { saved: req.query.saved === '1' }));

router.post('/settings', seller, async (req, res) => {
  const name = H.clean(req.body.name, 100);
  const email = H.clean(req.body.email, 120).toLowerCase();
  const phone = H.clean(req.body.phone, 30);
  const email_notifications = req.body.email_notifications === 'on';
  const form = { name, email, phone, email_notifications };
  const fail = (msg) => renderConsumerSettings(req, res, { error: msg, form });

  if (!name || !email.includes('@')) return fail('Please enter your name and a valid email address.');
  try {
    await pool.query(`UPDATE users SET name=$1, email=$2, phone=$3, email_notifications=$4 WHERE id=$5`,
      [name, email, phone, email_notifications, req.session.user.id]);
  } catch (e) {
    if (e.code === '23505') return fail('Another account already uses that email address.');
    throw e;
  }
  req.session.user = { ...req.session.user, name, email };
  logEvent('consumer_settings_updated', { userId: req.session.user.id });
  res.redirect('/settings?saved=1');
});

// New request form
router.get('/requests/new', seller, async (req, res) => {
  // Verify email BEFORE the form, so nobody fills it out and then loses their
  // answers at the gate. The POST below still enforces it server-side.
  if (!(await assertEmailVerified(req, res))) return;
  res.render('seller/new-request', { title: 'Tell us about your home', H, error: null, form: {} });
});

router.post('/requests/new', seller, async (req, res) => {
  // Email verification gate (Paul, Aug 31): a request that goes live triggers
  // professional notifications, so it requires a verified email — enforced
  // here on the server, not by hiding a button.
  if (!(await assertEmailVerified(req, res))) return;
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
    // "When are you hoping to list your home?" (Paul, Sep 30) — required.
    listing_timeline: H.oneOf(req.body.listing_timeline, H.SELLER_TIMELINE, null),
  };
  // One standard proposal window for every seller request (Paul, Sep 30):
  // up to 48 hours, closing early the moment 10 proposals arrive. The seller
  // no longer chooses a window, and "What matters most?" is no longer asked —
  // anything a stale browser tab still posts for either is ignored.
  const windowHours = H.ROUND_WINDOW_HOURS;

  if (!f.property_type || !f.zip.match(/^\d{5}$/) || !f.city || !f.price_range || !f.listing_timeline) {
    return res.status(400).render('seller/new-request', {
      title: 'Tell us about your home', H, form: { ...f, comp_ack: req.body.comp_ack },
      error: 'Please choose a property type, enter a 5-digit ZIP code and city, pick a price range, and tell us when you\'re hoping to list.',
    });
  }
  // The ZIP must exist in the geographic database (Paul, Aug 21 — the Lehi
  // "84048" case). An unresolvable ZIP breaks everything downstream: no
  // distance can be computed, so no professional is ever emailed (emails fail
  // closed) while the fail-open dashboard showed it to everyone. Same rule as
  // agent registration/settings and the buyer city picker.
  if (!mailer.zipInfo(f.zip)) {
    return res.status(400).render('seller/new-request', {
      title: 'Tell us about your home', H, form: { ...f, comp_ack: req.body.comp_ack },
      error: `We couldn't find ZIP code ${f.zip}. Please double-check it — this is how we match your home with nearby professionals. (Lehi, for example, is 84043.)`,
    });
  }
  // Compensation-transparency acknowledgement (required; see selling.html education).
  if (req.body.comp_ack !== 'yes') {
    return res.status(400).render('seller/new-request', {
      title: 'Tell us about your home', H, form: { ...f },
      error: 'Please confirm the acknowledgement about listing-side compensation before launching your request.',
    });
  }

  // Go-live timing (Paul, Sep 2 §2–§4): overnight submissions (7 PM –
  // 6:59:59 AM Mountain) are saved now but open at the next 7:00 AM; daytime
  // submissions open immediately. The proposal window AND the purchased-
  // credit priority window both start from the go-live moment, so an
  // overnight wait never eats into the 48-hour window.
  const liveAt = schedule.goLiveAt(schedule.now(req)); // null = right now
  const { rows } = await pool.query(
    `INSERT INTO requests (seller_id, property_type, zip, city, neighborhood, beds, baths, sqft_range,
       year_built, hoa, condition, price_range, listing_timeline, window_hours, proposal_cap, live_at, live_notified, closes_at, priority_until)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$17,
       COALESCE($16::timestamptz, now()), false,
       COALESCE($16::timestamptz, now()) + make_interval(hours => $14),
       COALESCE($16::timestamptz, now()) + make_interval(mins => $15))
     RETURNING id`,
    [req.session.user.id, f.property_type, f.zip, f.city, f.neighborhood, f.beds, f.baths, f.sqft_range,
     f.year_built, f.hoa, f.condition, f.price_range, f.listing_timeline, windowHours,
     Math.round(PRIORITY_HOURS * 60), liveAt, H.ROUND_CAP]
  );
  // Attribution only (Paul, Sep 28 /fsbo): credit the marketing source this
  // session arrived with, else the account's signup source. Separate update
  // so the request insert itself is unchanged.
  await pool.query(
    `UPDATE requests SET source = COALESCE($2, (SELECT signup_source FROM users WHERE id=$3)) WHERE id=$1`,
    [rows[0].id, req.session.leadSource || null, req.session.user.id]);
  const { rows: fullRows } = await pool.query(`SELECT * FROM requests WHERE id=$1`, [rows[0].id]);
  // Professionals are notified by the go-live sweep — immediately for a
  // daytime request, at 7:00 AM for an overnight one (§5: never overnight).
  golive.activateSoon();
  mailer.sellerRequestReceived(req.session.user.email, req.session.user.name, fullRows[0]); // instant confirmation
  logEvent('request_posted', { userId: req.session.user.id, requestId: rows[0].id,
    meta: { zip: f.zip, city: f.city, price_range: f.price_range, listing_timeline: f.listing_timeline, window_hours: windowHours, scheduled_for: liveAt ? liveAt.toISOString() : null, source: fullRows[0].source || null } });
  res.redirect('/requests/' + rows[0].id);
});

// Load a request owned by this seller (helper)
async function loadRequest(req, res) {
  const { rows } = await pool.query(`SELECT * FROM requests WHERE id=$1 AND seller_id=$2`, [req.params.id, req.session.user.id]);
  if (!rows[0]) { res.status(404).render('error', { title: 'Not found', message: 'That request does not exist.' }); return null; }
  return rows[0];
}

// The proposals a seller may see right now. While a round is open, only
// proposals from EARLIER rounds are visible (the current round stays private
// until it closes); once it closes, every round's proposals are visible.
async function visibleProposals(request, extraCols = '') {
  const { rows } = await pool.query(
    `SELECT p.*, u.name AS agent_name, ap.brokerage, ap.transactions_seller_12mo, ap.transactions_buyer_12mo${extraCols}
     FROM proposals p
     JOIN users u ON u.id = p.agent_id
     JOIN agent_profiles ap ON ap.user_id = p.agent_id
     WHERE p.request_id=$1 AND ($2::boolean OR p.round < $3)`,
    [request.id, request.status !== 'open', request.round]);
  return rows;
}
function sortProposals(proposals, request, sort) {
  proposals.sort((a, b) => sort === 'fee'
    ? H.estFee(a, request.price_range) - H.estFee(b, request.price_range)
    : new Date(b.created_at) - new Date(a.created_at));
  return proposals;
}

// Request detail: countdown while a round is open (plus every proposal from
// earlier rounds, still selectable), all proposals once it closes.
router.get('/requests/:id(\\d+)', seller, async (req, res) => {
  const request = await loadRequest(req, res);
  if (!request) return;
  const sort = ['fee', 'newest'].includes(req.query.sort) ? req.query.sort : 'fee';

  if (request.status === 'open') {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM proposals WHERE request_id=$1`, [request.id]);
    // Scheduled = saved overnight, opens at 7:00 AM Mountain (Paul, Sep 2 §6).
    const scheduled = new Date(request.live_at).getTime() > Date.now();
    // Earlier-round proposals stay visible and selectable while a later
    // round runs (2nd Sep 30 update, #7).
    const earlier = request.round > 1
      ? sortProposals(await visibleProposals(request), request, sort) : [];
    return res.render('seller/request-open', {
      title: scheduled ? 'Your request is ready' : 'Your request is live', request, proposalCount: rows[0].n, H,
      roundCap: request.proposal_cap, // window auto-closes at this count
      thisRound: H.takenThisRound({ proposal_count: rows[0].n, proposal_cap: request.proposal_cap }),
      scheduled, liveAtText: schedule.describe(request.live_at), earlier, sort,
    });
  }

  const proposals = sortProposals(await visibleProposals(request,
    ', u.email AS agent_email, u.phone AS agent_phone, ap.license_number'), request, sort);

  // Has this seller already left feedback on this connection? (Paul, Aug 25)
  const { rows: fb } = await pool.query(
    `SELECT 1 FROM connection_feedback WHERE opportunity_type='seller' AND opportunity_id=$1 AND respondent_role='client'`, [request.id]);
  res.render('seller/request-results', { title: 'Your proposals', request, proposals, sort, H, feedbackGiven: fb.length > 0 });
});

// Compare table
// While a later round is open, the comparison covers the earlier rounds'
// proposals (the current round is still private).
router.get('/requests/:id(\\d+)/compare', seller, async (req, res) => {
  const request = await loadRequest(req, res);
  if (!request) return;
  if (request.status === 'open' && request.round <= 1) return res.redirect('/requests/' + request.id);
  const proposals = (await visibleProposals(request))
    .sort((a, b) => (b.shortlisted - a.shortlisted) || (new Date(a.created_at) - new Date(b.created_at)));
  if (!proposals.length) return res.redirect('/requests/' + request.id);
  const shortlisted = proposals.filter(p => p.shortlisted);
  res.render('seller/compare', {
    title: 'Compare proposals', request, H,
    proposals: shortlisted.length >= 2 ? shortlisted : proposals,
    usingShortlist: shortlisted.length >= 2,
  });
});

// "Get 10 more proposals" (2nd Sep 30 update): once a round has closed, the
// seller can open another round on this SAME request — no new request, no
// edits to the details. Every round runs up to 48 hours or until it gets 10
// NEW proposals (cap = proposals so far + 10, however many the last round
// got). Professionals who already proposed are excluded: the go-live sweep
// skips them when notifying, and they can't see or submit to the new round.
// Earlier proposals stay in place and remain selectable.
router.post('/requests/:id(\\d+)/rebid', seller, async (req, res) => {
  const request = await loadRequest(req, res);
  if (!request) return;
  if (!H.EXTRA_ROUNDS || request.status !== 'closed') return res.redirect('/requests/' + request.id);

  // A fresh round becomes newly available to professionals who haven't
  // proposed, so the purchased-credit priority window restarts with it —
  // and, like a brand-new request, a round opened overnight goes live at
  // 7:00 AM Mountain (Paul, Sep 2 §11: buyer and seller work the same).
  const liveAt = schedule.goLiveAt(schedule.now(req));
  const { rows } = await pool.query(
    `UPDATE requests SET round = round + 1, status='open', window_hours = $4,
       live_at = COALESCE($3::timestamptz, now()), live_notified = false,
       closes_at = COALESCE($3::timestamptz, now()) + make_interval(hours => $4),
       proposal_cap = (SELECT COUNT(*) FROM proposals WHERE request_id=$1) + $5,
       priority_until = COALESCE($3::timestamptz, now()) + make_interval(mins => $2)
     WHERE id=$1 AND status='closed' RETURNING *`,
    [request.id, Math.round(PRIORITY_HOURS * 60), liveAt, H.ROUND_WINDOW_HOURS, H.ROUND_CAP]);
  if (!rows[0]) return res.redirect('/requests/' + request.id);

  // Professionals who already proposed are excluded from the new-round
  // emails — the go-live sweep handles that (now, or at 7:00 AM).
  const { rows: prior } = await pool.query(`SELECT COUNT(*)::int AS n FROM proposals WHERE request_id=$1`, [request.id]);
  golive.activateSoon();
  logEvent('request_new_round', { userId: req.session.user.id, requestId: request.id,
    meta: { round: rows[0].round, prior_proposals: prior[0].n, cap: rows[0].proposal_cap, closes_at: rows[0].closes_at,
      scheduled_for: liveAt ? liveAt.toISOString() : null } });
  res.redirect('/requests/' + request.id);
});

// One-time 24-hour extension (Paul, Aug 12): if the window expired with fewer
// than the cap, the seller can keep the SAME request open 24 more hours.
// Round and cap are unchanged; agents who already proposed can still edit.
// OFF (H.WINDOW_EXTENSION): every round is a standard 48-hour round.
router.post('/requests/:id(\\d+)/extend', seller, async (req, res) => {
  const request = await loadRequest(req, res);
  if (!request) return;
  if (!H.WINDOW_EXTENSION) return res.redirect('/requests/' + request.id);
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS n FROM proposals WHERE request_id=$1`, [request.id]);
  if (request.status !== 'closed' || request.extended || cnt[0].n >= request.proposal_cap) {
    return res.redirect('/requests/' + request.id);
  }
  const { rowCount } = await pool.query(
    `UPDATE requests SET status='open', closes_at = now() + interval '24 hours', extended = true
     WHERE id=$1 AND status='closed' AND extended = false`, [request.id]);
  if (rowCount) logEvent('request_extended', { userId: req.session.user.id, requestId: request.id, meta: { proposals_at_extension: cnt[0].n } });
  res.redirect('/requests/' + request.id);
});

// Close the window early
router.post('/requests/:id(\\d+)/close', seller, async (req, res) => {
  if (!H.SELLER_END_EARLY) return res.redirect('/requests/' + req.params.id);
  const { rows } = await pool.query(
    `UPDATE requests SET status='closed', closes_at=now() WHERE id=$1 AND seller_id=$2 AND status='open' RETURNING *`,
    [req.params.id, req.session.user.id]);
  if (rows[0]) {
    logEvent('request_closed_early', { userId: req.session.user.id, requestId: parseInt(req.params.id), meta: { round: rows[0].round } });
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
  // Closed: any proposal. Open later round: earlier-round proposals only.
  if (request.status === 'closed' || request.status === 'open') {
    await pool.query(`UPDATE proposals SET shortlisted = NOT shortlisted WHERE id=$1 AND request_id=$2 AND ($3::boolean OR round < $4)`,
      [req.params.pid, request.id, request.status === 'closed', request.round]);
    logEvent('shortlist_toggled', { userId: req.session.user.id, requestId: request.id, proposalId: parseInt(req.params.pid) });
  }
  res.redirect('/requests/' + request.id + (req.body.from === 'compare' ? '/compare' : ''));
});

// Connect: release contact info to one agent
router.post('/requests/:id(\\d+)/connect/:pid(\\d+)', seller, async (req, res) => {
  const request = await loadRequest(req, res);
  if (!request) return;
  // Proposals are selectable once their round has closed: every proposal
  // when the request is closed, earlier-round proposals while a later round
  // is still open (2nd Sep 30 update, #7). Connecting ends the request.
  if (request.status !== 'closed' && request.status !== 'open') return res.redirect('/requests/' + request.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query(
      `UPDATE proposals SET connected=true, connected_at=now() WHERE id=$1 AND request_id=$2 AND ($3::boolean OR round < $4)`,
      [req.params.pid, request.id, request.status === 'closed', request.round]
    );
    if (rowCount) await client.query(`UPDATE requests SET status='connected' WHERE id=$1 AND status IN ('open','closed')`, [request.id]);
    await client.query('COMMIT');
    const { rows: winner } = await pool.query(
      `SELECT u.email, u.name FROM proposals p JOIN users u ON u.id=p.agent_id WHERE p.id=$1`, [req.params.pid]);
    if (winner[0]) mailer.agentWon(winner[0].email, winner[0].name, request); // fire and forget
    if (rowCount && winner[0]) {
      require('../db').scheduleFollowups('seller', request.id,
        { email: req.session.user.email, name: req.session.user.name }, winner[0]);
    }
    if (rowCount) logEvent('connected', { userId: req.session.user.id, requestId: request.id, proposalId: parseInt(req.params.pid), meta: { round: request.round } });
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  res.redirect('/requests/' + request.id);
});

module.exports = router;
