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

module.exports = { pool, init, closeExpired };
