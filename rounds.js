// rounds.js — round history for the admin request pages (2nd Sep 30 update,
// #9: "retain understandable history").
//
// No new tables: the history is rebuilt from what Connexli already records —
// each proposal's round number, plus the event log (go-live, "Get 10 more
// proposals", window closed / filled / ended early, connected). Older
// requests from before some of these events existed simply show fewer
// details ("—").
const { pool } = require('./db');

const SELLER = {
  opened: ['request_live'],
  newRound: ['request_new_round'],
  closed: { request_closed: '48-hour window ended', request_closed_cap: '10 proposals received',
    request_closed_early: 'Ended early by the seller', connected: 'Seller connected with a professional' },
};
const BUYER = {
  opened: ['buyer_profile_live'],
  newRound: ['buyer_new_round'],
  closed: { buyer_window_closed: '48-hour window ended', buyer_round_full: '10 proposals received',
    buyer_connected: 'Buyer connected with an agent' },
};

// type: 'seller' | 'buyer'; opp: the requests / buyer_profiles row.
async function roundHistory(type, opp) {
  const cfg = type === 'seller' ? SELLER : BUYER;
  const propTable = type === 'seller' ? 'proposals' : 'buyer_proposals';
  const propKey = type === 'seller' ? 'request_id' : 'profile_id';
  const types = [...cfg.opened, ...cfg.newRound, ...Object.keys(cfg.closed)];

  const [{ rows: counts }, { rows: events }] = await Promise.all([
    pool.query(
      `SELECT round, COUNT(*)::int AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at
       FROM ${propTable} WHERE ${propKey}=$1 GROUP BY round ORDER BY round`, [opp.id]),
    type === 'seller'
      ? pool.query(`SELECT event_type, meta, created_at FROM events
          WHERE request_id=$1 AND event_type = ANY($2) ORDER BY created_at, id`, [opp.id, types])
      : pool.query(`SELECT event_type, meta, created_at FROM events
          WHERE meta->>'profile_id' = $1::text AND event_type = ANY($2) ORDER BY created_at, id`, [String(opp.id), types]),
  ]);

  const rounds = new Map();
  const get = (n) => {
    if (!rounds.has(n)) rounds.set(n, { round: n, opened_at: null, requested_at: null, closed_at: null, closed_how: null, proposals: 0, first_at: null, last_at: null });
    return rounds.get(n);
  };
  for (let n = 1; n <= (opp.round || 1); n++) get(n);

  let current = 1;
  for (const e of events) {
    const m = e.meta || {};
    if (cfg.newRound.includes(e.event_type)) {
      current = parseInt(m.round, 10) || current + 1;
      get(current).requested_at = e.created_at;
    } else if (cfg.opened.includes(e.event_type)) {
      const r = get(parseInt(m.round, 10) || current);
      if (!r.opened_at) r.opened_at = e.created_at;
    } else if (cfg.closed[e.event_type]) {
      const r = get(parseInt(m.round, 10) || current);
      if (!r.closed_at) { r.closed_at = e.created_at; r.closed_how = cfg.closed[e.event_type]; }
    }
  }
  for (const c of counts) Object.assign(get(c.round), { proposals: c.n, first_at: c.first_at, last_at: c.last_at });

  // The current round's planned close (or "open now").
  const cur = get(opp.round || 1);
  cur.closes_at = opp.closes_at;
  return [...rounds.values()].sort((a, b) => a.round - b.round);
}

module.exports = { roundHistory };
