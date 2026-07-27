// The backfill generator invents days under a verdict you remember. The whole
// point is that the invented days aggregate to that verdict, so these tests run
// the generator across many seeds, dates of birth and specs, and check the
// result through the app's real LT.aggregate every time.
const fs = require('fs');
const path = require('path');

const store = {};
global.window = global;
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'core.js'), 'utf8'));
const LT = global.LT;

const { backfill, verify, parseSpec, assign, rng } = require('../tools/backfill.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL: ' + name + (extra ? '  -> ' + extra : '')); }
}

/* --- spec parsing ----------------------------------------------------- */
{
  const spec = parseSpec('0-14:tie,15-16:good,17:bad,18-19:good,20-21:bad');
  ok('covers every age in the ranges', spec.size === 22, String(spec.size));
  ok('range expands', spec.get(0) === 'tie' && spec.get(14) === 'tie');
  ok('single age', spec.get(17) === 'bad');
  ok('later range', spec.get(20) === 'bad' && spec.get(21) === 'bad');
  ok('blank becomes null', parseSpec('3:blank').get(3) === null);

  let threw = false;
  try { parseSpec('5:excellent'); } catch (e) { threw = true; }
  ok('rejects an unknown verdict', threw);

  threw = false;
  try { parseSpec('9-4:good'); } catch (e) { threw = true; }
  ok('rejects a backwards range', threw);
}

/* --- assign() honours the majority rule ------------------------------- */
{
  const rnd = rng(12345);
  let bad = null;

  for (let i = 0; i < 3000 && !bad; i++) {
    const total = 4 + (i % 9);                       // 4..12 slots
    const target = ['good', 'bad', 'tie'][i % 3];
    const out = assign(target, total, rnd, i % 2 === 0);

    const g = out.filter(v => v === 'good').length;
    const b = out.filter(v => v === 'bad').length;
    const verdict = LT.verdict(g, b);

    if (verdict !== target) bad = { target, total, g, b, verdict };
    if (out.length !== total) bad = { lengthMismatch: out.length, total };
  }
  ok('assign always produces the verdict asked for', bad === null, JSON.stringify(bad));

  ok('a blank target produces no marks',
     assign(null, 8, rnd, true).every(v => v === null));
  ok('days never get a tie',
     assign('good', 7, rnd, false).every(v => v === 'good' || v === 'bad' || v === null));
}

/* --- end to end, across dates of birth and seeds ---------------------- */
{
  const spec = parseSpec('0-14:tie,15-16:good,17:bad,18-19:good,20-21:bad');
  const births = [
    '1998-03-15',
    '2000-02-29',   // leap day: anniversaries roll to 1 March in common years
    '1996-12-31',   // year boundary
    '1999-01-01',
    '1997-06-30'
  ];

  let failures = [];
  births.forEach(dob => {
    for (let seed = 1; seed <= 25; seed++) {
      const { state } = backfill(dob, spec, seed * 7919);
      const { rows, failures: f } = verify(state, spec);
      if (f) failures.push({ dob, seed, rows: rows.filter(r => !r.ok) });
    }
  });
  ok(`125 generated lives all aggregate correctly (${births.length} dates x 25 seeds)`,
     failures.length === 0, JSON.stringify(failures.slice(0, 2)));
}

/* --- the generated state is valid app data ---------------------------- */
{
  const spec = parseSpec('0-14:tie,15-16:good,17:bad,18-19:good,20-21:bad');
  const { state } = backfill('1998-03-15', spec, 42);

  ok('carries the date of birth', state.dob === '1998-03-15');
  ok('writes a meaningful number of days', Object.keys(state.entries).length > 2000,
     String(Object.keys(state.entries).length));

  // Survives the same sanitising an import goes through.
  const round = LT.sanitize(JSON.parse(JSON.stringify(state)));
  ok('survives sanitize unchanged',
     Object.keys(round.entries).length === Object.keys(state.entries).length);

  ok('every entry is good or bad',
     Object.values(state.entries).every(v => v === 'good' || v === 'bad'));
  ok('every key is a date', Object.keys(state.entries).every(k => /^\d{4}-\d{2}-\d{2}$/.test(k)));
  ok('every write is stamped',
     Object.keys(state.entries).every(k => typeof state.meta.entries[k] === 'number'));
  ok('creates no tombstones',
     Object.keys(state.meta.entries).length === Object.keys(state.entries).length);

  // Nothing may land before birth or after today.
  const dob = LT.fromKey('1998-03-15');
  const today = LT.today();
  ok('nothing before birth',
     Object.keys(state.entries).every(k => LT.dayDiff(dob, LT.fromKey(k)) >= 0));
  ok('nothing in the future',
     Object.keys(state.entries).every(k => LT.dayDiff(LT.fromKey(k), today) >= 0));

  // Untouched ages stay untouched, so a backfill cannot invent a year you
  // did not ask about.
  const agg = LT.aggregate(state);
  ok('ages outside the spec are left blank',
     agg.years.slice(22).every(y => y.mark === null));
}

/* --- merging with real data --------------------------------------------- */
{
  const spec = parseSpec('15:good');
  const { state } = backfill('1998-03-15', spec, 5);

  // A day the user logged themselves must win over an invented one.
  const key = Object.keys(state.entries)[0];
  const mine = LT.defaultState();
  LT.setSetting(mine, 'dob', '1998-03-15');
  LT.setEntry(mine, key, state.entries[key] === 'good' ? 'bad' : 'good');
  mine.meta.entries[key] = state.meta.entries[key] + 1000;   // logged later

  const merged = LT.mergeStates(state, mine);
  ok('a real entry beats an invented one', merged.entries[key] === mine.entries[key]);
  ok('the rest of the backfill survives the merge',
     Object.keys(merged.entries).length === Object.keys(state.entries).length);
}

/* --- determinism ------------------------------------------------------- */
{
  const spec = parseSpec('10-12:good');
  const a = backfill('1998-03-15', spec, 999).state;
  const b = backfill('1998-03-15', spec, 999).state;
  ok('same seed reproduces the same life',
     JSON.stringify(a.entries) === JSON.stringify(b.entries));

  const c = backfill('1998-03-15', spec, 1000).state;
  ok('a different seed gives a different life',
     JSON.stringify(a.entries) !== JSON.stringify(c.entries));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
