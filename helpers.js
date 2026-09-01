// helpers.js — shared constants and small utilities.
const zipcodes = require('zipcodes');

const PROPERTY_TYPES = ['Single Family', 'Townhome', 'Condo', 'Duplex', 'Multi-Unit', 'Land'];
const BEDS = ['1', '2', '3', '4', '5', '6+'];
const BATHS = ['1', '2', '3', '4', '5+'];
const SQFT = ['Under 1,500', '1,500–2,000', '2,000–2,500', '2,500–3,000', '3,000–4,000', '4,000+'];
const YEARS = ['2020s', '2010–2019', '2000–2009', '1980–1999', 'Before 1980'];
const CONDITIONS = ['Like new', 'Updated', 'Average', 'Needs work'];
const PRIORITIES = ['Lowest listing fee', 'Most experienced', 'Fastest sale', 'Best marketing', 'Highest sale price'];
const SERVICES = ['Professional photos', 'Drone video', 'Open house(s)', 'Social campaign', '3D tour', 'Staging consult', 'Print marketing'];
const CANCELLATION = ['Cancel anytime, no fee', '30-day written notice', 'Locked for listing term'];

const PRICE_RANGES = {
  'Under $300k': 250000,
  '$300k–$500k': 400000,
  '$500k–$750k': 625000,
  '$750k–$1M': 875000,
  '$1M–$1.5M': 1250000,
  '$1.5M+': 1750000,
};

// One number controls the marketplace cap everywhere: each round accepts at
// most this many sealed proposals, then the window closes on the spot.
const ROUND_CAP = 10;

// Three windows (Paul, Aug 12): 72h removed; 48h is the single Recommended
// option; 7 days explains its use cases without competing messaging.
const WINDOWS = [
  { hours: 24,  label: '24 hours', tag: 'Rush',        desc: 'Fastest turnaround. Many agents respond within hours.' },
  { hours: 48,  label: '48 hours', tag: 'Recommended', desc: 'Our recommendation. Fast answers, with enough time for thoughtful proposals.' },
  { hours: 168, label: '7 days',   tag: 'Extended',    desc: 'Useful for luxury homes, unique properties, and rural areas.' },
];

// ---------- buyer-side constants ----------
const B_FINANCING = ['Cash', 'Conventional', 'FHA', 'VA', 'USDA', 'Not sure'];
const B_LENDER = ['Yes — preapproved', 'Yes — prequalified', 'Yes — in conversations', 'No — not yet', "No — I'd like a recommendation"];
const B_DOWN = ['Under 5%', '5–10%', '10–20%', '20%+', 'Cash purchase'];
const B_SITUATION = ['Rent', 'Own', 'Live with family', 'Other'];
const B_SELL_FIRST = ['No', 'Yes — not started', 'Yes — already listed', 'Yes — under contract'];
const B_TIMELINE = ['ASAP', 'Within 30 days', '1–3 months', '3–6 months', '6–12 months', 'Just researching'];
const B_PURPOSE = ['Primary residence', 'Second home', 'Investment'];
const B_BBA = ['No', "Yes — it's expired or cancelled", 'Yes — currently active'];
// Expected home tours (Paul, Sep 1 UX #1): the BUYER's estimate, asked in the
// request — an estimate only, never a contractual limit on showings.
const B_EXPECTED_TOURS = ['1–5 homes', '6–10 homes', '11–15 homes', '16–20 homes', 'More than 20', 'Not sure yet'];
const B_PRIORITIES = ['Schools', 'Commute', 'Yard/lot size', 'Main-level living', 'Updated/move-in ready', 'Fixer-upper potential', 'New construction', 'Quiet neighborhood', 'Walkability', 'Views', 'Room to grow', 'Investment value'];
// Buyer proposals: two structures only (Paul, Aug 11 — hourly/retainer removed
// from the FORM for simplicity; legacy rows still display via buyerFeeLabel).
const BP_STRUCTURES = { pct: 'Percentage at closing', flat: 'Flat fee at closing' };
// License states for professional verification (Paul, Aug 29): code + name,
// Utah first because it's the active Connexli market. NOT derived from ZIPs.
const LICENSE_STATES = [
  ['UT','Utah'],['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],['TN','Tennessee'],['TX','Texas'],['VT','Vermont'],['VA','Virginia'],['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
];
const LICENSE_STATE_CODES = LICENSE_STATES.map(s => s[0]);

// For the relocating-buyer "moving from" dropdown (standardized, no free text).
const US_STATES = ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','District of Columbia','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming','Other / outside the U.S.'];
const BP_TOURS = ['Up to 5 tours included', 'Up to 10 tours included', 'Up to 20 tours included', 'Unlimited tours'];
const BP_RESPONSE = ['Within 1 hour', 'Same day', 'Within 24 hours'];
const BP_SPECIALTIES = ['First-time buyers', 'VA/FHA', 'New construction', 'Relocation', 'Investment', 'Luxury'];

// Readiness badge, computed from Step-1 answers. Never rejects — sorts.
function readiness(p) {
  const preapproved = p.financing_type === 'Cash' || p.lender_status === 'Yes — preapproved';
  const nearTerm = ['ASAP', 'Within 30 days', '1–3 months'].includes(p.timeline);
  const researching = ['6–12 months', 'Just researching'].includes(p.timeline);
  const noLender = ['No — not yet', "No — I'd like a recommendation"].includes(p.lender_status);
  const mustSellUnstarted = p.need_to_sell === 'Yes — not started';
  if (preapproved && nearTerm && !mustSellUnstarted) return 'ready_now';
  if (!preapproved && ((noLender && researching) || p.timeline === 'Just researching')) return 'exploring';
  return 'preparing';
}
const READINESS_LABELS = { ready_now: 'Ready Now', preparing: 'Preparing', exploring: 'Exploring' };

// Label for a buyer proposal's fee structure.
function buyerFeeLabel(p) {
  const amt = parseFloat(p.comp_amount);
  if (p.comp_structure === 'pct') return amt + '% at closing';
  if (p.comp_structure === 'flat') return money(amt) + ' flat fee';
  if (p.comp_structure === 'hourly') return money(amt) + '/hour';
  return money(amt) + ' retainer, credited at closing';
}

function midPrice(range) { return PRICE_RANGES[range] || 875000; }

// Estimated buyer-agent fee at the midpoint of the buyer's price range.
function estBuyerFee(p, priceRange) {
  const amt = parseFloat(p.comp_amount);
  if (p.comp_structure === 'pct') return midPrice(priceRange) * amt / 100;
  if (p.comp_structure === 'flat') return amt;
  return null; // hourly/retainer legacy rows: no midpoint estimate
}

// ---------- standardized Utah city data (Paul, Aug 14) ----------
// Built once at boot from the same ZIP database the mailer uses. Each city
// carries a representative lat/lng so buyer locations become real geography
// instead of free text.
// The ZIP database uses USPS "preferred" names, which folds many real,
// incorporated Utah cities into their metro's name (Murray, Taylorsville,
// Millcreek etc. are all labeled "Salt Lake City"). Since the picker is now
// strict — only listed cities can be selected — those cities must be added
// back explicitly. Each maps to a representative ZIP for its coordinates.
const UT_EXTRA_CITIES = {
  // Salt Lake County
  'Murray': '84107', 'Millcreek': '84106', 'Taylorsville': '84129', 'Holladay': '84117',
  'West Valley City': '84119', 'Cottonwood Heights': '84121', 'Kearns': '84118',
  'South Salt Lake': '84115', 'Bluffdale': '84065', 'White City': '84070',
  // Weber County
  'North Ogden': '84414', 'South Ogden': '84405', 'Pleasant View': '84414',
  'West Haven': '84401', 'Washington Terrace': '84405', 'Riverdale': '84405',
  'Farr West': '84404', 'Plain City': '84404', 'Harrisville': '84404',
  'Uintah': '84405', 'Marriott-Slaterville': '84404',
  // Davis County
  'Clinton': '84015', 'Sunset': '84015', 'West Point': '84015',
  'Fruit Heights': '84037', 'South Weber': '84405',
  // Utah County
  'Vineyard': '84059', 'Cedar Hills': '84062', 'Highland': '84003',
  'Elk Ridge': '84651', 'Woodland Hills': '84653',
  // Wasatch / Summit
  'Charleston': '84032', 'Daniel': '84032', 'Francis': '84036', 'Hideout': '84036',
};

const UT_CITY_INDEX = (() => {
  const map = new Map();
  for (const zip of Object.keys(zipcodes.codes)) {
    const c = zipcodes.codes[zip];
    if (c && c.state === 'UT' && c.city && !map.has(c.city.toLowerCase())) {
      map.set(c.city.toLowerCase(), { name: c.city, state: 'UT', lat: c.latitude, lng: c.longitude });
    }
  }
  for (const [name, zip] of Object.entries(UT_EXTRA_CITIES)) {
    if (map.has(name.toLowerCase())) continue;
    const c = zipcodes.lookup(zip);
    if (c) map.set(name.toLowerCase(), { name, state: 'UT', lat: c.latitude, lng: c.longitude });
  }
  // Everyone writes "St. George"; the dataset says "Saint George". Show the
  // common spelling and accept both when looking a name up.
  const sg = map.get('saint george');
  if (sg) { sg.name = 'St. George'; map.set('st. george', sg); map.set('st george', sg); }
  return map;
})();
const UT_CITIES = [...new Set([...UT_CITY_INDEX.values()])].map(c => c.name).sort();
function utCity(name) { return UT_CITY_INDEX.get(String(name || '').trim().toLowerCase()) || null; }

// Great-circle distance in miles between two lat/lng points.
function geoMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8, toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Window state helpers shared by seller requests and buyer profiles.
function windowOpen(row) {
  return new Date(row.closes_at).getTime() > Date.now() && row.proposal_count < row.proposal_cap;
}
function spotsLeft(row) { return Math.max(0, row.proposal_cap - row.proposal_count); }
function takenThisRound(row) { return Math.max(0, row.proposal_count - (row.proposal_cap - 10)); }

function money(n) { return '$' + Math.round(n).toLocaleString('en-US'); }

function estFee(proposal, priceRange) {
  const amt = parseFloat(proposal.fee_amount);
  return proposal.fee_type === 'pct' ? midPrice(priceRange) * amt / 100 : amt;
}

function feeLabel(proposal) {
  const amt = parseFloat(proposal.fee_amount);
  return proposal.fee_type === 'pct' ? amt + '%' : money(amt) + ' flat';
}

// Basic input guards
function clean(s, max = 200) { return String(s || '').trim().slice(0, max); }
function oneOf(value, list, fallback) { return list.includes(value) ? value : fallback; }

module.exports = {
  PROPERTY_TYPES, BEDS, BATHS, SQFT, YEARS, CONDITIONS, PRIORITIES, SERVICES,
  CANCELLATION, PRICE_RANGES, WINDOWS, ROUND_CAP,
  B_FINANCING, B_LENDER, B_DOWN, B_SITUATION, B_SELL_FIRST, B_TIMELINE,
  B_PURPOSE, B_BBA, B_PRIORITIES, B_EXPECTED_TOURS, BP_STRUCTURES, BP_TOURS, BP_RESPONSE, BP_SPECIALTIES, US_STATES,
  readiness, READINESS_LABELS, buyerFeeLabel,
  midPrice, money, estFee, feeLabel, clean, oneOf,
  estBuyerFee, windowOpen, spotsLeft, takenThisRound,
  UT_CITIES, utCity, geoMiles,
  LICENSE_STATES, LICENSE_STATE_CODES,
};
