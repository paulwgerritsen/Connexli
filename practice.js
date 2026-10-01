// practice.js — the fictional consumer requests behind the professional
// Practice Proposal Center (Paul, Sep 30).
//
// Everything here is MADE UP and lives only in memory. Nothing is ever
// written to the database: no request, no buyer profile, no proposal, no
// credit, no email, no event. See routes/practice.js.
//
// Every answer is picked from the SAME option lists the live consumer forms
// use (helpers.js). If one of those lists changes later, pick() falls back
// to a currently valid option, so the sample always matches the live forms.
const H = require('./helpers');

function pick(list, preferred) {
  return list.includes(preferred) ? preferred : list[0];
}

// A homeowner in Farmington looking for a listing agent. Same fields a real
// seller enters on "Tell us about the home you may sell" — including the new
// listing timeline, and without the retired "What matters most?" question or
// any proposal-window choice.
function sampleSellerRequest() {
  return {
    id: 0,
    practice: true,
    property_type: pick(H.PROPERTY_TYPES, 'Single Family'),
    zip: '84025',
    city: 'Farmington',
    neighborhood: 'East side, near the foothills',
    beds: pick(H.BEDS, '4'),
    baths: pick(H.BATHS, '3'),
    sqft_range: pick(H.SQFT, '3,000–4,000'),
    year_built: pick(H.YEARS, '2000–2009'),
    hoa: 'No',
    condition: pick(H.CONDITIONS, 'Updated'),
    price_range: pick(Object.keys(H.PRICE_RANGES), '$750k–$1M'),
    listing_timeline: pick(H.SELLER_TIMELINE, '1–3 months'),
    comp_ack: 'yes',
    window_hours: H.ROUND_WINDOW_HOURS,
    proposal_cap: H.ROUND_CAP,
    round: 1,
    status: 'open',
  };
}

// A first-time buyer looking for a buyer's agent. Same fields a real buyer
// enters: the buyer profile form, plus the optional "Boost your profile"
// answers. No new buyer fields are invented for practice.
function sampleBuyerProfile() {
  const cities = ['Lehi', 'American Fork', 'Saratoga Springs'].filter(c => H.utCity(c));
  const p = {
    id: 0,
    practice: true,
    financing_type: pick(H.B_FINANCING, 'Conventional'),
    lender_status: pick(H.B_LENDER, 'Yes — preapproved'),
    down_payment: pick(H.B_DOWN, '10–20%'),
    current_situation: pick(H.B_SITUATION, 'Rent'),
    need_to_sell: pick(H.B_SELL_FIRST, 'No'),
    search_areas: (cities.length ? cities : [H.UT_CITIES[0]]).join(', '),
    price_range: pick(Object.keys(H.PRICE_RANGES), '$500k–$750k'),
    timeline: pick(H.B_TIMELINE, '1–3 months'),
    expected_tours: pick(H.B_EXPECTED_TOURS, '6–10 homes'),
    purchase_purpose: pick(H.B_PURPOSE, 'Primary residence'),
    in_utah: true,
    origin_state: null,
    move_reason: '',
    visit_dates: '',
    video_tours: false,
    bba: pick(H.B_BBA, 'No'),
    bba_expires: '',
    window_hours: 48,
    // "Boost your profile" (optional step) answers:
    property_prefs: '3+ bedrooms, 2-car garage, fenced yard for our dog, built after 2000',
    priorities: ['Schools', 'Commute', 'Room to grow'].filter(x => H.B_PRIORITIES.includes(x)).join(' + '),
    availability: 'Weeknights after 6 and Saturdays',
    first_time: true,
    notes: "It's our first purchase, so we'd appreciate someone patient who explains each step.",
    proposal_cap: H.ROUND_CAP,
    round: 1,
    status: 'active',
    published: true,
  };
  p.readiness = H.readiness(p);
  return p;
}

// The buyer profile form stores a couple of answers differently from the
// database row (yes/no strings instead of true/false). This converts the
// sample into the shape views/buyer/new.ejs expects.
function buyerFormValues(p) {
  return { ...p, in_utah: p.in_utah ? 'yes' : 'no', video_tours: p.video_tours ? 'yes' : '' };
}

module.exports = { sampleSellerRequest, sampleBuyerProfile, buyerFormValues };
