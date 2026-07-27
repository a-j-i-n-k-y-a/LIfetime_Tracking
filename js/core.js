/**
 * Lifetime Tracking — core date math, storage, and aggregation.
 *
 * No dependencies, no build step. Everything hangs off window.LT so the file
 * works when loaded as a classic script (including from file://).
 *
 * Marks are stored semantically as 'good' / 'bad' rather than 'green' / 'red',
 * so the palette can be swapped (e.g. for colour-blind users) without touching
 * the data.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'lifetime-tracking-v1';

  var MS_PER_DAY = 86400000;
  var WEEKS_PER_YEAR = 52;
  var MONTHS_PER_YEAR = 12;

  // The chart shows 52 weeks per year even though a year is ~52.143 weeks, and
  // 12 months even though month lengths vary. Both are approximations that keep
  // "row index === your age" true, which is the property that makes the chart
  // readable. See README for the full explanation of the trade-off.
  var AVG_DAYS_PER_MONTH = 30.4375;

  var GOOD = 'good';
  var BAD = 'bad';
  var TIE = 'tie';

  /* ------------------------------------------------------------------ *
   * Date helpers
   * ------------------------------------------------------------------ */

  /** Local-calendar date key, e.g. '2026-07-27'. */
  function toKey(date) {
    var m = date.getMonth() + 1;
    var d = date.getDate();
    return date.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (d < 10 ? '0' + d : d);
  }

  /** Parse 'YYYY-MM-DD' into a Date at local midnight. */
  function fromKey(key) {
    var parts = String(key).split('-');
    return new Date(+parts[0], +parts[1] - 1, +parts[2]);
  }

  function today() {
    var now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  /**
   * Whole calendar days from `a` to `b`. Normalising through Date.UTC makes this
   * immune to DST transitions, which would otherwise produce 23h/25h days and
   * throw off a naive millisecond division.
   */
  function dayDiff(a, b) {
    var ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    var ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ub - ua) / MS_PER_DAY);
  }

  function addDays(date, n) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);
  }

  /**
   * The date you turn `age`. For a 29 February birthday this lands on 1 March in
   * non-leap years (the Date constructor rolls over), which is a consistent and
   * conventional choice.
   */
  function anniversary(dob, age) {
    return new Date(dob.getFullYear() + age, dob.getMonth(), dob.getDate());
  }

  /** 365 or 366, depending on whether the life-year spans a leap day. */
  function daysInLifeYear(dob, age) {
    return dayDiff(anniversary(dob, age), anniversary(dob, age + 1));
  }

  /**
   * Where a date sits in a life, relative to birthdays rather than the calendar.
   * Returns null for dates before birth.
   */
  function lifePosition(dob, date) {
    if (dayDiff(dob, date) < 0) return null;

    var age = date.getFullYear() - dob.getFullYear();
    if (dayDiff(anniversary(dob, age), date) < 0) age -= 1;

    var dayOfYear = dayDiff(anniversary(dob, age), date);

    return {
      age: age,
      dayOfYear: dayOfYear,
      // 52 weeks cover 364 days, so the tail of the year (days 364-365) is
      // folded into the final week. That week is 8-9 days long.
      week: Math.min(WEEKS_PER_YEAR - 1, Math.floor(dayOfYear / 7)),
      month: Math.min(MONTHS_PER_YEAR - 1, Math.floor(dayOfYear / AVG_DAYS_PER_MONTH))
    };
  }

  /**
   * Which month-of-life a given week-of-life rolls up into. Weeks don't divide
   * evenly into months (52/12 = 4.33), so a week is assigned to the month
   * containing its midpoint day. Every month ends up owning 4 or 5 weeks.
   */
  function monthOfWeek(week) {
    return Math.min(MONTHS_PER_YEAR - 1, Math.floor((week * 7 + 3) / AVG_DAYS_PER_MONTH));
  }

  /* ------------------------------------------------------------------ *
   * Verdicts
   * ------------------------------------------------------------------ */

  /**
   * The single rule the whole app runs on: more good than bad wins, an exact
   * split is a tie, and no data at all stays blank. Periods with nothing logged
   * never count towards the parent period.
   */
  function verdict(good, bad) {
    if (good === 0 && bad === 0) return null;
    if (good > bad) return GOOD;
    if (bad > good) return BAD;
    return TIE;
  }

  function emptyTally() {
    return { good: 0, bad: 0, mark: null };
  }

  function tallyMark(bucket, mark) {
    if (mark === GOOD) bucket.good += 1;
    else if (mark === BAD) bucket.bad += 1;
  }

  /* ------------------------------------------------------------------ *
   * Store
   * ------------------------------------------------------------------ */

  var VERSION = 2;
  var SETTINGS = ['dob', 'lifespan', 'palette', 'phases', 'theme'];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var HEX_RE = /^#[0-9a-fA-F]{6}$/;

  /**
   * Chapters of a life, as age ranges. Half-open: [from, to), so a phase ending
   * at 20 and one starting at 20 meet without overlapping.
   *
   * Gaps are allowed and simply render untinted — the point is to mark the
   * stretches that mean something to you, not to tile the whole lifespan.
   */
  var DEFAULT_PHASES = [
    { label: 'Childhood',   from: 0,  to: 13, color: '#7c9ec9' },
    { label: 'Teenage',     from: 13, to: 20, color: '#5fae9b' },
    { label: 'College',     from: 20, to: 23, color: '#c9a25f' },
    { label: 'Twenties',    from: 23, to: 30, color: '#c9805f' },
    { label: 'Thirties',    from: 30, to: 40, color: '#ab74a4' },
    { label: 'Forties',     from: 40, to: 50, color: '#7385b5' },
    { label: 'Fifties',     from: 50, to: 60, color: '#7e9e6e' },
    { label: 'Later years', from: 60, to: 90, color: '#8e8e96' }
  ];

  /**
   * State shape (v2):
   *
   *   entries        { '2026-07-27': 'good' }   the log itself
   *   meta.entries   { '2026-07-27': 1753… }    when each key was last written
   *   meta.settings  { dob: 1753…, … }          when each setting was last written
   *   meta.hlc                                  highest stamp this device has issued or seen
   *
   * A key present in meta.entries but absent from entries is a **tombstone**: a
   * day that was deliberately cleared. Without it, a delete on the phone would
   * be silently resurrected by the laptop on the next sync.
   */
  function defaultState() {
    return {
      version: VERSION,
      dob: null,
      lifespan: 90,
      palette: 'classic',
      // Paper by default rather than following the system. The look is the
      // point of the app, and honouring a dark OS setting would mean most
      // people never see it.
      theme: 'paper',
      phases: JSON.parse(JSON.stringify(DEFAULT_PHASES)),
      entries: {},
      meta: { entries: {}, settings: {}, hlc: 0 }
    };
  }

  /** One phase entry, cleaned up, or null if it is unusable. */
  function cleanPhase(raw) {
    if (!raw || typeof raw !== 'object') return null;

    var from = Math.floor(Number(raw.from));
    var to = Math.floor(Number(raw.to));

    if (!isFinite(from) || !isFinite(to)) return null;
    if (from < 0 || to > 130 || from >= to) return null;

    return {
      label: String(raw.label == null ? '' : raw.label).slice(0, 40),
      from: from,
      to: to,
      color: HEX_RE.test(raw.color) ? raw.color : '#8e8e96'
    };
  }

  function cleanPhases(raw) {
    if (!Array.isArray(raw)) return null;

    return raw
      .map(cleanPhase)
      .filter(Boolean)
      .slice(0, 20)
      .sort(function (a, b) { return a.from - b.from || a.to - b.to; });
  }

  function validSetting(field, value) {
    if (field === 'dob') return value === null || (typeof value === 'string' && DATE_RE.test(value));
    if (field === 'lifespan') return typeof value === 'number' && value >= 1 && value <= 130;
    if (field === 'phases') return Array.isArray(value);
    if (field === 'theme') return value === 'paper' || value === 'dark' || value === 'auto';
    return value === 'classic' || value === 'cbSafe';
  }

  /**
   * The phase an age falls in. Ranges are half-open and sorted, and the first
   * match wins — so if two phases overlap, the earlier-starting one owns the
   * shared years rather than the chart flickering between them.
   */
  function phaseAt(phases, age) {
    if (!phases) return null;

    for (var i = 0; i < phases.length; i++) {
      if (age >= phases[i].from && age < phases[i].to) return phases[i];
    }
    return null;
  }

  /**
   * Per-phase totals, so the legend can say "your twenties ran 62% good"
   * rather than just naming a colour.
   */
  function phaseStats(state) {
    var phases = state.phases || [];
    var buckets = phases.map(function (phase) {
      return { phase: phase, good: 0, bad: 0, logged: 0, goodPercent: 0, elapsed: 0 };
    });

    if (!state.dob) return buckets;
    var dob = fromKey(state.dob);

    Object.keys(state.entries).forEach(function (key) {
      var pos = lifePosition(dob, fromKey(key));
      if (!pos) return;

      for (var i = 0; i < phases.length; i++) {
        if (pos.age >= phases[i].from && pos.age < phases[i].to) {
          tallyMark(buckets[i], state.entries[key]);
          buckets[i].logged += 1;
          break;
        }
      }
    });

    var age = lifePosition(dob, today());

    buckets.forEach(function (bucket) {
      bucket.goodPercent = bucket.logged ? Math.round((bucket.good / bucket.logged) * 100) : 0;
      // How far into this phase you are: 0 before it, 1 once it is behind you.
      bucket.elapsed = !age ? 0
        : Math.max(0, Math.min(1, (age.age - bucket.phase.from) / (bucket.phase.to - bucket.phase.from)));
    });

    return buckets;
  }

  function sanitize(raw) {
    var state = defaultState();
    if (!raw || typeof raw !== 'object') return state;

    SETTINGS.forEach(function (field) {
      var value = raw[field];

      if (field === 'phases') {
        // An explicit empty array means "no phases, thanks" and must be kept;
        // only a missing or malformed value falls back to the defaults.
        var phases = cleanPhases(value);
        if (phases) state.phases = phases;
        return;
      }

      if (field === 'lifespan' && typeof value === 'number') value = Math.floor(value);
      if (validSetting(field, value) && value !== null) state[field] = value;
    });

    if (raw.entries && typeof raw.entries === 'object') {
      Object.keys(raw.entries).forEach(function (key) {
        var mark = raw.entries[key];
        if (DATE_RE.test(key) && (mark === GOOD || mark === BAD)) state.entries[key] = mark;
      });
    }

    var meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : null;

    if (meta && meta.entries && typeof meta.entries === 'object') {
      Object.keys(meta.entries).forEach(function (key) {
        var at = meta.entries[key];
        // Tombstones are legitimate here, so accept stamps for keys with no
        // surviving entry. Only the date format and the number are checked.
        if (DATE_RE.test(key) && typeof at === 'number' && isFinite(at) && at > 0) {
          state.meta.entries[key] = Math.floor(at);
        }
      });
    }

    if (meta && meta.settings && typeof meta.settings === 'object') {
      SETTINGS.forEach(function (field) {
        var at = meta.settings[field];
        if (typeof at === 'number' && isFinite(at) && at > 0) {
          state.meta.settings[field] = Math.floor(at);
        }
      });
    }

    if (meta && typeof meta.hlc === 'number' && isFinite(meta.hlc) && meta.hlc > 0) {
      state.meta.hlc = Math.floor(meta.hlc);
    }

    // Migrating a v1 file (or any export with no stamps): date everything to
    // now. Crucially this creates no tombstones, so a first sync between two
    // devices can only ever be a union — it cannot delete anything.
    if (!meta) {
      var at = Date.now();
      Object.keys(state.entries).forEach(function (key) { state.meta.entries[key] = at; });
      SETTINGS.forEach(function (field) { state.meta.settings[field] = at; });
      state.meta.hlc = at;
    }

    return state;
  }

  /* ------------------------------------------------------------------ *
   * Stamps and mutation
   * ------------------------------------------------------------------ */

  /**
   * Issue a timestamp that is always greater than any this device has seen,
   * even if the system clock is behind the other device's. A pure Date.now()
   * would let a laptop with a slow clock lose every conflict to the phone
   * forever; this is a cheap hybrid logical clock that bounds that damage.
   */
  function nextStamp(state) {
    state.meta.hlc = Math.max(Date.now(), (state.meta.hlc || 0) + 1);
    return state.meta.hlc;
  }

  /** Record the highest stamp seen from elsewhere so our next one beats it. */
  function observeStamp(state, at) {
    if (typeof at === 'number' && at > (state.meta.hlc || 0)) state.meta.hlc = at;
  }

  function setEntry(state, key, mark) {
    if (!DATE_RE.test(key)) return state;

    if (mark === GOOD || mark === BAD) state.entries[key] = mark;
    else delete state.entries[key]; // the stamp below becomes the tombstone

    state.meta.entries[key] = nextStamp(state);
    return state;
  }

  function setSetting(state, field, value) {
    if (SETTINGS.indexOf(field) === -1 || !validSetting(field, value)) return state;
    state[field] = field === 'phases' ? cleanPhases(value) : value;
    state.meta.settings[field] = nextStamp(state);
    return state;
  }

  /* ------------------------------------------------------------------ *
   * Merge
   * ------------------------------------------------------------------ */

  /**
   * Last-write-wins per key, which makes this a proper CRDT: merging is
   * commutative, associative and idempotent, so two devices that exchange
   * states in any order and any number of times end up identical.
   *
   * Equal stamps are the only ambiguous case, and it is broken deterministically
   * (present beats absent, then the lexicographically larger mark) so both sides
   * still reach the same answer without talking to each other.
   */
  function pick(va, vb, ta, tb, tiebreak) {
    if (ta > tb) return va;
    if (tb > ta) return vb;
    return tiebreak(va, vb);
  }

  function preferPresent(va, vb) {
    if (va === vb) return va;
    if (va === null || va === undefined) return vb;
    if (vb === null || vb === undefined) return va;
    return String(va) > String(vb) ? va : vb;
  }

  function mergeStates(a, b) {
    var left = sanitize(a);
    var right = sanitize(b);
    var out = defaultState();

    out.meta.hlc = Math.max(left.meta.hlc, right.meta.hlc);

    SETTINGS.forEach(function (field) {
      var ta = left.meta.settings[field] || 0;
      var tb = right.meta.settings[field] || 0;
      var value = pick(left[field], right[field], ta, tb, preferPresent);

      if (value !== null && value !== undefined) out[field] = value;
      if (Math.max(ta, tb)) out.meta.settings[field] = Math.max(ta, tb);
    });

    var keys = Object.create(null);
    [left.entries, left.meta.entries, right.entries, right.meta.entries].forEach(function (map) {
      Object.keys(map).forEach(function (key) { keys[key] = true; });
    });

    Object.keys(keys).forEach(function (key) {
      var ta = left.meta.entries[key] || 0;
      var tb = right.meta.entries[key] || 0;
      var mark = pick(left.entries[key] || null, right.entries[key] || null, ta, tb, preferPresent);
      var at = Math.max(ta, tb);

      if (mark) out.entries[key] = mark;
      if (at) out.meta.entries[key] = at;   // kept even with no mark: tombstone
    });

    return out;
  }

  function load() {
    try {
      return sanitize(JSON.parse(global.localStorage.getItem(STORAGE_KEY)));
    } catch (err) {
      // Private browsing, disabled storage, or corrupt JSON — start clean
      // rather than leaving the app unusable.
      return defaultState();
    }
  }

  function save(state) {
    try {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      return false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Aggregation
   * ------------------------------------------------------------------ */

  /**
   * Roll the sparse day log up through the hierarchy the user asked for:
   *
   *   days  -> weeks   (a week is the majority of its logged days)
   *   weeks -> months  (a month is the majority of its constituent weeks)
   *   months -> years  (a year is the majority of its constituent months)
   *
   * Note that each level counts *verdicts* from the level below, not raw days.
   * A month with four green weeks and one red week is green regardless of how
   * many individual days sat inside those weeks.
   */
  function aggregate(state) {
    var lifespan = state.lifespan;
    var weeks = [];
    var months = [];
    var years = [];
    var age;
    var i;

    for (age = 0; age < lifespan; age++) {
      var weekRow = new Array(WEEKS_PER_YEAR);
      for (i = 0; i < WEEKS_PER_YEAR; i++) weekRow[i] = emptyTally();
      weeks.push(weekRow);

      var monthRow = new Array(MONTHS_PER_YEAR);
      for (i = 0; i < MONTHS_PER_YEAR; i++) monthRow[i] = emptyTally();
      months.push(monthRow);

      years.push(emptyTally());
    }

    if (!state.dob) {
      return { weeks: weeks, months: months, years: years, lifespan: lifespan };
    }

    var dob = fromKey(state.dob);

    // Days -> weeks. Iterating the sparse entry map (not every day of a life)
    // keeps this proportional to how much you've actually logged.
    Object.keys(state.entries).forEach(function (key) {
      var pos = lifePosition(dob, fromKey(key));
      if (!pos || pos.age < 0 || pos.age >= lifespan) return;
      tallyMark(weeks[pos.age][pos.week], state.entries[key]);
    });

    for (age = 0; age < lifespan; age++) {
      // Weeks -> months.
      for (i = 0; i < WEEKS_PER_YEAR; i++) {
        var week = weeks[age][i];
        week.mark = verdict(week.good, week.bad);
        if (week.mark) tallyMark(months[age][monthOfWeek(i)], week.mark);
      }

      // Months -> years.
      for (i = 0; i < MONTHS_PER_YEAR; i++) {
        var month = months[age][i];
        month.mark = verdict(month.good, month.bad);
        if (month.mark) tallyMark(years[age], month.mark);
      }

      years[age].mark = verdict(years[age].good, years[age].bad);
    }

    return { weeks: weeks, months: months, years: years, lifespan: lifespan };
  }

  /* ------------------------------------------------------------------ *
   * Stats
   * ------------------------------------------------------------------ */

  /** Consecutive same-mark days ending today (or yesterday, if today is blank). */
  function currentStreak(entries) {
    var cursor = today();
    var mark = entries[toKey(cursor)];

    if (!mark) {
      cursor = addDays(cursor, -1);
      mark = entries[toKey(cursor)];
      if (!mark) return { mark: null, length: 0 };
    }

    var length = 0;
    while (entries[toKey(cursor)] === mark) {
      length += 1;
      cursor = addDays(cursor, -1);
    }
    return { mark: mark, length: length };
  }

  /** Longest run of each mark across the whole log. */
  function longestStreaks(entries) {
    var keys = Object.keys(entries).sort();
    var best = { good: 0, bad: 0 };
    var run = 0;
    var runMark = null;
    var prev = null;

    keys.forEach(function (key) {
      var date = fromKey(key);
      var mark = entries[key];
      var contiguous = prev !== null && dayDiff(prev, date) === 1;

      if (contiguous && mark === runMark) {
        run += 1;
      } else {
        run = 1;
        runMark = mark;
      }

      if (run > best[mark]) best[mark] = run;
      prev = date;
    });

    return best;
  }

  function stats(state) {
    var entries = state.entries;
    var keys = Object.keys(entries);
    var good = 0;
    var bad = 0;

    keys.forEach(function (key) {
      if (entries[key] === GOOD) good += 1;
      else bad += 1;
    });

    var longest = longestStreaks(entries);

    return {
      logged: keys.length,
      good: good,
      bad: bad,
      goodPercent: keys.length ? Math.round((good / keys.length) * 100) : 0,
      current: currentStreak(entries),
      longestGood: longest.good,
      longestBad: longest.bad,
      firstEntry: keys.length ? keys.sort()[0] : null
    };
  }

  /* ------------------------------------------------------------------ *
   * Exports
   * ------------------------------------------------------------------ */

  global.LT = {
    STORAGE_KEY: STORAGE_KEY,
    WEEKS_PER_YEAR: WEEKS_PER_YEAR,
    MONTHS_PER_YEAR: MONTHS_PER_YEAR,
    GOOD: GOOD,
    BAD: BAD,
    TIE: TIE,

    toKey: toKey,
    fromKey: fromKey,
    today: today,
    dayDiff: dayDiff,
    addDays: addDays,
    anniversary: anniversary,
    daysInLifeYear: daysInLifeYear,
    lifePosition: lifePosition,
    monthOfWeek: monthOfWeek,

    verdict: verdict,
    aggregate: aggregate,
    stats: stats,

    DEFAULT_PHASES: DEFAULT_PHASES,
    cleanPhases: cleanPhases,
    phaseAt: phaseAt,
    phaseStats: phaseStats,

    defaultState: defaultState,
    sanitize: sanitize,
    load: load,
    save: save,

    nextStamp: nextStamp,
    observeStamp: observeStamp,
    setEntry: setEntry,
    setSetting: setSetting,
    mergeStates: mergeStates
  };
})(window);
