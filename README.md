# Your Life in Colour

A life-in-weeks chart you actually fill in. Mark each day good or rough, and the colour
propagates upward: days decide weeks, weeks decide months, months decide years. Over time
the grid becomes a picture of how your life has actually gone.

Adapted from [Your Life in Weeks](https://waitbutwhy.com/2014/05/life-weeks.html) by Tim
Urban and Bryan Braun's [interactive version](https://github.com/bryanbraun/your-life),
which draws the grid but doesn't let you record anything in it.

## Using it

1. Open Settings and enter your date of birth.
2. Each day, hit **Good day** or **Rough day** — or press <kbd>G</kbd> / <kbd>R</kbd>.
3. Switch between **Days / Weeks / Months / Years** to zoom out. Each view has its own
   URL (`#months`), so you can bookmark the one you like.

Missed a few days? Change the date in the Today card and log backwards, or click any past
square in the Days view to cycle it good → rough → blank.

Every view draws the same square cell, only at a different size — a week and a year look
alike so the colour is the only thing that changes between them.

## How the roll-up works

One rule, applied at every level: **the majority wins.**

| Level  | Counts | Good when |
|--------|--------|-----------|
| Day    | you    | you marked it good |
| Week   | its days | more good days than rough |
| Month  | its weeks | more good weeks than rough |
| Year   | its months | more good months than rough |

Two things follow from counting *verdicts* rather than raw days:

- A month is decided by its weeks, not its days. Three good weeks with one logged day each
  beat one rough week with twenty — the month is good. This is what you asked for, and it
  means a single terrible stretch can't drag down a month that was otherwise fine.
- An exact split is a **tie** (light blue), and a tie doesn't vote in the level above it.
  Neither does a period with nothing logged. Blank stays blank all the way up.

### The calendar approximations

Everything is measured from your birthday, not the calendar, so **row N is always age N**.
Keeping that true requires two deliberate roundings, both inherited from the original chart:

- **52 weeks per year**, though a year is 52.143 weeks. The leftover 1–2 days are folded
  into the final week of each life-year, which is therefore 8–9 days long.
- **12 months per year** at 30.4375 days each — the average month length.

Weeks don't divide evenly into months (52 / 12 = 4.33), so each week is assigned to the
month containing its **midpoint day**. Every month ends up owning 4 or 5 weeks.

A 29 February birthday falls on 1 March in non-leap years.

## Phases of your life

Chapters, marked as age ranges — childhood, college, your thirties, a sabbatical. Edit them
in **Settings → Phases of your life**: name, start age, end age, colour.

They show up in every view, scaled to whatever that view is showing:

- A **coloured bar in the gutter**, beside the age labels. In the days, weeks and months
  views a row is one year of life, so consecutive years in the same phase merge into one
  continuous bar down the side of the chart.
- A **faint tint** behind the cells, carrying the phase across the full width.
- In the **years** view a row is a whole decade, so a phase boundary can land mid-row and a
  vertical bar cannot express it. Each year sits on a coloured pad instead, and a run of
  years reads like highlighted text.
- A **legend** under the chart naming each phase, with how many days you logged in it and
  what share of them were good — so you can see that your twenties ran 55% good while
  college ran 47%.

Ranges are half-open: `20–23` covers ages 20, 21 and 22, so a phase ending at 23 and one
starting at 23 meet without overlapping. Gaps are allowed and simply render untinted. If two
phases do overlap, the earlier-starting one owns the shared years.

Phases sync between devices like any other setting, and clearing them all is respected
rather than silently reset to the defaults.

## The look

Printed poster rather than dashboard: pressed paper, ink, hairline rules. Cells you have
not lived yet are an outline only; logged ones are solid. The paper grain is two inline SVG
noise fields — fine tooth over long fibres — so it costs nothing to download and works
offline like the rest of the app.

Five colours do all the work:

| | | |
|---|---|---|
| Alabaster | `#efe8df` | the sheet |
| Midnight blue | `#0f414a` | the ink — headings, rules, and a **good** day |
| Maroon | `#7f0303` | a **rough** day |
| Light blue | `#96c0ce` | an **even split** |
| Tan | `#d8ba98` | **lived, nothing recorded** |

Phase markers are drawn from the same family but never use pure midnight or pure maroon —
those two mean good and rough, and a phase marker must not be mistaken for a cell. Dark mode
turns the palette inside out: midnight becomes the paper and light blue becomes the ink.

Because phases are stored with your data, changing the defaults doesn't recolour phases you
already have. **Settings → Reset to defaults** picks up the new set.

**Paper is the default whatever your device is set to.** A phone in dark mode would
otherwise never show the thing, so the OS preference is not followed unless you ask for it:
*Settings → Appearance* offers **Paper**, **Dark** (toned paper, not a slab of black) and
**Match my device**. The choice syncs across devices with everything else.

The grain is suppressed when printing — it would only waste toner.

## Your data

Everything lives in this browser's `localStorage` under `lifetime-tracking-v1`. There is no
account and no server. This repo is public; your log is not.

```jsonc
{
  "version": 2,
  "dob": "1998-03-15",
  "lifespan": 90,
  "palette": "classic",
  "theme": "paper",
  "phases": [ { "label": "Twenties", "from": 23, "to": 30, "color": "#c9805f" } ],
  "entries": { "2026-07-27": "good", "2026-07-26": "bad" },
  "meta": {
    "entries":  { "2026-07-27": 1753600000000 },  // when each day was last written
    "settings": { "dob": 1753600000000 },
    "hlc": 1753600000000
  }
}
```

Marks are stored as `good` / `bad` rather than as colours, so restyling the chart — or
switching to the colour-blind palette in Settings — never touches your data.

A key present in `meta.entries` but absent from `entries` is a **tombstone** — a day you
deliberately cleared. It has to be recorded, or a delete on one device would be quietly
undone by another device that still remembered the day.

## Backfilling years you never logged

You remember a year as good, rough or somewhere in between. You do not remember the
individual Tuesdays. `tools/backfill.js` invents plausible days underneath a verdict you do
remember, so the early part of the chart fills in without you inventing thousands of moods
by hand.

```sh
node tools/backfill.js --dob=1998-03-15 --out=backfill.json
node tools/backfill.js --from=my-export.json      # reads the date of birth from an export
```

Then **Settings → Import JSON**. Imports merge, so anything you logged yourself wins and is
never replaced by invented data.

The spec is a list of age ranges:

```sh
--spec="0-14:tie,15-16:good,17:bad,18-19:good,20-21:bad"
```

`good`, `bad`, `tie` (a year that was genuinely neither) or `blank` (leave it empty).

Days are generated **top-down** — the year verdict picks month verdicts, months pick weeks,
weeks pick days — rather than rolling dice per day and hoping the average lands right. The
result is then run back through the app's own `LT.aggregate` and checked against the spec, so
the file cannot claim a year was good while the chart would draw it rough. If a year does not
match, nothing is written.

Only day entries are produced; weeks, months and years are derived exactly as they are for
days you logged yourself. `--seed` makes it reproducible.

This is invented data. It is a fair picture of a year you described, not a record of what
happened — worth remembering before reading anything into a particular week.

## Syncing your laptop and your phone

Optional, off by default. Turn it on in **Settings → Sync across devices** and both browsers
stay on one log, using a **private GitHub Gist** as the store. No backend, no account beyond
the GitHub one you already have.

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new).
   Give it no repository access and set **Account permissions → Gists → Read and write**.
2. Paste it into Settings on the first device and press Connect. It creates a private gist.
3. Paste the same token on the second device. It **finds the existing gist by itself** —
   there is no gist ID to copy across.

It syncs on load, when you return to the tab, when you come back online, a couple of seconds
after an edit, and whenever you press Sync now.

### Nothing gets overwritten

The interesting case is logging on your phone and your laptop before either has synced. A
naive "last device to upload wins" would throw one of those away. Instead the merge is a
**CRDT**: every write carries a timestamp, and merging is commutative, associative and
idempotent. So:

- Different days logged on each device → **both survive**.
- The same day marked differently → the **later** edit wins, and both devices agree on which.
- A day cleared on one device → the clear propagates, rather than being resurrected.
- Merging is safe to repeat in any order, so devices converge no matter who syncs when.

`test/merge.test.js` checks those algebraic laws over 400 randomised state pairs, and
`test/sync.test.js` runs two simulated devices against a fake Gist API.

If two devices somehow push in the same instant and one overwrites the other, the loser still
holds its own entry locally with its own timestamp — its next sync merges it back in. The
data heals itself.

### About the token

It is kept in `localStorage` on each device so it survives a reload, and it is **never
written to the gist**. But be clear-eyed about it: anyone with access to that device could
read it, and the token can read and write *all* of your gists, not just this one. Use a
fine-grained token with an expiry, keep it off shared machines, and revoke it from GitHub
settings if you stop using the app.

There is no better option without a backend — GitHub's OAuth device flow can't complete from
a browser, because its token endpoint sends no CORS headers.

### Without sync

Export/Import JSON still works and needs no token. Imports go through the same merge as sync,
so they're safe in either direction and won't clobber what's already on the device.

Whichever route you use: clearing site data deletes the local copy, so **export occasionally**.

## Running it

No build step, no dependencies. Any static server:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Serving over `http://localhost` or HTTPS also registers the service worker, which makes the
app work offline and installable. Opening `index.html` straight off the disk mostly works,
but service workers and `localStorage` are unreliable on `file://`.

## Installing on your phone

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the full comparison. The short version: publish to
GitHub Pages, open it in Chrome on your Nord 2T, and use *Add to Home screen*. That gets you
an icon, a full-screen app with no browser chrome, and offline support in about five minutes
and zero rupees. Build a real APK only if you later want daily reminder notifications.

## Layout

```
index.html              markup and static copy
css/styles.css          all styling; colours are CSS custom properties
js/core.js              date maths, storage, aggregation, merge — no DOM
js/sync.js              GitHub Gist transport; no conflict logic of its own
js/app.js               rendering and event wiring
sw.js                   service worker (offline + installable)
manifest.webmanifest    PWA metadata
icons/                  generated PNG app icons
tools/make_icons.py     regenerates those icons (stdlib only)
tools/backfill.js       invents days under a remembered verdict
test/                   280 assertions; see below
```

`core.js` touches no DOM, and `sync.js` contains no conflict logic — that lives in
`core.mergeStates`. Both facts are what make this testable without a browser:

```sh
./test/run.sh
```

Dates are keyed to the **local** calendar, never UTC. That matters at UTC+5:30: the common
`new Date().toISOString().slice(0,10)` shortcut would file everything logged before 5:30am
in India under the previous day. `dayDiff` also normalises through `Date.UTC` so a DST
transition can't produce a 23-hour day — irrelevant in India, which has no DST, but it keeps
the chart honest if you ever log while travelling.

| Suite | | Covers |
|---|---:|---|
| `core.test.js` | 92 | Local-calendar day counting, leap years, 29 Feb birthdays, week/month clamping at the end of a life-year, tie propagation, streaks across gaps, malformed input, phase ranges and per-phase stats |
| `merge.test.js` | 35 | Tombstones, v1 migration, phase sync, and the CRDT laws over 400 randomised state pairs |
| `backfill.test.js` | 25 | The generator across 5 dates of birth x 25 seeds, every generated life checked through the real aggregation; plus spec parsing and merge precedence |
| `sync.test.js` | 38 | Two simulated devices against a fake Gist API: offline edits, conflicts, deletes, 304s, truncated gists, 401/403/404, corrupt remote data |
| `ui.test.js` | 90 | The real `index.html` booted in jsdom — logging, connect, pull, disconnect, erase, offline, uniform cell geometry, phase shading, the phase editor and appearance |

`ui.test.js` needs jsdom and skips cleanly without it; nothing else has dependencies:

```sh
npm i jsdom && NODE_PATH=./node_modules ./test/run.sh
```

### A note on the rendering split

The Days view holds ~33,000 cells. Rebuilding that on every click would be visibly slow, so
rendering is split in two:

- `buildChart()` writes the DOM. Only runs when the view, date of birth or lifespan changes.
- `paintChart()` walks a cached cell list and rewrites `className` only where it differs.

Measured in Chrome: **58 ms** to build the days grid, **4.5 ms** to repaint after logging a day.

## Credits

Concept: Tim Urban, *Wait But Why*. Interactive original: Bryan Braun.
