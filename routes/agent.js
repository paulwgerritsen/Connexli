// routes/agent.js — the professional experience.
const express = require('express');
const { pool, logEvent, creditSummary, recordProposalCredit, PRIORITY_HOURS, CREDIT_BUNDLES } = require('../db');
const { requireRole } = require('../middleware');
const H = require('../helpers');
const mailer = require('../mailer');
const reld = require('../reld');
const payments = require('../payments');
const creditsRoutes = require('./credits');

// Purchased-credit priority window (Paul, Aug 31 §3/§9; 3 hours since Sep 2),
// starting at the opportunity's go-live moment. Enforced HERE on
// the server — the browser countdown is a courtesy display, never the gate.
// NULL/past priority_until (all pre-existing rows) means no restriction.
const priorityActive = (row) => !!(row.priority_until && new Date(row.priority_until).getTime() > Date.now());

// Which credit funds a NEW submission (Paul, Aug 31 §4): the professional
// chooses; free-first auto-consumption is gone. When the form doesn't say
// (older cached pages), default sensibly: complimentary when it's usable,
// otherwise purchased.
function chooseFunding(body, credits, priority) {
  if (body.credit_choice === 'purchased') return 'purchased';
  if (body.credit_choice === 'complimentary') return 'complimentary';
  return (credits.freeRemaining > 0 && !priority) ? 'complimentary' : 'purchased';
}

// License gate (Paul, Aug 29 §25): a failed or expired RELD verification
// blocks proposal submission — even for updates, and even when the
// professional has credits. Credits are never consumed by a blocked attempt.
// needs_review / unable_to_verify / needs_verification do NOT block.
function licenseBlocked(profile) {
  return reld.BLOCKING_STATUSES.includes(profile.verification_status);
}

// Wording for "no credit available" messages: mentions buying only when
// purchasing is actually switched on (Paul, Sep 2 §8).
const BUY_HINT = () => payments.enabled()
  ? ' You can buy a proposal credit right from the opportunity page.'
  : ' Additional proposal credits will be available for purchase soon.';

// A saved draft (Paul, Sep 2 §10) restored into the shape the proposal form
// expects, so the professional finds every field exactly as they left it.
function draftAsProposal(type, d) {
  if (!d) return null;
  const join = (v) => Array.isArray(v) ? v.join(', ') : (v || '');
  if (type === 'buyer') {
    return { isDraft: true, comp_structure: d.comp_structure, comp_amount: d.comp_amount, min_fee: d.min_fee,
      shortfall_policy: d.shortfall_policy, video_tours: d.video_tours === 'yes', response_time: d.response_time,
      specialties: join(d.specialties), seller_contribution: d.seller_contribution, plan: d.plan };
  }
  return { isDraft: true, fee_type: d.fee_type, fee_amount: d.fee_amount, services: join(d.services),
    marketing_plan: d.marketing_plan, cancellation_terms: d.cancellation_terms, listing_ack: d.listing_ack };
}

// Everything the opportunity pages need for the credit section: balances,
// priority state, whether purchasing is on, the single-credit package, and
// any "you just came back from checkout" notice.
async function creditContext(req, row) {
  const credits = await creditSummary(req.session.user.id);
  return {
    credits, priority: priorityActive(row), priorityUntil: row.priority_until, PRIORITY_HOURS,
    purchasing: payments.enabled(), singlePkg: payments.singlePackage(),
    notice: creditsRoutes.purchaseNotice(req.query, credits),
  };
}
const LICENSE_BLOCKED_MSG = 'Your real estate license could not be verified as active, so proposal submissions are paused. Your account and any proposal credits are unaffected. Please contact us to resolve your license status.';

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
    const { rows: uRows } = await pool.query(`SELECT email_verified FROM users WHERE id=$1`, [req.session.user.id]);
    return res.render('agent/pending', {
      title: 'Verification in progress', profile, H,
      emailVerified: !!(uRows[0] && uRows[0].email_verified),
      corrected: req.query.corrected === '1',
      correctLimit: req.query.correct === 'limit',
    });
  }

  const uid = req.session.user.id;
  // Published buyer profiles (anonymous snapshots), with my-proposal flag.
  // Hidden here: profiles whose current round is full, and later-round
  // profiles this agent already proposed on in an earlier round.
  const { rows: buyerOpps } = await pool.query(
    `SELECT b.*, (SELECT COUNT(*) FROM buyer_proposals p WHERE p.profile_id=b.id)::int AS proposal_count,
       (SELECT COUNT(*) FROM buyer_proposals p WHERE p.profile_id=b.id AND p.agent_id=$1)::int AS mine
     FROM buyer_profiles b
     WHERE b.published AND b.status='active'
       AND b.live_at <= now() AND b.closes_at > now()
       AND (SELECT COUNT(*) FROM buyer_proposals p WHERE p.profile_id=b.id) < b.proposal_cap
       AND NOT EXISTS (SELECT 1 FROM buyer_proposals p WHERE p.profile_id=b.id AND p.agent_id=$1 AND p.round < b.round)
     ORDER BY b.closes_at ASC`, [uid]);
  const [opps, mine, stats] = await Promise.all([
    pool.query(
      `SELECT r.*,
         (SELECT COUNT(*) FROM proposals p WHERE p.request_id=r.id)::int AS proposal_count,
         (SELECT COUNT(*) FROM proposals p WHERE p.request_id=r.id AND p.agent_id=$1)::int AS mine
       FROM requests r WHERE r.status='open' AND r.live_at <= now()
         AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.request_id=r.id AND p.agent_id=$1 AND p.round < r.round)
       ORDER BY r.closes_at ASC`, [uid]),
    pool.query(
      `SELECT p.*, r.city, r.zip, r.property_type, r.price_range, r.status AS request_status, r.closes_at,
         r.round AS request_round
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
    `SELECT p.id, p.request_id, u.name AS seller_name, u.email AS seller_email, u.phone AS seller_phone,
            r.city, r.zip, r.property_type, r.price_range
     FROM proposals p JOIN requests r ON r.id=p.request_id JOIN users u ON u.id=r.seller_id
     WHERE p.agent_id=$1 AND p.connected ORDER BY p.connected_at DESC`, [req.session.user.id]);

  // Which connections this professional has already left feedback on
  // (Paul, Aug 25) — drives the Give feedback / completed state per win.
  const { rows: fbRows } = await pool.query(
    `SELECT opportunity_type, opportunity_id FROM connection_feedback
     WHERE respondent_role='professional' AND respondent_id=$1`, [req.session.user.id]);
  const feedbackDone = new Set(fbRows.map(f => f.opportunity_type + ':' + f.opportunity_id));

  // Buyer clients won: connected buyer proposals reveal the buyer's contact info.
  const { rows: buyerWins } = await pool.query(
    `SELECT bp.id, bp.profile_id, u.name AS buyer_name, u.email AS buyer_email, u.phone AS buyer_phone,
            b.search_areas, b.price_range, b.timeline
     FROM buyer_proposals bp JOIN buyer_profiles b ON b.id=bp.profile_id JOIN users u ON u.id=b.user_id
     WHERE bp.agent_id=$1 AND bp.connected ORDER BY bp.connected_at DESC`, [uid]);

  // Every buyer proposal this agent has made, with outcome status (anonymous —
  // no buyer identity joined). Lets agents review and learn from past bids.
  const { rows: myBuyerProposals } = await pool.query(
    `SELECT bp.*, b.search_areas, b.price_range AS b_price_range, b.timeline, b.status AS profile_status,
       (SELECT COUNT(*) FROM buyer_proposals x WHERE x.profile_id=bp.profile_id AND x.connected)::int AS someone_won
     FROM buyer_proposals bp JOIN buyer_profiles b ON b.id=bp.profile_id
     WHERE bp.agent_id=$1 ORDER BY bp.created_at DESC`, [uid]);

  // Radius filter (Paul, Aug 12): opportunities outside the notification
  // radius are hidden from the dashboard too, not just excluded from emails.
  // Display fails OPEN on unresolvable distances (an agent with a data gap
  // still sees opportunities and can fix their ZIP in settings) while emails
  // fail closed — nobody far away gets spammed.
  const inReach = (zip) => {
    // Which side of the distance is unresolvable matters (Paul, Aug 21):
    // - REQUEST ZIP unknown → hide from every dashboard (fail closed, same as
    //   emails). Nobody's geography can be computed, so nobody is eligible.
    // - AGENT ZIP unknown → fail open for display only, so an agent with a
    //   data gap still sees opportunities and can fix their settings.
    if (!mailer.zipInfo(zip)) return false;
    const d = mailer.zipDistance(zip, profile.service_zip);
    return d === null || d <= mailer.RADIUS_MILES;
  };
  const buyerInReach = (b) => {
    // Same sidedness rule as inReach (Paul, Aug 21): an agent-side data gap
    // fails open for display; a request-side gap (no resolvable geography on
    // the buyer's cities) fails closed — hidden, exactly like the emails.
    const z = mailer.zipInfo(profile.service_zip);
    if (!z) return true; // agent-side gap: fail open for display
    // Prefer the exact lat/lng stored with the profile (standardized city
    // selector, Aug 14); legacy free-text rows fall back to name lookup.
    let geo = b.search_geo;
    if (typeof geo === 'string') { try { geo = JSON.parse(geo); } catch (e) { geo = null; } }
    if (Array.isArray(geo) && geo.length) {
      return Math.min(...geo.map(g => H.geoMiles(z.latitude, z.longitude, g.lat, g.lng))) <= mailer.RADIUS_MILES;
    }
    const cities = String(b.search_areas).split(',').map(s => s.trim()).filter(Boolean);
    const dists = cities.map(c => mailer.cityDistance(profile.service_zip, c)).filter(d => d !== null);
    if (!dists.length) return false; // request-side gap: fail closed
    return Math.min(...dists) <= mailer.RADIUS_MILES;
  };
  const opportunities = opps.rows.filter(o => inReach(o.zip));
  const buyerOppsNear = buyerOpps.filter(b => buyerInReach(b));

  // Proposal balance (Paul, Aug 29): derived from the credit ledger — no
  // page-load RELD calls, no external API involved here.
  const credits = await creditSummary(uid);

  res.render('agent/dashboard', {
    title: 'Opportunities', profile, H,
    opportunities, myProposals: mine.rows, stats: stats.rows[0], wins,
    buyerOpps: buyerOppsNear, buyerWins, myBuyerProposals, feedbackDone,
    credits, licenseBlocked: licenseBlocked(profile), CREDIT_BUNDLES, PRIORITY_HOURS,
    purchasing: payments.enabled(), notice: creditsRoutes.purchaseNotice(req.query, credits),
  });
});

// ---------- read-only proposal review pages ----------
// What the agent proposed + what the client had asked for, long after the
// window closes. Anonymous: no client name/contact is ever joined here.
router.get('/agent/proposals/:id(\\d+)', agent, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.*, r.property_type, r.zip, r.city, r.neighborhood, r.beds, r.baths, r.sqft_range,
       r.year_built, r.hoa, r.condition, r.price_range, r.priorities, r.window_hours, r.closes_at,
       r.status AS request_status, r.round AS request_round,
       (SELECT COUNT(*) FROM proposals x WHERE x.request_id=p.request_id)::int AS total_proposals
     FROM proposals p JOIN requests r ON r.id=p.request_id
     WHERE p.id=$1 AND p.agent_id=$2`, [req.params.id, req.session.user.id]);
  if (!rows[0]) return res.status(404).render('error', { title: 'Not found', message: 'That proposal does not exist.' });
  logEvent('proposal_reviewed', { userId: req.session.user.id, proposalId: rows[0].id, requestId: rows[0].request_id });
  res.render('agent/proposal-review', { title: 'My proposal', p: rows[0], H });
});

router.get('/agent/buyer-proposals/:id(\\d+)', agent, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT bp.*, b.readiness, b.financing_type, b.lender_status, b.down_payment, b.search_areas,
       b.price_range AS b_price_range, b.timeline, b.expected_tours, b.purchase_purpose, b.in_utah, b.origin_state,
       b.property_prefs, b.priorities AS b_priorities, b.need_to_sell, b.first_time,
       b.status AS profile_status, b.round AS profile_round,
       (SELECT COUNT(*) FROM buyer_proposals x WHERE x.profile_id=bp.profile_id AND x.connected)::int AS someone_won
     FROM buyer_proposals bp JOIN buyer_profiles b ON b.id=bp.profile_id
     WHERE bp.id=$1 AND bp.agent_id=$2`, [req.params.id, req.session.user.id]);
  if (!rows[0]) return res.status(404).render('error', { title: 'Not found', message: 'That proposal does not exist.' });
  logEvent('buyer_proposal_reviewed', { userId: req.session.user.id, proposalId: rows[0].id });
  res.render('agent/buyer-proposal-review', { title: 'My buyer proposal', p: rows[0], H });
});

// ---------- buyer opportunities ----------
// The anonymous Buyer Snapshot + sealed proposal form.
router.get('/agent/buyers/:id(\\d+)', agent, async (req, res) => {
  const profile = await profileOf(req.session.user.id);
  if (!profile || profile.status !== 'approved') return res.redirect('/agent');

  // live_at guard (Paul, Sep 2 §2): an overnight profile scheduled for 7:00
  // AM is invisible to professionals until then — even by direct link.
  const { rows } = await pool.query(
    `SELECT b.*, (SELECT COUNT(*) FROM buyer_proposals p WHERE p.profile_id=b.id)::int AS proposal_count
     FROM buyer_profiles b WHERE b.id=$1 AND b.published AND b.status='active' AND b.live_at <= now()`, [req.params.id]);
  const buyer = rows[0];
  if (!buyer) return res.status(404).render('error', { title: 'Not found', message: 'That buyer profile is no longer available.' });

  const { rows: mine } = await pool.query(
    `SELECT * FROM buyer_proposals WHERE profile_id=$1 AND agent_id=$2`, [buyer.id, req.session.user.id]);

  // A later round is reserved for professionals who haven't proposed yet.
  if (mine[0] && mine[0].round < buyer.round) {
    return res.status(403).render('error', { title: 'New round in progress', message: 'This buyer opened a fresh round of proposals reserved for professionals who have not yet proposed. Your original sealed proposal is still in their stack.' });
  }

  logEvent('buyer_opportunity_viewed', { userId: req.session.user.id, meta: { profile_id: buyer.id } });
  // No proposal yet? Restore any draft saved when they went to buy a credit (§10).
  const draft = mine[0] ? null : draftAsProposal('buyer', await creditsRoutes.loadDraft(req.session.user.id, 'buyer', buyer.id));
  res.render('agent/buyer-opportunity', {
    title: 'Buyer opportunity', buyer, proposal: mine[0] || draft, H, error: null,
    blockedLicense: licenseBlocked(profile), ...(await creditContext(req, buyer)),
  });
});

router.post('/agent/buyers/:id(\\d+)/propose', agent, async (req, res) => {
  const profile = await profileOf(req.session.user.id);
  if (!profile || profile.status !== 'approved') return res.redirect('/agent');

  // License gate first (§25): blocks new submissions AND edits; credits stay intact.
  if (licenseBlocked(profile)) {
    return res.status(403).render('error', { title: 'License verification required', message: LICENSE_BLOCKED_MSG });
  }

  const { rows } = await pool.query(
    `SELECT b.*, (SELECT COUNT(*) FROM buyer_proposals p WHERE p.profile_id=b.id)::int AS proposal_count
     FROM buyer_profiles b WHERE b.id=$1 AND b.published AND b.status='active' AND b.live_at <= now()`, [req.params.id]);
  const buyer = rows[0];
  if (!buyer) return res.status(400).render('error', { title: 'Not available', message: 'That buyer profile is not accepting proposals right now.' });

  const { rows: mineBefore } = await pool.query(
    `SELECT round FROM buyer_proposals WHERE profile_id=$1 AND agent_id=$2`, [buyer.id, req.session.user.id]);

  // Earlier-round proposals are locked in during a fresh round.
  if (mineBefore[0] && mineBefore[0].round < buyer.round) {
    return res.status(403).render('error', { title: 'New round in progress', message: 'This buyer opened a fresh round of proposals reserved for professionals who have not yet proposed. Your original sealed proposal is still in their stack.' });
  }

  // Credit gate (Paul, Aug 31): a NEW submission needs a credit the
  // professional CHOOSES; editing an existing proposal never costs a second
  // one. During the priority window only purchased credits may submit —
  // enforced here regardless of anything the browser showed.
  let funding = null;
  if (!mineBefore.length) {
    const credits = await creditSummary(req.session.user.id);
    const priority = priorityActive(buyer);
    funding = chooseFunding(req.body, credits, priority);
    if (funding === 'complimentary' && priority) {
      return res.status(403).render('error', { title: "Complimentary access hasn't opened yet", message: `Purchased proposal credits receive ${PRIORITY_HOURS}-hour priority access to new opportunities. Your complimentary access to this opportunity opens at ${new Date(buyer.priority_until).toLocaleString('en-US', { timeZone: 'America/Denver' })} (Mountain).${BUY_HINT()}` });
    }
    if (funding === 'complimentary' && credits.freeRemaining <= 0) {
      return res.status(403).render('error', { title: 'Complimentary credits used', message: `You've used your ${credits.freeTotal} complimentary proposal credits for this month. Your complimentary credits reset ${credits.nextReset}.${BUY_HINT()}` });
    }
    if (funding === 'purchased' && credits.purchased <= 0) {
      return res.status(403).render('error', { title: 'No purchased credits', message: `You have no purchased proposal credits available.${priority ? ` Purchased credits receive ${PRIORITY_HOURS}-hour priority access; your complimentary access to this opportunity opens at ${new Date(buyer.priority_until).toLocaleString('en-US', { timeZone: 'America/Denver' })} (Mountain).` : ' Choose a complimentary credit instead.'}${BUY_HINT()}` });
    }
  }

  // Window and cap: mirrors the seller flow exactly.
  if (!mineBefore.length && buyer.proposal_count >= buyer.proposal_cap) {
    return res.status(400).render('error', { title: 'Proposal cap reached', message: `This buyer already has ${H.ROUND_CAP} sealed proposals this round — the cap that keeps every proposal worth writing. Keep an eye out for the next opportunity.` });
  }
  if (new Date(buyer.closes_at).getTime() <= Date.now()) {
    return res.status(400).render('error', { title: 'Window closed', message: 'This proposal window has already closed.' });
  }

  const comp_structure = ['pct', 'flat'].includes(req.body.comp_structure) ? req.body.comp_structure : 'pct';
  // Shortfall policy (Paul, Sep 1 UX #2) replaces the old yes/no question:
  //  buyer_pays — seller-paid compensation is credited toward the proposed
  //              fee; the buyer covers any remaining amount.
  //  min_fee   — the professional accepts the seller-paid amount, subject to
  //              a REQUIRED minimum compensation figure.
  // gap_responsibility is still stored (derived) so historical displays and
  // analytics keep working.
  const shortfall_policy = req.body.shortfall_policy === 'min_fee' ? 'min_fee' : 'buyer_pays';
  const gap_responsibility = shortfall_policy === 'buyer_pays' ? 'Yes' : 'No';
  const comp_amount = parseFloat(String(req.body.comp_amount).replace(/[^0-9.]/g, ''));
  const min_fee = shortfall_policy === 'min_fee'
    ? (String(req.body.min_fee || '').trim() === '' ? NaN : parseFloat(String(req.body.min_fee).replace(/[^0-9.]/g, '')))
    : null; // Option A has no minimum-fee concept
  let specialties = req.body.specialties || [];
  if (!Array.isArray(specialties)) specialties = [specialties];
  specialties = specialties.filter(s => H.BP_SPECIALTIES.includes(s));
  const fields = {
    // Tours-included and rebate are no longer collected (Paul, Sep 1 UX #1/#9)
    // — the columns stay for historical proposals, new rows store NULL.
    video_tours: req.body.video_tours === 'yes',
    response_time: H.oneOf(req.body.response_time, H.BP_RESPONSE, H.BP_RESPONSE[1]),
    seller_contribution: H.clean(req.body.seller_contribution, 300),
    plan: H.clean(req.body.plan, 2000),
  };

  const badFee = !comp_amount || comp_amount <= 0 ||
    (comp_structure === 'pct' && comp_amount > 10) ||
    (comp_structure === 'flat' && comp_amount > 100000);
  const badMin = shortfall_policy === 'min_fee' && (Number.isNaN(min_fee) || min_fee <= 0 || min_fee > 100000);
  if (badFee || badMin) {
    return res.status(400).render('agent/buyer-opportunity', {
      title: 'Buyer opportunity', buyer, H,
      proposal: { comp_structure, comp_amount: req.body.comp_amount, min_fee: req.body.min_fee, specialties: specialties.join(', '), shortfall_policy, gap_responsibility, ...fields },
      blockedLicense: false, ...(await creditContext(req, buyer)),
      error: badFee
        ? 'Please enter a valid amount for the fee structure you chose (percentages up to 10, or a flat dollar amount in a reasonable range).'
        : 'You chose "subject to a minimum fee" — please enter the minimum compensation you will accept (a dollar amount in a reasonable range).',
    });
  }

  // Same overshoot protection as the seller side: the profile row is locked
  // while we count, insert, and (on the 10th proposal) complete the round.
  const wasUpdate = mineBefore.length > 0;
  const client = await pool.connect();
  let savedId = null, capReached = false, newCount = 0;
  try {
    await client.query('BEGIN');
    const { rows: locked } = await client.query(
      `SELECT * FROM buyer_profiles WHERE id=$1 AND published AND status='active' AND live_at <= now() FOR UPDATE`, [buyer.id]);
    if (!locked[0]) { await client.query('ROLLBACK'); client.release(); return res.status(400).render('error', { title: 'Not available', message: 'That buyer profile is no longer accepting proposals.' }); }
    const live = locked[0];
    const { rows: cnt } = await client.query(`SELECT COUNT(*)::int AS n FROM buyer_proposals WHERE profile_id=$1`, [buyer.id]);
    if (!wasUpdate && cnt[0].n >= live.proposal_cap) { capReached = true; }
    else {
      const { rows: saved } = await client.query(
        `INSERT INTO buyer_proposals (profile_id, agent_id, comp_structure, comp_amount, min_fee,
           video_tours, response_time, specialties, seller_contribution, plan, round, gap_responsibility, shortfall_policy)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (profile_id, agent_id) DO UPDATE SET
           comp_structure=EXCLUDED.comp_structure, comp_amount=EXCLUDED.comp_amount, min_fee=EXCLUDED.min_fee,
           video_tours=EXCLUDED.video_tours, response_time=EXCLUDED.response_time,
           specialties=EXCLUDED.specialties, seller_contribution=EXCLUDED.seller_contribution,
           plan=EXCLUDED.plan, gap_responsibility=EXCLUDED.gap_responsibility,
           shortfall_policy=EXCLUDED.shortfall_policy, updated_at=now()
         RETURNING id`,
        [buyer.id, req.session.user.id, comp_structure, comp_amount, min_fee,
         fields.video_tours, fields.response_time, specialties.join(', '), fields.seller_contribution, fields.plan, live.round, gap_responsibility, shortfall_policy]
      );
      savedId = saved[0].id;
      newCount = wasUpdate ? cnt[0].n : cnt[0].n + 1;
      if (!wasUpdate && newCount >= live.proposal_cap) {
        await client.query(`UPDATE buyer_profiles SET window_notified=true, closes_at=now() WHERE id=$1`, [buyer.id]);
      }
      // Credit + proposal are ONE atomic unit (Paul, Aug 31 §10): the chosen
      // credit is recorded inside this same transaction. If the balance
      // check fails (two tabs racing over the last purchased credit), the
      // whole transaction — proposal included — rolls back: a failed
      // submission never costs a credit, and balances never go negative.
      if (!wasUpdate) {
        const creditError = await recordProposalCredit(client, req.session.user.id, funding, 'buyer_proposals', savedId);
        if (creditError) {
          await client.query('ROLLBACK'); client.release();
          return res.status(403).render('error', { title: 'No credit available', message: creditError + ' Your proposal was not submitted and nothing was charged to your balance.' });
        }
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); client.release(); throw e; }
  client.release();

  if (capReached) {
    // The cap filled before this submission landed — nothing was inserted,
    // so no credit was consumed (Paul, Aug 31 §10).
    return res.status(400).render('error', { title: 'Proposal cap reached', message: `This buyer already has ${H.ROUND_CAP} sealed proposals this round — the cap that keeps every proposal worth writing. No credit was used. Keep an eye out for the next opportunity.` });
  }

  // Submitted for real — the safety-net draft (§10) is no longer needed.
  await creditsRoutes.clearDraft(req.session.user.id, 'buyer', buyer.id);
  const roundFull = newCount >= buyer.proposal_cap;
  logEvent(wasUpdate ? 'buyer_proposal_updated' : 'buyer_proposal_submitted', {
    userId: req.session.user.id, proposalId: savedId,
    meta: { profile_id: buyer.id, comp_structure, comp_amount, price_range: buyer.price_range, round: buyer.round },
  });
  if (!wasUpdate) {
    if (roundFull) logEvent('buyer_round_full', { userId: req.session.user.id, meta: { profile_id: buyer.id, round: buyer.round } });
    const { rows: owner } = await pool.query(`SELECT email, name FROM users WHERE id=$1`, [buyer.user_id]);
    if (owner[0]) {
      // Cap fill = window over: send the "proposals ready early" email.
      if (roundFull) mailer.buyerProposalsReady(owner[0].email, owner[0].name, buyer, true);
      else mailer.buyerNewProposal(owner[0].email, owner[0].name, newCount, false);
    }
  }
  res.redirect('/agent/buyers/' + buyer.id + '/submitted' + (wasUpdate ? '?updated=1' : ''));
});

router.post('/agent/buyers/:id(\\d+)/withdraw', agent, async (req, res) => {
  const { rowCount } = await pool.query(
    `DELETE FROM buyer_proposals bp USING buyer_profiles b
     WHERE bp.profile_id=b.id AND b.id=$1 AND bp.agent_id=$2 AND bp.connected=false AND b.status='active'
       AND bp.round = b.round AND b.closes_at > now()`,
    [req.params.id, req.session.user.id]
  );
  if (rowCount) logEvent('buyer_proposal_withdrawn', { userId: req.session.user.id, meta: { profile_id: parseInt(req.params.id) } });
  res.redirect('/agent');
});

// Confirmation page after a buyer proposal is submitted or updated —
// mirrors the seller-side /submitted experience.
router.get('/agent/buyers/:id(\\d+)/submitted', agent, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT bp.updated_at, bp.created_at, bp.id AS proposal_id, b.*
     FROM buyer_proposals bp JOIN buyer_profiles b ON b.id = bp.profile_id
     WHERE b.id=$1 AND bp.agent_id=$2`, [req.params.id, req.session.user.id]);
  if (!rows[0]) return res.redirect('/agent');
  res.render('agent/buyer-submitted', {
    title: req.query.updated === '1' ? 'Proposal updated' : 'Proposal submitted',
    buyer: rows[0],
    wasUpdate: req.query.updated === '1',
    H,
  });
});

// ---------- account settings ----------
// Open to every professional regardless of status, so pending agents can fix
// their information before review.
async function renderSettings(req, res, opts = {}) {
  const { rows } = await pool.query(
    `SELECT ap.*, u.name, u.email, u.phone, u.email_notifications FROM agent_profiles ap
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

  const email_notifications = req.body.email_notifications === 'on';
  try {
    await pool.query(`UPDATE users SET name=$1, email=$2, phone=$3, email_notifications=$4 WHERE id=$5`,
      [name, email, phone, email_notifications, req.session.user.id]);
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

  // live_at guard (Paul, Sep 2 §2): a request scheduled for 7:00 AM is
  // invisible to professionals until then — even by direct link.
  const { rows } = await pool.query(
    `SELECT r.*, (SELECT COUNT(*) FROM proposals p WHERE p.request_id=r.id)::int AS proposal_count
     FROM requests r WHERE r.id=$1 AND r.live_at <= now()`, [req.params.id]);
  const request = rows[0];
  if (!request) return res.status(404).render('error', { title: 'Not found', message: 'That opportunity does not exist.' });

  const { rows: mine } = await pool.query(
    `SELECT * FROM proposals WHERE request_id=$1 AND agent_id=$2`, [request.id, req.session.user.id]);

  // A later round is reserved for professionals who haven't proposed yet.
  if (mine[0] && mine[0].round < request.round) {
    return res.status(403).render('error', { title: 'New round in progress', message: 'This homeowner opened a fresh round of proposals reserved for professionals who have not yet proposed. Your original sealed proposal is still in their stack.' });
  }

  logEvent('opportunity_viewed', { userId: req.session.user.id, requestId: request.id });
  // No proposal yet? Restore any draft saved when they went to buy a credit (§10).
  const draft = mine[0] ? null : draftAsProposal('seller', await creditsRoutes.loadDraft(req.session.user.id, 'seller', request.id));
  res.render('agent/opportunity', {
    title: 'Opportunity', request, proposal: mine[0] || draft, H, error: null,
    blockedLicense: licenseBlocked(profile), ...(await creditContext(req, request)),
  });
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

  // License gate first (§25): blocks new submissions AND edits; credits stay intact.
  if (licenseBlocked(profile)) {
    return res.status(403).render('error', { title: 'License verification required', message: LICENSE_BLOCKED_MSG });
  }

  const { rows } = await pool.query(`SELECT * FROM requests WHERE id=$1 AND status='open' AND live_at <= now()`, [req.params.id]);
  const request = rows[0];
  if (!request) return res.status(400).render('error', { title: 'Window closed', message: 'This proposal window is not open.' });

  const fee_type = req.body.fee_type === 'flat' ? 'flat' : 'pct';
  const fee_amount = parseFloat(String(req.body.fee_amount).replace(/[^0-9.]/g, ''));
  let services = req.body.services || [];
  if (!Array.isArray(services)) services = [services];
  services = services.filter(s => H.SERVICES.includes(s));
  const marketing_plan = H.clean(req.body.marketing_plan, 2000);
  const cancellation_terms = H.oneOf(req.body.cancellation_terms, H.CANCELLATION, H.CANCELLATION[0]);

  const mineBefore = await pool.query(
    `SELECT round FROM proposals WHERE request_id=$1 AND agent_id=$2`, [request.id, req.session.user.id]);

  // Earlier-round proposals are locked in: this professional cannot edit or
  // resubmit during a round reserved for agents who haven't proposed yet.
  if (mineBefore.rows[0] && mineBefore.rows[0].round < request.round) {
    return res.status(403).render('error', { title: 'New round in progress', message: 'This homeowner opened a fresh round of proposals reserved for professionals who have not yet proposed. Your original sealed proposal is still in their stack.' });
  }

  // Credit gate (Paul, Aug 31): a NEW submission needs a credit the
  // professional CHOOSES; editing an existing proposal never costs a second
  // one. During the priority window only purchased credits may submit —
  // enforced here regardless of anything the browser showed.
  let funding = null;
  if (!mineBefore.rows.length) {
    const credits = await creditSummary(req.session.user.id);
    const priority = priorityActive(request);
    funding = chooseFunding(req.body, credits, priority);
    if (funding === 'complimentary' && priority) {
      return res.status(403).render('error', { title: "Complimentary access hasn't opened yet", message: `Purchased proposal credits receive ${PRIORITY_HOURS}-hour priority access to new opportunities. Your complimentary access to this opportunity opens at ${new Date(request.priority_until).toLocaleString('en-US', { timeZone: 'America/Denver' })} (Mountain).${BUY_HINT()}` });
    }
    if (funding === 'complimentary' && credits.freeRemaining <= 0) {
      return res.status(403).render('error', { title: 'Complimentary credits used', message: `You've used your ${credits.freeTotal} complimentary proposal credits for this month. Your complimentary credits reset ${credits.nextReset}.${BUY_HINT()}` });
    }
    if (funding === 'purchased' && credits.purchased <= 0) {
      return res.status(403).render('error', { title: 'No purchased credits', message: `You have no purchased proposal credits available.${priority ? ` Purchased credits receive ${PRIORITY_HOURS}-hour priority access; your complimentary access to this opportunity opens at ${new Date(request.priority_until).toLocaleString('en-US', { timeZone: 'America/Denver' })} (Mountain).` : ' Choose a complimentary credit instead.'}${BUY_HINT()}` });
    }
  }

  const bad = !fee_amount || fee_amount <= 0 ||
    (fee_type === 'pct' && fee_amount > 10) ||
    (fee_type === 'flat' && fee_amount > 200000);
  const noAck = req.body.listing_ack !== 'yes';
  if (bad || noAck) {
    // (Fixed Sep 1: this re-render previously omitted credits/priority
    // context the template needs, so an invalid fee crashed instead of
    // showing the friendly message.)
    return res.status(400).render('agent/opportunity', {
      title: 'Opportunity', request, H,
      proposal: { fee_type, fee_amount: req.body.fee_amount, services: services.join(', '), marketing_plan, cancellation_terms },
      blockedLicense: false, ...(await creditContext(req, request)),
      error: bad
        ? (fee_type === 'pct'
          ? 'Please enter a percentage fee between 0.1 and 10.'
          : 'Please enter a flat fee amount in dollars (up to $200,000).')
        : 'Please confirm the listing-side compensation acknowledgement before submitting.',
    });
  }

  // The cap check, the insert, and the possible early close all happen inside
  // ONE database transaction with the request row locked. Plain English: even
  // if two agents click Submit at the exact same instant, the database makes
  // them take turns, so the 10-proposal cap can never be overshot.
  const wasUpdate = mineBefore.rows.length > 0;
  const client = await pool.connect();
  let capClosed = false, savedId = null, capReached = false;
  try {
    await client.query('BEGIN');
    const { rows: locked } = await client.query(`SELECT * FROM requests WHERE id=$1 AND status='open' AND live_at <= now() FOR UPDATE`, [request.id]);
    if (!locked[0]) { await client.query('ROLLBACK'); return res.status(400).render('error', { title: 'Window closed', message: 'This proposal window has already closed.' }); }
    const live = locked[0];
    const { rows: cnt } = await client.query(`SELECT COUNT(*)::int AS n FROM proposals WHERE request_id=$1`, [request.id]);
    if (!wasUpdate && cnt[0].n >= live.proposal_cap) { capReached = true; }
    else {
      const { rows: saved } = await client.query(
        `INSERT INTO proposals (request_id, agent_id, fee_type, fee_amount, services, marketing_plan, cancellation_terms, round)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (request_id, agent_id) DO UPDATE SET
           fee_type=EXCLUDED.fee_type, fee_amount=EXCLUDED.fee_amount, services=EXCLUDED.services,
           marketing_plan=EXCLUDED.marketing_plan, cancellation_terms=EXCLUDED.cancellation_terms, updated_at=now()
         RETURNING id`,
        [request.id, req.session.user.id, fee_type, fee_amount, services.join(', '), marketing_plan, cancellation_terms, live.round]
      );
      savedId = saved[0].id;
      if (!wasUpdate && cnt[0].n + 1 >= live.proposal_cap) {
        await client.query(`UPDATE requests SET status='closed', closes_at=now() WHERE id=$1`, [request.id]);
        capClosed = true;
      }
      // Credit + proposal are ONE atomic unit (Paul, Aug 31 §10): the chosen
      // credit is recorded inside this same transaction. If the balance
      // check fails (two tabs racing over the last purchased credit), the
      // whole transaction — proposal included — rolls back: a failed
      // submission never costs a credit, and balances never go negative.
      if (!wasUpdate) {
        const creditError = await recordProposalCredit(client, req.session.user.id, funding, 'proposals', savedId);
        if (creditError) {
          await client.query('ROLLBACK'); client.release();
          return res.status(403).render('error', { title: 'No credit available', message: creditError + ' Your proposal was not submitted and nothing was charged to your balance.' });
        }
      }
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); client.release(); throw e; }
  client.release();

  if (capReached) {
    // The cap filled before this submission landed — nothing was inserted,
    // so no credit was consumed (Paul, Aug 31 §10).
    return res.status(400).render('error', { title: 'Proposal cap reached', message: `This homeowner already has ${H.ROUND_CAP} sealed proposals this round — the cap that keeps every proposal worth writing. No credit was used. Keep an eye out for the next opportunity.` });
  }
  // Submitted for real — the safety-net draft (§10) is no longer needed.
  await creditsRoutes.clearDraft(req.session.user.id, 'seller', request.id);
  logEvent(wasUpdate ? 'proposal_updated' : 'proposal_submitted', {
    userId: req.session.user.id, requestId: request.id, proposalId: savedId,
    meta: { fee_type, fee_amount, price_range: request.price_range, round: request.round },
  });
  if (capClosed) {
    logEvent('request_closed_cap', { userId: req.session.user.id, requestId: request.id, meta: { round: request.round } });
    const { rows: owner } = await pool.query(`SELECT email, name FROM users WHERE id=$1`, [request.seller_id]);
    if (owner[0]) mailer.sellerProposalsReady(owner[0].email, owner[0].name, request, true); // fire and forget
  }
  res.redirect('/agent/opportunities/' + request.id + '/submitted' + (wasUpdate ? '?updated=1' : ''));
});

// Withdraw a proposal (only while the window is open)
router.post('/agent/opportunities/:id(\\d+)/withdraw', agent, async (req, res) => {
  const { rowCount } = await pool.query(
    `DELETE FROM proposals p USING requests r
     WHERE p.request_id=r.id AND r.id=$1 AND p.agent_id=$2 AND r.status='open' AND p.round = r.round`,
    [req.params.id, req.session.user.id]
  );
  if (rowCount) logEvent('proposal_withdrawn', { userId: req.session.user.id, requestId: parseInt(req.params.id) });
  res.redirect('/agent');
});

// ---------- license correction after automatic rejection (Paul, Sep 1 §11) ----------
// Legitimate professionals make typos. An auto-rejected applicant can correct
// their license state/number, which restores the application to pending and
// re-verifies — using the cached result first, so re-submitting the SAME
// wrong number costs zero RELD lookups, and rate-limited so a bot can't cycle
// numbers to burn credits. At most 3 corrections per account per day.
const correctionLimiter = require('express-rate-limit')({
  windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: 'Too many attempts. Please try again later.',
});

router.post('/agent/license-correction', agent, correctionLimiter, async (req, res) => {
  const profile = await profileOf(req.session.user.id);
  if (!profile) return res.redirect('/agent');
  // Only meaningful while the license is definitively failed (auto-rejected
  // applicants) — everything else goes through normal admin channels.
  if (profile.verification_status !== 'failed' || !['rejected', 'pending'].includes(profile.status)) {
    return res.redirect('/agent');
  }
  // Per-account cap: 3 corrections per rolling day, counted in the audit log.
  const { rows: cnt } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM events
     WHERE event_type='license_correction' AND user_id=$1 AND created_at > now() - interval '24 hours'`,
    [req.session.user.id]);
  if (cnt[0].n >= 3) return res.redirect('/agent?correct=limit');

  const license_state = H.LICENSE_STATE_CODES.includes(req.body.license_state) ? req.body.license_state : 'UT';
  const license_number = H.clean(req.body.license_number, 40);
  if (!/^[A-Za-z0-9][A-Za-z0-9 .\-\/]{1,39}$/.test(license_number)) {
    return res.redirect('/agent');
  }
  await pool.query(
    `UPDATE agent_profiles SET license_state=$1, license_number=$2, verification_status='needs_verification',
       status='pending', rejection_reason=NULL, reviewed_by=NULL, reviewed_at=NULL, reld_error=NULL
     WHERE user_id=$3`, [license_state, license_number, req.session.user.id]);
  logEvent('license_correction', { userId: req.session.user.id, meta: { license_state, license_number } });
  const reld = require('../reld');
  if (reld.configured()) {
    try { await reld.verifyProfessional(req.session.user.id, { useCache: true, autoDecide: true }); }
    catch (e) { console.error('RELD correction verification error:', e.message); }
  }
  res.redirect('/agent?corrected=1');
});

module.exports = router;
