// Sync-merge tests. The merge is a CRDT, so most of these are algebraic laws:
// if commutativity/associativity/idempotence hold, then any two devices that
// exchange states in any order and any number of times must converge.
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

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL: ' + name + (extra ? '  -> ' + extra : '')); }
}

// Canonical form, mirroring sync.js — comparison must not depend on key order.
function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
const same = (a, b) => canon(a) === canon(b);

function blank(overrides = {}) {
  return Object.assign(LT.defaultState(), overrides);
}

/* --- tombstones ------------------------------------------------------ */
{
  // Phone clears a day the laptop still has. The clear must win, not be undone.
  const phone = blank();
  LT.setEntry(phone, '2026-07-01', 'good');
  const laptop = JSON.parse(JSON.stringify(phone));   // both start in sync

  LT.setEntry(phone, '2026-07-01', null);             // cleared later
  const merged = LT.mergeStates(laptop, phone);

  ok('delete beats older write', !('2026-07-01' in merged.entries));
  ok('tombstone is retained', '2026-07-01' in merged.meta.entries);
  ok('delete survives re-merge', !('2026-07-01' in LT.mergeStates(merged, laptop).entries));
}

{
  // Reverse: a write *after* a delete must resurrect the day.
  const a = blank();
  LT.setEntry(a, '2026-07-02', 'good');
  const b = JSON.parse(JSON.stringify(a));
  LT.setEntry(a, '2026-07-02', null);      // a deletes
  LT.setEntry(b, '2026-07-02', 'bad');     // b rewrites, later stamp
  b.meta.entries['2026-07-02'] = a.meta.entries['2026-07-02'] + 10;

  const merged = LT.mergeStates(a, b);
  ok('later write beats delete', merged.entries['2026-07-02'] === 'bad');
}

/* --- the scenario that motivates all of this ------------------------- */
{
  // Log different days on each device while both are offline, then sync.
  const laptop = blank();
  const phone = blank();
  LT.setEntry(laptop, '2026-07-10', 'good');
  LT.setEntry(laptop, '2026-07-11', 'bad');
  LT.setEntry(phone, '2026-07-12', 'good');
  LT.setEntry(phone, '2026-07-13', 'bad');

  const merged = LT.mergeStates(laptop, phone);
  ok('offline edits on both devices all survive',
     Object.keys(merged.entries).length === 4,
     JSON.stringify(merged.entries));

  // Same day, different verdict — the later edit wins.
  const l2 = blank(), p2 = blank();
  LT.setEntry(l2, '2026-07-20', 'good');
  LT.setEntry(p2, '2026-07-20', 'bad');
  p2.meta.entries['2026-07-20'] = l2.meta.entries['2026-07-20'] + 1000;
  ok('same-day conflict resolves to the later edit',
     LT.mergeStates(l2, p2).entries['2026-07-20'] === 'bad');
  ok('...regardless of merge order',
     LT.mergeStates(p2, l2).entries['2026-07-20'] === 'bad');
}

/* --- settings are last-write-wins too -------------------------------- */
{
  const a = blank(), b = blank();
  LT.setSetting(a, 'lifespan', 80);
  LT.setSetting(b, 'lifespan', 100);
  b.meta.settings.lifespan = a.meta.settings.lifespan + 5;
  ok('newer setting wins', LT.mergeStates(a, b).lifespan === 100);
  ok('newer setting wins either way', LT.mergeStates(b, a).lifespan === 100);

  // A device that never set a DOB must adopt the one that did.
  const fresh = blank(), configured = blank();
  LT.setSetting(configured, 'dob', '1998-03-15');
  ok('unset dob adopts the configured one',
     LT.mergeStates(fresh, configured).dob === '1998-03-15');
  ok('...and does not clobber it in reverse',
     LT.mergeStates(configured, fresh).dob === '1998-03-15');
}

/* --- phases sync like any other setting ------------------------------ */
{
  const a = blank(), b = blank();
  LT.setSetting(a, 'phases', [{ label: 'Uni', from: 18, to: 22, color: '#111111' }]);
  LT.setSetting(b, 'phases', [{ label: 'Work', from: 22, to: 65, color: '#222222' }]);
  b.meta.settings.phases = a.meta.settings.phases + 10;

  ok('newer phase list wins', LT.mergeStates(a, b).phases[0].label === 'Work');
  ok('newer phase list wins either way', LT.mergeStates(b, a).phases[0].label === 'Work');
  ok('phase merge is order-independent',
     same(LT.mergeStates(a, b), LT.mergeStates(b, a)));

  // Clearing every phase must propagate, not fall back to the defaults.
  const cleared = blank(), keeps = blank();
  LT.setSetting(keeps, 'phases', [{ label: 'X', from: 0, to: 5, color: '#333333' }]);
  LT.setSetting(cleared, 'phases', []);
  cleared.meta.settings.phases = keeps.meta.settings.phases + 10;
  ok('an empty phase list syncs as a real value',
     LT.mergeStates(keeps, cleared).phases.length === 0);
}

/* --- migration must never delete ------------------------------------- */
{
  // A v1 export has no meta at all. Merging it with a populated device must be
  // a pure union: no stamps means no tombstones means nothing can be removed.
  const v1 = { version: 1, dob: '1998-03-15', lifespan: 90, palette: 'classic',
               entries: { '2020-01-01': 'good', '2020-01-02': 'bad' } };

  const device = blank();
  LT.setEntry(device, '2021-05-05', 'good');

  const merged = LT.mergeStates(device, v1);
  ok('v1 import is a union, never a delete',
     Object.keys(merged.entries).length === 3, JSON.stringify(merged.entries));
  ok('v1 entries get stamped on migration',
     typeof LT.sanitize(v1).meta.entries['2020-01-01'] === 'number');
  ok('v1 migration creates no tombstones',
     Object.keys(LT.sanitize(v1).meta.entries).length === 2);
}

/* --- empty-device cases ---------------------------------------------- */
{
  const populated = blank();
  LT.setEntry(populated, '2026-01-01', 'good');
  LT.setSetting(populated, 'dob', '1998-03-15');

  ok('new device pulls everything down',
     same(LT.mergeStates(blank(), populated), populated));
  ok('empty gist receives everything',
     same(LT.mergeStates(populated, blank()), populated));
  ok('two empties stay empty',
     Object.keys(LT.mergeStates(blank(), blank()).entries).length === 0);
}

/* --- the CRDT laws --------------------------------------------------- */
function randomState(seed) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const state = blank();

  const days = 40;
  for (let i = 0; i < days; i++) {
    if (rnd() < 0.45) continue;
    const key = '2026-' + String(1 + (i % 12)).padStart(2, '0') + '-' +
                String(1 + (i % 28)).padStart(2, '0');
    // Force stamp collisions so the tiebreak path is genuinely exercised.
    const mark = rnd() < 0.5 ? 'good' : 'bad';
    LT.setEntry(state, key, rnd() < 0.15 ? null : mark);
    state.meta.entries[key] = Math.floor(rnd() * 8) + 1;
  }
  if (rnd() < 0.5) { LT.setSetting(state, 'dob', '199' + (i => i)(8) + '-03-15'); }
  if (rnd() < 0.5) { LT.setSetting(state, 'lifespan', 70 + Math.floor(rnd() * 40)); }
  state.meta.settings.lifespan = Math.floor(rnd() * 8) + 1;
  return state;
}

let commutative = 0, idempotent = 0, associative = 0, convergent = 0;
const TRIALS = 400;

for (let i = 0; i < TRIALS; i++) {
  const a = randomState(i * 7919 + 1);
  const b = randomState(i * 104729 + 3);
  const c = randomState(i * 15485863 + 5);

  if (same(LT.mergeStates(a, b), LT.mergeStates(b, a))) commutative++;
  if (same(LT.mergeStates(a, a), LT.sanitize(a))) idempotent++;
  if (same(LT.mergeStates(LT.mergeStates(a, b), c),
           LT.mergeStates(a, LT.mergeStates(b, c)))) associative++;

  // Simulate a real gossip round: two devices exchange in opposite orders and
  // must still land on identical state.
  const deviceA = LT.mergeStates(LT.mergeStates(a, c), b);
  const deviceB = LT.mergeStates(LT.mergeStates(b, a), c);
  if (same(deviceA, deviceB)) convergent++;
}

ok(`commutative (${commutative}/${TRIALS})`, commutative === TRIALS);
ok(`idempotent (${idempotent}/${TRIALS})`, idempotent === TRIALS);
ok(`associative (${associative}/${TRIALS})`, associative === TRIALS);
ok(`devices converge regardless of gossip order (${convergent}/${TRIALS})`, convergent === TRIALS);

/* --- hybrid logical clock -------------------------------------------- */
{
  const state = blank();
  const first = LT.nextStamp(state);
  const second = LT.nextStamp(state);
  ok('stamps strictly increase', second > first);

  // A device whose clock is years behind must still issue stamps that beat
  // what it has already seen, or it would lose every conflict forever.
  //
  // Capture the future stamp once. Calling Date.now() again for the comparison
  // makes the threshold 1ms higher whenever the clock ticks mid-test, which
  // failed roughly 1 run in 15 for no reason at all.
  const slow = blank();
  const observed = Date.now() + 5 * 365 * 864e5;
  LT.observeStamp(slow, observed);
  ok('stamp beats an observed future clock', LT.nextStamp(slow) > observed);

  const behind = blank();
  behind.meta.hlc = 0;
  ok('normal clock uses wall time', Math.abs(LT.nextStamp(behind) - Date.now()) < 1000);
}

/* --- merge output is always a valid state ---------------------------- */
{
  const junk = { entries: { 'nope': 'good', '2026-01-01': 'purple' },
                 meta: { entries: { 'bad-key': 5, '2026-01-01': 'NaN' }, hlc: 'x' },
                 lifespan: 9999, dob: 'nonsense', palette: 'rainbow' };
  const merged = LT.mergeStates(blank(), junk);
  ok('junk entries dropped', Object.keys(merged.entries).length === 0);
  ok('junk meta dropped', Object.keys(merged.meta.entries).length === 0);
  ok('junk lifespan rejected', merged.lifespan === 90);
  ok('junk dob rejected', merged.dob === null);
  ok('junk palette rejected', merged.palette === 'classic');
  ok('hlc is numeric', typeof merged.meta.hlc === 'number' && isFinite(merged.meta.hlc));

  // Aggregation must still work on a merged state — this is the whole point.
  const real = blank();
  LT.setSetting(real, 'dob', '1998-03-15');
  LT.setEntry(real, '2026-07-01', 'good');
  const agg = LT.aggregate(LT.mergeStates(real, blank()));
  ok('merged state still aggregates', agg.years.length === 90 && agg.weeks[28].length === 52);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
