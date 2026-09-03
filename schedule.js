// schedule.js — WHEN an opportunity goes live (Paul, Sep 2).
//
// Requests submitted overnight in Mountain Time (7:00 PM – 6:59:59 AM) are
// saved immediately but do not open for proposals — or notify anyone — until
// 7:00 AM Mountain Time. Daytime requests (7:00 AM – 6:59:59 PM) go live the
// instant they are submitted.
//
// Time zone: a REAL America/Denver implementation via the JavaScript Intl
// API (built into Node — no library, no fixed UTC-7), so daylight saving
// time is handled automatically. Nothing here assumes a fixed offset.
const TZ = 'America/Denver';
const OPEN_HOUR = 7;   // 7:00 AM MT — quiet hours end, scheduled requests go live
const QUIET_HOUR = 19; // 7:00 PM MT — quiet hours begin

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
});

// Wall-clock parts of an instant, as seen in Mountain Time.
function denverParts(date) {
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) if (type !== 'literal') p[type] = parseInt(value, 10);
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

// The instant at which a Mountain-Time wall clock reads Y-M-D h:mi:00.
// Starts from the UTC guess and corrects by the zone's offset at that moment
// (done twice so a guess that lands across a DST change still converges).
// 7:00 AM never falls inside a DST transition (those happen at 2:00 AM).
function denverToInstant(y, m, d, h, mi = 0) {
  let t = Date.UTC(y, m - 1, d, h, mi, 0);
  for (let i = 0; i < 2; i++) {
    const p = denverParts(new Date(t));
    t += Date.UTC(y, m - 1, d, h, mi, 0) - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  }
  return new Date(t);
}

// True when the given instant is inside the overnight quiet period.
function inQuietHours(now = new Date()) {
  const { h } = denverParts(now);
  return h >= QUIET_HOUR || h < OPEN_HOUR;
}

// When should an opportunity submitted at `now` go live?
//   • daytime  → null (the caller uses "right now")
//   • overnight → the Date of the next 7:00 AM Mountain Time
function goLiveAt(now = new Date()) {
  if (!inQuietHours(now)) return null;
  const p = denverParts(now);
  // After 7 PM: tomorrow 7 AM. Before 7 AM: today 7 AM. Date.UTC rolls the
  // day-of-month over correctly at month/year ends.
  const dayOffset = p.h >= QUIET_HOUR ? 1 : 0;
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d + dayOffset));
  return denverToInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), OPEN_HOUR, 0);
}

// "Now" for scheduling decisions. In production this is always the real
// clock. ONLY when the TEST_CLOCK=1 environment variable is set (never on
// Render) may an automated test supply a pretend submission time through the
// x-test-now header, so the 6:59/7:00 boundaries can be exercised without
// waiting for the actual hour.
function now(req) {
  if (process.env.TEST_CLOCK === '1' && req && typeof req.get === 'function') {
    const h = req.get('x-test-now');
    if (h) { const d = new Date(h); if (!Number.isNaN(d.getTime())) return d; }
  }
  return new Date();
}

// Display helper: "7:00 AM Mountain Time, Tuesday, September 8".
function describe(date) {
  return new Date(date).toLocaleString('en-US', {
    timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).replace(/(\d{1,2}:\d{2} [AP]M)/, '$1 Mountain Time');
}

module.exports = { TZ, OPEN_HOUR, QUIET_HOUR, denverParts, denverToInstant, inQuietHours, goLiveAt, now, describe };
