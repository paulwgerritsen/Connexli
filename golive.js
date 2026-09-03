// golive.js — the ONE place an opportunity becomes live to professionals
// (Paul, Sep 2). Every seller request and buyer profile, whether it was
// submitted at 2:15 PM (live immediately) or 11:30 PM (scheduled for 7:00
// AM Mountain), passes through activateDue(): it finds opportunities whose
// live_at has arrived and whose professionals have NOT been notified yet,
// marks them notified, and sends the opportunity emails. Because the marking
// happens in the same UPDATE that selects the rows, two overlapping sweeps
// (a page view and the timer firing together) can never notify twice.
//
// Runs: right after a daytime submission (so nothing waits), every page
// view, and on a one-minute timer so a 7:00 AM go-live happens at 7:00 AM
// even if nobody is browsing.
const { pool, logEvent } = require('./db');
const mailer = require('./mailer');
const H = require('./helpers');

async function activateDue() {
  // Seller requests.
  const { rows: reqs } = await pool.query(
    `UPDATE requests SET live_notified = true
     WHERE status='open' AND live_notified = false AND live_at <= now()
     RETURNING *`);
  for (const r of reqs) {
    // A fresh round excludes professionals who already proposed (their
    // sealed proposals stay in the stack) — same rule as before Sep 2.
    const { rows: prior } = await pool.query(`SELECT agent_id FROM proposals WHERE request_id=$1`, [r.id]);
    await mailer.agentsNewRequest(r, prior.map(p => p.agent_id));
    logEvent('request_live', { userId: r.seller_id, requestId: r.id,
      meta: { round: r.round, scheduled: new Date(r.live_at).getTime() - new Date(r.created_at).getTime() > 60 * 1000 } });
  }

  // Buyer profiles.
  const { rows: profs } = await pool.query(
    `UPDATE buyer_profiles SET live_notified = true
     WHERE published AND status='active' AND live_notified = false AND live_at <= now()
     RETURNING *`);
  for (const b of profs) {
    const { rows: prior } = await pool.query(`SELECT agent_id FROM buyer_proposals WHERE profile_id=$1`, [b.id]);
    await mailer.agentsNewBuyerProfile(b, H.READINESS_LABELS[b.readiness], prior.map(p => p.agent_id));
    logEvent('buyer_profile_live', { userId: b.user_id,
      meta: { profile_id: b.id, round: b.round, scheduled: new Date(b.live_at).getTime() - new Date(b.created_at).getTime() > 60 * 1000 } });
  }
  return { requests: reqs.length, buyers: profs.length };
}

// Fire-and-forget wrapper for route handlers: never lets a notification
// problem break the page the consumer is looking at.
function activateSoon() {
  activateDue().catch((e) => console.error('activateDue:', e.message));
}

module.exports = { activateDue, activateSoon };
