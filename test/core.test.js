// Node harness for core.js — shim the browser globals it expects.
const fs = require('fs');
const path = require('path').join(__dirname, '..', 'js', 'core.js');

const store = {};
global.window = global;
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};

eval(fs.readFileSync(path, 'utf8'));
const LT = global.LT;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  FAIL: ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
     `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

console.log('TZ =', Intl.DateTimeFormat().resolvedOptions().timeZone);

/* --- date helpers --------------------------------------------------- */
eq('toKey pads', LT.toKey(new Date(2026, 0, 5)), '2026-01-05');
eq('fromKey roundtrip', LT.toKey(LT.fromKey('1998-03-15')), '1998-03-15');
eq('dayDiff same day', LT.dayDiff(new Date(2026, 6, 27), new Date(2026, 6, 27)), 0);
eq('dayDiff forward', LT.dayDiff(new Date(2026, 6, 27), new Date(2026, 7, 3)), 7);
eq('dayDiff backward', LT.dayDiff(new Date(2026, 6, 27), new Date(2026, 6, 20)), -7);

// US DST transitions (spring forward 2026-03-08, fall back 2026-11-01).
eq('dayDiff over spring DST', LT.dayDiff(new Date(2026, 2, 7), new Date(2026, 2, 9)), 2);
eq('dayDiff over fall DST', LT.dayDiff(new Date(2026, 9, 31), new Date(2026, 10, 2)), 2);
// India (user's likely TZ) has no DST, but a half-hour offset — check anyway.
eq('dayDiff across a year', LT.dayDiff(new Date(2024, 0, 1), new Date(2025, 0, 1)), 366);

/* --- life years ------------------------------------------------------ */
const dob = LT.fromKey('1998-03-15');
eq('daysInLifeYear normal', LT.daysInLifeYear(dob, 0), 365);
// 1999-03-15 -> 2000-03-15 spans 2000-02-29.
eq('daysInLifeYear leap', LT.daysInLifeYear(dob, 1), 366);

eq('lifePosition on birthday', LT.lifePosition(dob, LT.fromKey('2020-03-15')),
   { age: 22, dayOfYear: 0, week: 0, month: 0 });
eq('lifePosition day before birthday', LT.lifePosition(dob, LT.fromKey('2020-03-14')).age, 21);
eq('lifePosition before birth', LT.lifePosition(dob, LT.fromKey('1998-03-14')), null);
eq('lifePosition day of birth', LT.lifePosition(dob, LT.fromKey('1998-03-15')).dayOfYear, 0);

// Week clamping: day 364 and 365 must fold into week 51, not spill to 52.
eq('week clamp d363', LT.lifePosition(dob, LT.addDays(LT.anniversary(dob, 1), 363)).week, 51);
eq('week clamp d364', LT.lifePosition(dob, LT.addDays(LT.anniversary(dob, 1), 364)).week, 51);
eq('week clamp d365', LT.lifePosition(dob, LT.addDays(LT.anniversary(dob, 1), 365)).week, 51);
eq('month clamp d365', LT.lifePosition(dob, LT.addDays(LT.anniversary(dob, 1), 365)).month, 11);

// Every day of a life-year must land in a valid bucket.
let badBucket = null;
for (let age = 0; age < 90 && !badBucket; age++) {
  const n = LT.daysInLifeYear(dob, age);
  for (let d = 0; d < n; d++) {
    const p = LT.lifePosition(dob, LT.addDays(LT.anniversary(dob, age), d));
    if (p.age !== age || p.week < 0 || p.week > 51 || p.month < 0 || p.month > 11) {
      badBucket = { age, d, p }; break;
    }
  }
}
ok('every life-day maps to a valid week+month bucket', badBucket === null, JSON.stringify(badBucket));

/* --- week -> month mapping ------------------------------------------- */
const perMonth = new Array(12).fill(0);
for (let w = 0; w < 52; w++) perMonth[LT.monthOfWeek(w)]++;
eq('all 52 weeks assigned', perMonth.reduce((a, b) => a + b, 0), 52);
ok('every month owns 4 or 5 weeks', perMonth.every(c => c === 4 || c === 5), perMonth.join(','));
let monotonic = true;
for (let w = 1; w < 52; w++) if (LT.monthOfWeek(w) < LT.monthOfWeek(w - 1)) monotonic = false;
ok('week -> month is monotonic', monotonic);

/* --- verdict --------------------------------------------------------- */
eq('verdict blank', LT.verdict(0, 0), null);
eq('verdict good', LT.verdict(3, 1), 'good');
eq('verdict bad', LT.verdict(1, 3), 'bad');
eq('verdict tie', LT.verdict(2, 2), 'tie');
eq('verdict single good', LT.verdict(1, 0), 'good');

/* --- aggregation ----------------------------------------------------- */
function build(entries, lifespan = 90) {
  return LT.sanitize({ version: 1, dob: '1998-03-15', lifespan, palette: 'classic', entries });
}
const anniv30 = LT.anniversary(dob, 30);
const day = n => LT.toKey(LT.addDays(anniv30, n));

// Week 0 of age 30: 4 good, 3 bad -> good.
let s = build({
  [day(0)]: 'good', [day(1)]: 'good', [day(2)]: 'good', [day(3)]: 'good',
  [day(4)]: 'bad', [day(5)]: 'bad', [day(6)]: 'bad'
});
let a = LT.aggregate(s);
eq('week tally', [a.weeks[30][0].good, a.weeks[30][0].bad], [4, 3]);
eq('week verdict', a.weeks[30][0].mark, 'good');
eq('month sees one good week', [a.months[30][0].good, a.months[30][0].bad], [1, 0]);
eq('month verdict from weeks', a.months[30][0].mark, 'good');
eq('year verdict from months', a.years[30].mark, 'good');
eq('untouched year is blank', a.years[31].mark, null);
eq('untouched week is blank', a.weeks[30][5].mark, null);

// A month is decided by week verdicts, not raw day counts. Weeks 0-3 belong to
// month 0: make three of them green with 1 day each, and one red with 20 days.
const e = {};
[0, 7, 14].forEach(w => { e[day(w)] = 'good'; });
for (let d = 21; d < 28; d++) e[day(d)] = 'bad';
a = LT.aggregate(build(e));
eq('weeks 0-2 green', [a.weeks[30][0].mark, a.weeks[30][1].mark, a.weeks[30][2].mark],
   ['good', 'good', 'good']);
eq('week 3 red', a.weeks[30][3].mark, 'bad');
eq('month counts weeks not days', [a.months[30][0].good, a.months[30][0].bad], [3, 1]);
eq('month is green despite 7 bad days vs 3 good', a.months[30][0].mark, 'good');

// Tie propagation: a tied week must not count toward its month.
a = LT.aggregate(build({ [day(0)]: 'good', [day(1)]: 'bad' }));
eq('tied week', a.weeks[30][0].mark, 'tie');
eq('tied week excluded from month', [a.months[30][0].good, a.months[30][0].bad], [0, 0]);
eq('month blank when only tied weeks', a.months[30][0].mark, null);

// Out-of-range entries must not crash or leak into the grid.
a = LT.aggregate(build({ '1990-01-01': 'good', '2500-01-01': 'bad', [day(0)]: 'good' }));
eq('pre-birth and past-lifespan entries ignored', a.years[30].mark, 'good');
ok('no NaN buckets', a.years.every(y => Number.isInteger(y.good) && Number.isInteger(y.bad)));

// Lifespan resize must not read past the array.
a = LT.aggregate(build({ [day(0)]: 'good' }, 10));
eq('short lifespan array length', a.years.length, 10);

/* --- stats ----------------------------------------------------------- */
const today = LT.today();
const t = n => LT.toKey(LT.addDays(today, n));

let st = LT.stats(build({ [t(0)]: 'good', [t(-1)]: 'good', [t(-2)]: 'good', [t(-3)]: 'bad' }));
eq('logged count', st.logged, 4);
eq('good count', st.good, 3);
eq('good percent', st.goodPercent, 75);
eq('current streak', [st.current.mark, st.current.length], ['good', 3]);
eq('longest good', st.longestGood, 3);
eq('longest bad', st.longestBad, 1);

// Today blank but yesterday logged -> streak still counts.
st = LT.stats(build({ [t(-1)]: 'bad', [t(-2)]: 'bad' }));
eq('streak from yesterday', [st.current.mark, st.current.length], ['bad', 2]);

// A gap breaks the streak.
st = LT.stats(build({ [t(-3)]: 'good', [t(-4)]: 'good' }));
eq('stale streak is zero', st.current.length, 0);

// Non-contiguous days must not merge into one run.
st = LT.stats(build({ [t(-10)]: 'good', [t(-20)]: 'good', [t(-30)]: 'good' }));
eq('gapped days are separate runs', st.longestGood, 1);

eq('empty stats', LT.stats(build({})).goodPercent, 0);
eq('empty streak', LT.stats(build({})).current.length, 0);

/* --- sanitize -------------------------------------------------------- */
eq('rejects junk marks', Object.keys(LT.sanitize({ entries: { '2026-01-01': 'purple' } }).entries).length, 0);
eq('rejects junk keys', Object.keys(LT.sanitize({ entries: { 'yesterday': 'good' } }).entries).length, 0);
eq('rejects bad dob', LT.sanitize({ dob: '15-03-1998' }).dob, null);
eq('accepts good dob', LT.sanitize({ dob: '1998-03-15' }).dob, '1998-03-15');
eq('clamps lifespan', LT.sanitize({ lifespan: 500 }).lifespan, 90);
eq('null input is safe', LT.sanitize(null).lifespan, 90);
eq('defaults are isolated', (() => {
  const one = LT.defaultState(); one.entries.x = 'good';
  return Object.keys(LT.defaultState().entries).length;
})(), 0);

/* --- storage --------------------------------------------------------- */
const saved = build({ [day(0)]: 'good' });
LT.save(saved);
eq('save/load roundtrip', LT.load().entries[day(0)], 'good');

/* --- Feb 29 birthday ------------------------------------------------- */
const leapDob = LT.fromKey('2000-02-29');
eq('feb29 anniversary in non-leap year rolls to Mar 1',
   LT.toKey(LT.anniversary(leapDob, 1)), '2001-03-01');
eq('feb29 age on Mar 1 2001', LT.lifePosition(leapDob, LT.fromKey('2001-03-01')).age, 1);
ok('feb29 life years are all 365 or 366',
   [0, 1, 2, 3, 4, 5].every(n => [365, 366].includes(LT.daysInLifeYear(leapDob, n))),
   [0, 1, 2, 3, 4, 5].map(n => LT.daysInLifeYear(leapDob, n)).join(','));

/* --- phases ---------------------------------------------------------- */
const P = LT.DEFAULT_PHASES;
eq('phaseAt start of range', LT.phaseAt(P, 0).label, 'Childhood');
eq('phaseAt inside range', LT.phaseAt(P, 25).label, 'Twenties');
// Ranges are half-open, so the boundary age belongs to the *next* phase.
eq('phaseAt boundary goes to next phase', LT.phaseAt(P, 13).label, 'Teenage');
eq('phaseAt end boundary', LT.phaseAt(P, 20).label, 'College');
eq('phaseAt past the last phase', LT.phaseAt(P, 200), null);
eq('phaseAt with no phases', LT.phaseAt([], 5), null);
eq('phaseAt tolerates null', LT.phaseAt(null, 5), null);

// Defaults must not overlap, or a year would belong to two phases.
let overlap = null;
for (let i = 1; i < P.length; i++) if (P[i].from < P[i - 1].to) overlap = [P[i - 1], P[i]];
ok('default phases do not overlap', overlap === null, JSON.stringify(overlap));

// Overlapping user phases: first (earliest-starting) wins, deterministically.
const overlapping = LT.cleanPhases([
  { label: 'late', from: 20, to: 40, color: '#111111' },
  { label: 'early', from: 10, to: 30, color: '#222222' }
]);
eq('overlaps sorted by start', overlapping.map(p => p.label), ['early', 'late']);
eq('first match wins on overlap', LT.phaseAt(overlapping, 25).label, 'early');

eq('cleanPhases rejects from >= to', LT.cleanPhases([{ label: 'x', from: 9, to: 9 }]).length, 0);
eq('cleanPhases rejects negative', LT.cleanPhases([{ label: 'x', from: -5, to: 9 }]).length, 0);
eq('cleanPhases rejects beyond 130', LT.cleanPhases([{ label: 'x', from: 0, to: 999 }]).length, 0);
eq('cleanPhases rejects non-array', LT.cleanPhases('nope'), null);
eq('cleanPhases caps at 20', LT.cleanPhases(
  Array.from({ length: 40 }, (_, i) => ({ label: 'p' + i, from: i, to: i + 1 }))).length, 20);
eq('cleanPhases defaults a bad colour',
   LT.cleanPhases([{ label: 'x', from: 0, to: 9, color: 'octarine' }])[0].color, '#8a7f6e');
eq('cleanPhases keeps a good colour',
   LT.cleanPhases([{ label: 'x', from: 0, to: 9, color: '#Ab12Cd' }])[0].color, '#Ab12Cd');
eq('cleanPhases truncates a long label',
   LT.cleanPhases([{ label: 'z'.repeat(200), from: 0, to: 9 }])[0].label.length, 40);
eq('cleanPhases coerces numeric strings',
   LT.cleanPhases([{ label: 'x', from: '3', to: '7' }])[0].from, 3);

/* --- phase stats ------------------------------------------------------ */
{
  const dobKey = '1998-03-15';
  const at = (age, dayOffset) =>
    LT.toKey(LT.addDays(LT.anniversary(LT.fromKey(dobKey), age), dayOffset));

  const st = LT.sanitize({
    dob: dobKey,
    phases: [
      { label: 'A', from: 0, to: 10, color: '#111111' },
      { label: 'B', from: 20, to: 30, color: '#222222' }
    ],
    entries: {
      [at(5, 0)]: 'good', [at(5, 1)]: 'good', [at(5, 2)]: 'bad',
      [at(25, 0)]: 'bad',
      [at(15, 0)]: 'good'   // falls in the gap between phases
    }
  });

  const buckets = LT.phaseStats(st);
  eq('one bucket per phase', buckets.length, 2);
  eq('phase A tallies', [buckets[0].good, buckets[0].bad, buckets[0].logged], [2, 1, 3]);
  eq('phase A good percent', buckets[0].goodPercent, 67);
  eq('phase B tallies', [buckets[1].good, buckets[1].bad, buckets[1].logged], [0, 1, 1]);
  ok('days in a gap belong to no phase',
     buckets[0].logged + buckets[1].logged === 4);

  eq('phaseStats with no dob is empty but shaped',
     LT.phaseStats(LT.sanitize({ phases: [{ label: 'A', from: 0, to: 5 }] }))[0].logged, 0);
  eq('phaseStats with no phases', LT.phaseStats(LT.sanitize({ dob: dobKey, phases: [] })).length, 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
