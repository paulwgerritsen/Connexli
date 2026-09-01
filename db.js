// db.js — database connection, schema setup, and admin seeding.
// The schema is created automatically on first boot, so there is no separate
// "run migrations" step for a beginner to forget.
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:devpass@localhost:5432/connexli';
// Render's managed Postgres requires SSL; local development does not.
const ssl = /render\.com|amazonaws\.com/.test(connectionString) ? { rejectUnauthorized: false } : false;

const pool = new Pool({ connectionString, ssl });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('seller','agent','admin')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  license_number TEXT NOT NULL,
  brokerage TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'Utah',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  seller_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  property_type TEXT NOT NULL,
  zip TEXT NOT NULL,
  city TEXT NOT NULL,
  neighborhood TEXT,
  beds TEXT NOT NULL,
  baths TEXT NOT NULL,
  sqft_range TEXT NOT NULL,
  year_built TEXT NOT NULL,
  hoa TEXT NOT NULL,
  condition TEXT NOT NULL,
  price_range TEXT NOT NULL,
  priorities TEXT NOT NULL DEFAULT '',
  window_hours INTEGER NOT NULL,
  closes_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','connected','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proposals (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fee_type TEXT NOT NULL CHECK (fee_type IN ('pct','flat')),
  fee_amount NUMERIC NOT NULL CHECK (fee_amount > 0),
  services TEXT NOT NULL DEFAULT '',
  marketing_plan TEXT NOT NULL DEFAULT '',
  cancellation_terms TEXT NOT NULL DEFAULT '',
  shortlisted BOOLEAN NOT NULL DEFAULT false,
  connected BOOLEAN NOT NULL DEFAULT false,
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (request_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status, closes_at);

ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS service_zip TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS service_city TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS service_state TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS transactions_seller_12mo INTEGER;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS transactions_buyer_12mo INTEGER;
ALTER TABLE agent_profiles DROP CONSTRAINT IF EXISTS agent_profiles_status_check;
ALTER TABLE agent_profiles ADD CONSTRAINT agent_profiles_status_check
  CHECK (status IN ('pending','approved','rejected','suspended'));
CREATE INDEX IF NOT EXISTS idx_proposals_request ON proposals(request_id);
CREATE INDEX IF NOT EXISTS idx_proposals_agent ON proposals(agent_id);

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);

-- Buyer Profiles ("Find Your Buyer's Agent"). One active profile per user.
CREATE TABLE IF NOT EXISTS buyer_profiles (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn','expired','connected')),
  published BOOLEAN NOT NULL DEFAULT false,
  readiness TEXT NOT NULL DEFAULT 'preparing' CHECK (readiness IN ('ready_now','preparing','exploring')),
  financing_type TEXT NOT NULL,
  lender_status TEXT NOT NULL,
  down_payment TEXT NOT NULL,
  current_situation TEXT NOT NULL,
  need_to_sell TEXT NOT NULL DEFAULT 'No',
  search_areas TEXT NOT NULL,
  price_range TEXT NOT NULL,
  timeline TEXT NOT NULL,
  in_utah BOOLEAN NOT NULL DEFAULT true,
  origin_state TEXT,
  move_reason TEXT,
  visit_dates TEXT,
  video_tours BOOLEAN NOT NULL DEFAULT false,
  purchase_purpose TEXT NOT NULL DEFAULT 'Primary residence',
  bba TEXT NOT NULL DEFAULT 'No',
  bba_expires TEXT,
  property_prefs TEXT NOT NULL DEFAULT '',
  priorities TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT '',
  first_time BOOLEAN,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 days'
);
CREATE INDEX IF NOT EXISTS idx_buyer_profiles_user ON buyer_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_buyer_profiles_pub ON buyer_profiles(published, status);

CREATE TABLE IF NOT EXISTS buyer_proposals (
  id SERIAL PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES buyer_profiles(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comp_structure TEXT NOT NULL CHECK (comp_structure IN ('pct','flat','hourly','retainer')),
  comp_amount NUMERIC NOT NULL CHECK (comp_amount > 0),
  min_fee NUMERIC,
  included_tours TEXT NOT NULL DEFAULT '',
  video_tours BOOLEAN NOT NULL DEFAULT false,
  response_time TEXT NOT NULL DEFAULT '',
  specialties TEXT NOT NULL DEFAULT '',
  seller_contribution TEXT NOT NULL DEFAULT '',
  rebate TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT '',
  connected BOOLEAN NOT NULL DEFAULT false,
  connected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (profile_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_buyer_proposals_profile ON buyer_proposals(profile_id);

-- The marketplace event log: one row per meaningful action, forever.
-- This is the raw material for every Connexli analytic, present and future.
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  user_id INTEGER,
  request_id INTEGER,
  proposal_id INTEGER,
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_events_request ON events(request_id);

-- Proposal rounds. Every request/profile starts in round 1. Each round accepts
-- up to 10 proposals (the cap that prevents overwhelm); hitting the cap closes
-- the window immediately. Owners can invite another round, which is shown ONLY
-- to professionals who have not proposed in an earlier round.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE buyer_profiles ADD COLUMN IF NOT EXISTS round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE buyer_proposals ADD COLUMN IF NOT EXISTS round INTEGER NOT NULL DEFAULT 1;

-- Buyer requests mirror seller requests (Paul, Aug 11): a timed sealed window
-- (default 48h) that closes at expiry OR when the proposal cap fills, then
-- reveals proposals. "Receive 10 more" opens a fresh round: cap = current
-- count + 10, so every round adds exactly 10 slots regardless of how the
-- previous round ended.
ALTER TABLE buyer_profiles ADD COLUMN IF NOT EXISTS window_hours INTEGER NOT NULL DEFAULT 48;
ALTER TABLE buyer_profiles ADD COLUMN IF NOT EXISTS closes_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '48 hours';
ALTER TABLE buyer_profiles ADD COLUMN IF NOT EXISTS window_notified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE buyer_profiles ADD COLUMN IF NOT EXISTS proposal_cap INTEGER NOT NULL DEFAULT 10;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS proposal_cap INTEGER NOT NULL DEFAULT 10;
UPDATE requests SET proposal_cap = round * 10 WHERE proposal_cap < round * 10;
UPDATE buyer_profiles SET proposal_cap = round * 10 WHERE proposal_cap < round * 10;

-- Buyer proposal clarity (Paul, Aug 11): the direct question replaces the
-- free-text "how do you handle seller contributions".
ALTER TABLE buyer_proposals ADD COLUMN IF NOT EXISTS gap_responsibility TEXT NOT NULL DEFAULT '';

-- One-time 24-hour window extension (Paul, Aug 12): if a window expires with
-- fewer than the cap, the owner may keep it open 24 more hours — once.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS extended BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE buyer_profiles ADD COLUMN IF NOT EXISTS extended BOOLEAN NOT NULL DEFAULT false;

-- Standardized buyer geography (Paul, Aug 14): each selected city stored with
-- lat/lng so notifications match on real distance, never on spelling.
ALTER TABLE buyer_profiles ADD COLUMN IF NOT EXISTS search_geo JSONB;

-- One row per opportunity email actually sent to a professional (Paul,
-- Aug 15): powers the admin "Agents notified" count today, and holds enough
-- detail (who, distance, round) for a per-agent drill-down later. No foreign
-- keys on the opportunity so history survives deletions.
CREATE TABLE IF NOT EXISTS agent_notifications (
  id SERIAL PRIMARY KEY,
  opportunity_type TEXT NOT NULL CHECK (opportunity_type IN ('seller','buyer')),
  opportunity_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  agent_email TEXT NOT NULL,
  distance_miles NUMERIC,
  round INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_notifications_opp ON agent_notifications(opportunity_type, opportunity_id);

-- Email notification preference (Paul, Aug 16): a per-account toggle,
-- defaulting ON for existing and new accounts. Turning it OFF only stops
-- emails — matching, dashboard visibility, proposals, and admin counts are
-- unaffected. agent_notifications.email_sent separates "matched" (row
-- exists) from "email actually sent" (flag true).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE agent_notifications ADD COLUMN IF NOT EXISTS email_sent BOOLEAN NOT NULL DEFAULT true;

-- Automated post-connection follow-ups (Paul, Aug 21). One row per scheduled
-- email; the in-process sweep sends whatever is due. UNIQUE guarantees a
-- follow-up can never be scheduled twice for the same connection.
CREATE TABLE IF NOT EXISTS followups (
  id SERIAL PRIMARY KEY,
  opportunity_type TEXT NOT NULL CHECK (opportunity_type IN ('seller','buyer')),
  opportunity_id INTEGER NOT NULL,
  recipient_role TEXT NOT NULL CHECK (recipient_role IN ('client','professional')),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  counterpart TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('day3','day30')),
  due_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  skip_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (opportunity_type, opportunity_id, recipient_role, kind)
);
CREATE INDEX IF NOT EXISTS idx_followups_due ON followups(due_at) WHERE sent_at IS NULL AND skip_reason IS NULL;

-- Contact form submissions (Paul, Aug 23): stored first, emailed second, so
-- a mail failure never loses a message. Not a ticket system — just a record.
CREATE TABLE IF NOT EXISTS contact_messages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Expansion waitlist (Paul, Aug 23): standardized state + user type so
-- interest can be grouped reliably when choosing the next launch state.
CREATE TABLE IF NOT EXISTS waitlist (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL,
  user_type TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email_lower ON waitlist (LOWER(email));

-- Structured post-connection feedback (Paul, Aug 25): one response per side
-- of each connection, stored against the specific request so it can power
-- marketplace analytics (connect rate, agreement rate, ratings, NPS-style
-- recommend score, per-professional quality).
CREATE TABLE IF NOT EXISTS connection_feedback (
  id SERIAL PRIMARY KEY,
  opportunity_type TEXT NOT NULL CHECK (opportunity_type IN ('seller','buyer')),
  opportunity_id INTEGER NOT NULL,
  respondent_role TEXT NOT NULL CHECK (respondent_role IN ('client','professional')),
  respondent_id INTEGER NOT NULL,
  counterpart_agent_id INTEGER,
  q_connected TEXT NOT NULL CHECK (q_connected IN ('Yes','No')),
  q_agreement TEXT CHECK (q_agreement IN ('Yes','No','Not yet')),
  rating_counterpart INTEGER NOT NULL CHECK (rating_counterpart BETWEEN 1 AND 5),
  rating_connexli INTEGER NOT NULL CHECK (rating_connexli BETWEEN 1 AND 5),
  rating_recommend INTEGER NOT NULL CHECK (rating_recommend BETWEEN 1 AND 5),
  comments TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (opportunity_type, opportunity_id, respondent_role)
);
CREATE INDEX IF NOT EXISTS idx_connection_feedback_agent ON connection_feedback(counterpart_agent_id);

-- RELD license verification (Paul, Aug 29). Two SEPARATE concepts:
-- agent_profiles.status = Connexli ACCOUNT status (pending/approved/...)
-- verification_status   = LICENSE verification per RELD. Never one field.
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS license_state TEXT NOT NULL DEFAULT 'UT';
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'needs_verification'
  CHECK (verification_status IN ('needs_verification','verified','failed','expired','unable_to_verify','needs_review'));
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS reld_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS reld_name TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS reld_license_type TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS reld_license_status TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS reld_expiration TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS reld_brokerage TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS reld_city TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS reld_record_id TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS reld_last_verified TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS reld_checked_at TIMESTAMPTZ;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS reld_error TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS name_mismatch BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS brokerage_mismatch BOOLEAN NOT NULL DEFAULT false;

-- Proposal credit LEDGER (Paul, Aug 29) — never a single balance integer.
-- amount is the signed delta to the PURCHASED balance (complimentary
-- consumption is amount 0 + funding_source 'complimentary'; the monthly free
-- allowance is DERIVED by counting this month's complimentary submissions,
-- so there is no fragile reset job). Month boundary: calendar month in
-- America/Denver. Purchased credits never expire.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_type TEXT NOT NULL CHECK (entry_type IN ('proposal_submitted','purchase','refund','admin_adjustment','promo')),
  funding_source TEXT CHECK (funding_source IN ('complimentary','purchased')),
  amount INTEGER NOT NULL DEFAULT 0,
  proposal_table TEXT,
  proposal_id INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_credit_ledger_agent ON credit_ledger(agent_id, created_at);

-- v19 (Paul, Aug 31): email verification + Turnstile bot protection.
-- email_verified gates consumer request ACTIVATION and the professional RELD
-- lookup — it never blocks logging in or browsing. Existing accounts are
-- grandfathered as verified by init() the first time this column appears.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_expires TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_sent_at TIMESTAMPTZ;

-- v19: 5-hour paid-credit priority window (Paul, Aug 31 §3/§9). Set when a
-- request/profile becomes live to professionals (creation, publish, or a new
-- round). NULL or past = no priority restriction. Server-enforced.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS priority_until TIMESTAMPTZ;
ALTER TABLE buyer_profiles ADD COLUMN IF NOT EXISTS priority_until TIMESTAMPTZ;

-- v19: rejected professionals get their own admin section; an optional
-- rejection reason can be captured from the detail page.
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- v19: payment ARCHITECTURE only (Paul, Aug 31 §8) — no processor is
-- integrated. These columns let a future confirmed payment be recorded
-- against its ledger entry without locking us to any provider.
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS payment_provider TEXT;
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS payment_transaction_id TEXT;
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS package_key TEXT;
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS amount_paid_cents INTEGER;
ALTER TABLE credit_ledger ADD COLUMN IF NOT EXISTS payment_status TEXT;

-- v20 (Paul, Sep 1): automatic RELD decisions + preferred-name review
-- resolution. reviewed_by records WHO decided an application ('RELD
-- auto-verification' or an admin's email). confirmed_reld_* store the
-- registry name/brokerage an administrator confirmed as belonging to this
-- professional, so a resolved Needs Review flag stays resolved on future
-- rechecks while the original mismatch remains in the audit trail.
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS review_resolved_at TIMESTAMPTZ;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS review_resolved_by TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS review_resolution TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS confirmed_reld_name TEXT;
ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS confirmed_reld_brokerage TEXT;
`;

async function init() {
  await pool.query(SCHEMA);

  // Grandfather migration (Paul, Aug 31 §9 of the verification PDF): accounts
  // created before email verification existed are treated as verified — their
  // requests, proposals, and history keep working exactly as before. Runs
  // only on rows where the new column is still NULL (i.e. exactly once per
  // pre-existing account); every NEW account is created with false explicitly.
  await pool.query(`UPDATE users SET email_verified = true WHERE email_verified IS NULL`);
  await pool.query(`ALTER TABLE users ALTER COLUMN email_verified SET DEFAULT false`);

  // Enforce ONE account per email address, case-insensitively (Paul, Aug 15).
  // The CREATE TABLE above declares UNIQUE(email), but a production table
  // created by an earlier schema version never gains that constraint
  // retroactively — and a plain UNIQUE is case-sensitive anyway, so
  // "Email@x.com" and "email@x.com" could coexist. This migration:
  //   1. parks the email of any duplicate accounts (the OLDEST account keeps
  //      the real address; newer ones get a clearly-marked parked address),
  //   2. lowercases every stored email,
  //   3. adds a case-insensitive unique index that closes the door for good.
  try {
    const { rows: dups } = await pool.query(
      `SELECT u.id, u.email FROM users u
       JOIN (SELECT LOWER(email) AS le, MIN(id) AS keep FROM users
             GROUP BY LOWER(email) HAVING COUNT(*) > 1) d
         ON LOWER(u.email) = d.le AND u.id <> d.keep`);
    for (const d of dups) {
      const parked = `duplicate-${d.id}.${d.email.toLowerCase()}`;
      await pool.query(`UPDATE users SET email=$1 WHERE id=$2`, [parked, d.id]);
      console.warn(`WARNING: duplicate account #${d.id} for ${d.email} — email parked as "${parked}". The oldest account keeps the address; review/delete the duplicate in the admin panel.`);
    }
    await pool.query(`UPDATE users SET email=LOWER(email) WHERE email <> LOWER(email)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower ON users (LOWER(email))`);
  } catch (e) {
    console.error('Email-uniqueness migration failed (app still running):', e.message);
  }

  // Backfill follow-ups for connections made BEFORE this feature deployed
  // (Paul, Aug 21 — the requests Connected since 8/8 should get theirs).
  // Past-due rows send on the first sweep after boot. ON CONFLICT keeps this
  // idempotent across restarts.
  try {
    await pool.query(`
      INSERT INTO followups (opportunity_type, opportunity_id, recipient_role, email, name, counterpart, kind, due_at)
      SELECT x.t, x.oid, x.role, x.email, x.name, x.counterpart, k.kind,
             x.connected_at + (CASE k.kind WHEN 'day3' THEN interval '3 days' ELSE interval '30 days' END)
      FROM (
        SELECT 'seller' AS t, r.id AS oid, 'client' AS role, su.email, su.name, au.name AS counterpart, p.connected_at
          FROM proposals p JOIN requests r ON r.id=p.request_id
          JOIN users su ON su.id=r.seller_id JOIN users au ON au.id=p.agent_id
          WHERE p.connected
        UNION ALL
        SELECT 'seller', r.id, 'professional', au.email, au.name, su.name, p.connected_at
          FROM proposals p JOIN requests r ON r.id=p.request_id
          JOIN users su ON su.id=r.seller_id JOIN users au ON au.id=p.agent_id
          WHERE p.connected
        UNION ALL
        SELECT 'buyer', b.id, 'client', bu.email, bu.name, au.name, bp.connected_at
          FROM buyer_proposals bp JOIN buyer_profiles b ON b.id=bp.profile_id
          JOIN users bu ON bu.id=b.user_id JOIN users au ON au.id=bp.agent_id
          WHERE bp.connected
        UNION ALL
        SELECT 'buyer', b.id, 'professional', au.email, au.name, bu.name, bp.connected_at
          FROM buyer_proposals bp JOIN buyer_profiles b ON b.id=bp.profile_id
          JOIN users bu ON bu.id=b.user_id JOIN users au ON au.id=bp.agent_id
          WHERE bp.connected
      ) x
      CROSS JOIN (VALUES ('day3'), ('day30')) AS k(kind)
      WHERE NOT (x.role = 'professional' AND k.kind = 'day30')
      ON CONFLICT (opportunity_type, opportunity_id, recipient_role, kind) DO NOTHING`);
  } catch (e) {
    console.error('Follow-up backfill failed (app still running):', e.message);
  }

  // Seed the first admin account from environment variables.
  const { rows } = await pool.query(`SELECT 1 FROM users WHERE role='admin' LIMIT 1`);
  if (rows.length === 0) {
    const email = (process.env.ADMIN_EMAIL || 'admin@connexli.com').toLowerCase();
    const password = process.env.ADMIN_PASSWORD || 'change-me-now';
    const hash = await bcrypt.hash(password, 12);
    await pool.query(
      `INSERT INTO users (role, name, email, password_hash) VALUES ('admin','Connexli Admin',$1,$2)
       ON CONFLICT (email) DO NOTHING`,
      [email, hash]
    );
    console.log(`Seeded admin account: ${email}`);
  }
}

// Any request whose window has passed becomes 'closed' (the sealed reveal).
// Returns the requests that were closed by THIS call (each returns exactly
// once, so "proposals ready" emails are never sent twice).
async function closeExpired() {
  const { rows } = await pool.query(
    `UPDATE requests SET status='closed' WHERE status='open' AND closes_at <= now()
     RETURNING id, seller_id, property_type, city, zip, price_range`);
  return rows;
}

// Buyer profiles quietly expire after 30 days unless renewed.
async function expireBuyerProfiles() {
  await pool.query(`UPDATE buyer_profiles SET status='expired' WHERE status='active' AND expires_at <= now()`);
}

// Schedule the post-connection follow-ups for one connection: day-3 to both
// sides, day-30 check-in to the client. Fire-and-forget from the connect
// routes; ON CONFLICT makes double-clicks harmless.
function scheduleFollowups(type, oppId, client, professional, connectedAt = new Date()) {
  const rows = [
    ['client', client.email, client.name, professional.name, 'day3', 3],
    ['professional', professional.email, professional.name, client.name, 'day3', 3],
    ['client', client.email, client.name, professional.name, 'day30', 30],
  ];
  for (const [role, email, name, counterpart, kind, days] of rows) {
    pool.query(
      `INSERT INTO followups (opportunity_type, opportunity_id, recipient_role, email, name, counterpart, kind, due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz + make_interval(days => $9))
       ON CONFLICT (opportunity_type, opportunity_id, recipient_role, kind) DO NOTHING`,
      [type, oppId, role, email, name, counterpart, kind, connectedAt, days]
    ).catch((e) => console.error('scheduleFollowups failed:', e.message));
  }
}

// ---------- proposal credits (Paul, Aug 29; updated Aug 31) ----------
// Free monthly allowance is DERIVED from the ledger (no reset job): count of
// this month's complimentary submissions vs the allowance. Month = calendar
// month in America/Denver. Purchased balance = SUM(amount) over all entries.
// Aug 31: allowance is now 5 (was 10). Because the balance is derived, the
// change is the source of truth immediately: a tester who already used more
// than 5 this month simply shows 0 remaining — never a negative number.
const FREE_PROPOSALS_PER_MONTH = parseInt(process.env.FREE_PROPOSALS_PER_MONTH, 10) || 5;
const CREDIT_TZ = 'America/Denver';

// 5-hour paid-credit priority window (Paul, Aug 31 §3). Configurable via env;
// legacy test suites run with PRIORITY_HOURS=0 to disable it.
const PRIORITY_HOURS = process.env.PRIORITY_HOURS !== undefined
  ? Math.max(0, parseFloat(process.env.PRIORITY_HOURS) || 0) : 5;

// Paid bundle pricing (Paul, Aug 31 §6) — configurable, not hard-coded at
// call sites. Override with a CREDIT_BUNDLES env var containing JSON of the
// same shape to change pricing without a code deploy.
let CREDIT_BUNDLES = [
  { key: 'bundle5', credits: 5, price: 50, label: '5 Proposal Credits' },
  { key: 'bundle11', credits: 11, price: 100, label: '11 Proposal Credits — Buy 10, Get 1 Free' },
  { key: 'bundle25', credits: 25, price: 200, label: '25 Proposal Credits — Buy 20, Get 5 Free' },
];
if (process.env.CREDIT_BUNDLES) {
  try { CREDIT_BUNDLES = JSON.parse(process.env.CREDIT_BUNDLES); }
  catch (e) { console.error('Ignoring malformed CREDIT_BUNDLES env var:', e.message); }
}

async function creditSummary(agentId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE entry_type='proposal_submitted' AND funding_source='complimentary'
         AND (created_at AT TIME ZONE $2) >= date_trunc('month', now() AT TIME ZONE $2))::int AS free_used,
       COALESCE(SUM(amount), 0)::int AS purchased,
       to_char(date_trunc('month', now() AT TIME ZONE $2) + interval '1 month', 'FMMonth FMDD') AS next_reset
     FROM credit_ledger WHERE agent_id=$1`, [agentId, CREDIT_TZ]);
  const r = rows[0];
  return {
    freeTotal: FREE_PROPOSALS_PER_MONTH,
    freeUsed: r.free_used,
    freeRemaining: Math.max(0, FREE_PROPOSALS_PER_MONTH - r.free_used),
    purchased: r.purchased,
    nextReset: r.next_reset,
    canSubmit: (FREE_PROPOSALS_PER_MONTH - r.free_used) > 0 || r.purchased > 0,
  };
}

// Record one credit for a just-inserted proposal, INSIDE the caller's open
// transaction (Paul, Aug 31 §4/§10): the professional CHOOSES the funding
// source — free-first auto-consumption is gone. Returns null on success or a
// human-readable error string; on error the caller must ROLLBACK, which also
// undoes the proposal insert — so a failed submission never costs a credit
// and a race can never drive the purchased balance negative.
async function recordProposalCredit(client, agentId, funding, proposalTable, proposalId) {
  await client.query(
    `INSERT INTO credit_ledger (agent_id, entry_type, funding_source, amount, proposal_table, proposal_id)
     VALUES ($1, 'proposal_submitted', $2, $3, $4, $5)`,
    [agentId, funding, funding === 'purchased' ? -1 : 0, proposalTable, proposalId]);
  if (funding === 'purchased') {
    const { rows } = await client.query(
      `SELECT COALESCE(SUM(amount),0)::int AS bal FROM credit_ledger WHERE agent_id=$1`, [agentId]);
    if (rows[0].bal < 0) return 'You have no purchased proposal credits available.';
  } else {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS used FROM credit_ledger
       WHERE agent_id=$1 AND entry_type='proposal_submitted' AND funding_source='complimentary'
         AND (created_at AT TIME ZONE $2) >= date_trunc('month', now() AT TIME ZONE $2)`,
      [agentId, CREDIT_TZ]);
    if (rows[0].used > FREE_PROPOSALS_PER_MONTH) return `You've used your ${FREE_PROPOSALS_PER_MONTH} complimentary proposal credits for this month.`;
  }
  return null;
}

// Record a marketplace event. Fire-and-forget: analytics must never be able
// to break or slow down a real page for a real user, so errors are only
// logged. Deliberately no foreign keys — history survives account deletion.
function logEvent(eventType, { userId = null, requestId = null, proposalId = null, meta = {} } = {}) {
  pool.query(
    `INSERT INTO events (event_type, user_id, request_id, proposal_id, meta) VALUES ($1,$2,$3,$4,$5)`,
    [eventType, userId, requestId, proposalId, JSON.stringify(meta)]
  ).catch((e) => console.error('logEvent failed:', eventType, e.message));
}

module.exports = {
  pool, init, closeExpired, expireBuyerProfiles, logEvent, scheduleFollowups,
  creditSummary, recordProposalCredit, FREE_PROPOSALS_PER_MONTH, CREDIT_TZ,
  PRIORITY_HOURS, CREDIT_BUNDLES,
};
