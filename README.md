# Your Life in Colour

A life-in-weeks chart you actually fill in. Mark each day green (good) or red (rough),
and the colour propagates upward: days decide weeks, weeks decide months, months decide
years. Over time the grid becomes a picture of how your life has actually gone.

Adapted from [Your Life in Weeks](https://waitbutwhy.com/2014/05/life-weeks.html) by Tim
Urban and Bryan Braun's [interactive version](https://github.com/bryanbraun/your-life),
which draws the grid but doesn't let you record anything in it.

## Using it

1. Open Settings and enter your date of birth.
2. Each day, hit **Good day** or **Rough day** — or press <kbd>G</kbd> / <kbd>R</kbd>.
3. Switch between **Days / Weeks / Months / Years** to zoom out.

Missed a few days? Change the date in the Today card and log backwards, or click any past
square in the Days view to cycle it green → red → blank.

## How the roll-up works

One rule, applied at every level: **more green than red wins.**

| Level  | Counts | Green when |
|--------|--------|-----------|
| Day    | you    | you marked it good |
| Week   | its days | more good days than rough |
| Month  | its weeks | more green weeks than red |
| Year   | its months | more green months than red |

Two things follow from counting *verdicts* rather than raw days:

- A month is decided by its weeks, not its days. Three green weeks with one logged day
  each beat one red week with twenty — the month is green. This is what you asked for, and
  it means a single terrible stretch can't drag down a month that was otherwise fine.
- An exact split is a **tie** (grey), and a tie doesn't vote in the level above it. Neither
  does a period with nothing logged. Blank stays blank all the way up.

### The calendar approximations

Everything is measured from your birthday, not the calendar, so **row N is always age N**.
Keeping that true requires two deliberate roundings, both inherited from the original chart:

- **52 weeks per year**, though a year is 52.143 weeks. The leftover 1–2 days are folded
  into the final week of each life-year, which is therefore 8–9 days long.
- **12 months per year** at 30.4375 days each — the average month length.

Weeks don't divide evenly into months (52 / 12 = 4.33), so each week is assigned to the
month containing its **midpoint day**. Every month ends up owning 4 or 5 weeks.

A 29 February birthday falls on 1 March in non-leap years.

## Your data

Everything lives in this browser's `localStorage` under `lifetime-tracking-v1`. There is no
account and no server. This repo is public; your log is not.

```jsonc
{
  "version": 2,
  "dob": "1998-03-15",
  "lifespan": 90,
  "palette": "classic",
  "entries": { "2026-07-27": "good", "2026-07-26": "bad" },
  "meta": {
    "entries":  { "2026-07-27": 1753600000000 },  // when each day was last written
    "settings": { "dob": 1753600000000 },
    "hlc": 1753600000000
  }
}
```

Marks are stored as `good` / `bad` rather than `green` / `red`, so switching to the
colour-blind palette (blue/orange, in Settings) doesn't touch your data.

A key present in `meta.entries` but absent from `entries` is a **tombstone** — a day you
deliberately cleared. It has to be recorded, or a delete on one device would be quietly
undone by another device that still remembered the day.

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
test/                   179 assertions; see below
```

`core.js` touches no DOM, and `sync.js` contains no conflict logic — that lives in
`core.mergeStates`. Both facts are what make this testable without a browser:

```sh
./test/run.sh

# the date handling is timezone-sensitive, so it is worth running elsewhere too
TZ=Asia/Kolkata     ./test/run.sh
TZ=America/New_York ./test/run.sh   # DST
TZ=Pacific/Auckland ./test/run.sh   # southern-hemisphere DST
```

| Suite | | Covers |
|---|---:|---|
| `core.test.js` | 66 | DST-safe day counting, leap years, 29 Feb birthdays, week/month clamping at the end of a life-year, tie propagation, streaks across gaps, malformed input |
| `merge.test.js` | 31 | Tombstones, v1 migration, and the CRDT laws over 400 randomised state pairs |
| `sync.test.js` | 38 | Two simulated devices against a fake Gist API: offline edits, conflicts, deletes, 304s, truncated gists, 401/403/404, corrupt remote data |
| `ui.test.js` | 44 | The real `index.html` booted in jsdom — logging, connect, pull, disconnect, erase, offline |

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
