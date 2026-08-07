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
`;

async function init() {
  await pool.query(SCHEMA);

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

// Record a marketplace event. Fire-and-forget: analytics must never be able
// to break or slow down a real page for a real user, so errors are only
// logged. Deliberately no foreign keys — history survives account deletion.
function logEvent(eventType, { userId = null, requestId = null, proposalId = null, meta = {} } = {}) {
  pool.query(
    `INSERT INTO events (event_type, user_id, request_id, proposal_id, meta) VALUES ($1,$2,$3,$4,$5)`,
    [eventType, userId, requestId, proposalId, JSON.stringify(meta)]
  ).catch((e) => console.error('logEvent failed:', eventType, e.message));
}

module.exports = { pool, init, closeExpired, expireBuyerProfiles, logEvent };
