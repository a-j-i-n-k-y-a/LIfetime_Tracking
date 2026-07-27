#!/usr/bin/env node
/**
 * Backfill years you never logged.
 *
 * You remember a year as good, rough or somewhere in between; you do not
 * remember the individual Tuesdays. This invents plausible days underneath a
 * verdict you *do* remember, so the chart fills in without you inventing 8,000
 * moods by hand.
 *
 * The days are generated top-down — year verdict picks month verdicts, months
 * pick weeks, weeks pick days — rather than rolling dice per day and hoping the
 * average lands right. Then the result is run back through the app's own
 * LT.aggregate and checked against the spec, so the file cannot claim a year is
 * good while the chart would draw it rough.
 *
 * Only day entries are written. Weeks, months and years are derived by the app,
 * exactly as they are for days you logged yourself.
 *
 *   node tools/backfill.js --dob=1998-03-15 --out=backfill.json
 *   node tools/backfill.js --from=my-export.json --out=backfill.json
 *
 * Then use Import JSON in Settings. Imports merge, so anything you have already
 * logged wins over — and is never replaced by — invented data.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * Load the app's own logic, so the generator and the chart can never
 * disagree about which day belongs to which week.
 * ------------------------------------------------------------------ */

const store = {};
global.window = global;
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; }
};
eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'core.js'), 'utf8'));
const LT = global.LT;

/* ------------------------------------------------------------------ *
 * Args
 * ------------------------------------------------------------------ */

const args = {};
process.argv.slice(2).forEach(a => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
});

// What the user actually remembers, as "ages:verdict".
const DEFAULT_SPEC = '0-14:tie,15-16:good,17:bad,18-19:good,20-21:bad';

function parseSpec(text) {
  const spec = new Map();
  text.split(',').map(s => s.trim()).filter(Boolean).forEach(part => {
    const m = /^(\d+)(?:-(\d+))?:(good|bad|tie|blank)$/.exec(part);
    if (!m) throw new Error(`Cannot read "${part}". Expected e.g. 15-16:good`);
    const from = +m[1];
    const to = m[2] === undefined ? from : +m[2];
    if (to < from) throw new Error(`"${part}" ends before it starts`);
    for (let age = from; age <= to; age++) {
      spec.set(age, m[3] === 'blank' ? null : m[3]);
    }
  });
  return spec;
}

/** Deterministic PRNG, so the same seed reproduces the same life. */
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * Verdict assignment
 * ------------------------------------------------------------------ */

/**
 * Split `total` slots into verdicts that add up to `target` under the app's
 * rule (more good than bad wins; equal is a tie; undecided slots do not vote).
 *
 * `undecided` is what the leftover slots become — null at the day level, where
 * a blank simply means you did not log that day, and a mix higher up so a year
 * is not suspiciously fully-populated.
 */
function assign(target, total, rnd, allowTie) {
  const out = new Array(total).fill(null);
  if (!target || total === 0) return out;

  let good;
  let bad;

  if (target === 'tie') {
    // Needs an exact draw, so cap at half and mirror it.
    good = bad = 1 + Math.floor(rnd() * Math.floor(total / 2));
  } else {
    const maxLoser = Math.floor((total - 1) / 2);
    const loser = Math.floor(rnd() * (maxLoser + 1));
    const room = total - (2 * loser + 1);
    const winner = loser + 1 + Math.floor(rnd() * (room + 1));
    good = target === 'good' ? winner : loser;
    bad = target === 'good' ? loser : winner;
  }

  const marks = [];
  for (let i = 0; i < good; i++) marks.push('good');
  for (let i = 0; i < bad; i++) marks.push('bad');

  // Leftovers. A tie among the children is invisible to the parent, so it is
  // safe filler that keeps the lower zoom levels from looking empty.
  while (marks.length < total) {
    marks.push(allowTie && rnd() < 0.35 ? 'tie' : null);
  }

  // Fisher-Yates, so the good months are not all in January.
  for (let i = marks.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [marks[i], marks[j]] = [marks[j], marks[i]];
  }
  return marks;
}

/* ------------------------------------------------------------------ *
 * Generate
 * ------------------------------------------------------------------ */

function backfill(dobKey, spec, seed) {
  const rnd = rng(seed);
  const dob = LT.fromKey(dobKey);
  const today = LT.today();
  const state = LT.defaultState();
  LT.setSetting(state, 'dob', dobKey);

  // Which weeks belong to which month — straight from the app, not re-derived.
  const weeksByMonth = new Map();
  for (let w = 0; w < LT.WEEKS_PER_YEAR; w++) {
    const m = LT.monthOfWeek(w);
    if (!weeksByMonth.has(m)) weeksByMonth.set(m, []);
    weeksByMonth.get(m).push(w);
  }

  let written = 0;
  let skippedFuture = 0;

  [...spec.keys()].sort((a, b) => a - b).forEach(age => {
    const target = spec.get(age);
    const dayCount = LT.daysInLifeYear(dob, age);
    const start = LT.anniversary(dob, age);

    // Group days by week exactly as lifePosition does, including the long
    // final week that absorbs the 1-2 days beyond 52 x 7.
    const daysByWeek = new Map();
    for (let d = 0; d < dayCount; d++) {
      const w = Math.min(LT.WEEKS_PER_YEAR - 1, Math.floor(d / 7));
      if (!daysByWeek.has(w)) daysByWeek.set(w, []);
      daysByWeek.get(w).push(d);
    }

    const months = assign(target, LT.MONTHS_PER_YEAR, rnd, true);

    months.forEach((monthVerdict, m) => {
      const weekIdxs = weeksByMonth.get(m);
      const weeks = assign(monthVerdict, weekIdxs.length, rnd, true);

      weeks.forEach((weekVerdict, i) => {
        const offsets = daysByWeek.get(weekIdxs[i]) || [];
        // Days have no tie: a day is good, rough, or simply not logged.
        const marks = assign(weekVerdict, offsets.length, rnd, false);

        marks.forEach((mark, j) => {
          if (mark !== 'good' && mark !== 'bad') return;
          const date = LT.addDays(start, offsets[j]);
          if (LT.dayDiff(date, today) < 0) { skippedFuture++; return; }
          LT.setEntry(state, LT.toKey(date), mark);
          written++;
        });
      });
    });
  });

  return { state, written, skippedFuture };
}

/* ------------------------------------------------------------------ *
 * Verify against the real aggregation
 * ------------------------------------------------------------------ */

function verify(state, spec) {
  const agg = LT.aggregate(state);
  const rows = [];
  let bad = 0;

  [...spec.keys()].sort((a, b) => a - b).forEach(age => {
    const want = spec.get(age);
    const got = agg.years[age] ? agg.years[age].mark : null;
    const ok = want === got;
    if (!ok) bad++;
    rows.push({ age, want, got, ok, good: agg.years[age].good, bad: agg.years[age].bad });
  });

  return { rows, failures: bad };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function main() {
  let dobKey = args.dob;

  if (!dobKey && args.from) {
    const src = JSON.parse(fs.readFileSync(args.from, 'utf8'));
    dobKey = LT.sanitize(src).dob;
    if (!dobKey) throw new Error(`No date of birth found in ${args.from}`);
    console.log(`Read date of birth ${dobKey} from ${args.from}`);
  }

  if (!dobKey || !/^\d{4}-\d{2}-\d{2}$/.test(dobKey)) {
    console.error(`Backfill invented days for years you never logged.

  node tools/backfill.js --dob=YYYY-MM-DD [--out=backfill.json] [--spec=...] [--seed=N]
  node tools/backfill.js --from=my-export.json

The date of birth is required — every entry is dated from it, and guessing it
would put your childhood on the wrong days.

Default spec: ${DEFAULT_SPEC}
Verdicts: good, bad, tie (a year that was neither), blank (leave empty).`);
    process.exit(1);
  }

  const spec = parseSpec(args.spec || DEFAULT_SPEC);
  const seed = args.seed ? parseInt(args.seed, 10) : 20260727;
  const { state, written, skippedFuture } = backfill(dobKey, spec, seed);
  const { rows, failures } = verify(state, spec);

  console.log(`\nDate of birth ${dobKey}, seed ${seed}\n`);
  console.log('age   asked for   chart shows   months good/rough');
  rows.forEach(r => {
    console.log('  ' + String(r.age).padStart(2) + '   ' +
      String(r.want).padEnd(11) + String(r.got).padEnd(14) +
      r.good + '/' + r.bad + (r.ok ? '' : '   <-- MISMATCH'));
  });

  console.log(`\n${written.toLocaleString()} days written` +
    (skippedFuture ? `, ${skippedFuture} skipped as still in the future` : ''));

  if (failures) {
    console.error(`\n${failures} year(s) do not aggregate to the requested verdict. Not writing.`);
    process.exit(1);
  }
  console.log('Every year aggregates to what was asked for.');

  const out = args.out || 'backfill.json';
  fs.writeFileSync(out, JSON.stringify(state, null, 2));
  console.log(`\nWrote ${out} — import it with Settings -> Import JSON.` +
    `\nImports merge, so anything you logged yourself is kept.`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { backfill, verify, parseSpec, assign, rng };
