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
account, no server, and no network request after the page loads — this repo is public, your
log is not.

That also means the data is only on the device that made it, and clearing site data will
delete it. **Export regularly.**

To move a log between your laptop and your phone: **Export JSON** on one, **Import JSON** on
the other. Imports *merge* — entries in the file win on conflict, everything already on the
device survives — so it is safe in either direction.

```jsonc
{
  "version": 1,
  "dob": "1998-03-15",
  "lifespan": 90,
  "palette": "classic",
  "entries": { "2026-07-27": "good", "2026-07-26": "bad" }
}
```

Marks are stored as `good` / `bad` rather than `green` / `red`, so switching to the
colour-blind palette (blue/orange, in Settings) doesn't touch your data.

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
js/core.js              date maths, storage, aggregation — no DOM
js/app.js               rendering and event wiring
sw.js                   service worker (offline + installable)
manifest.webmanifest    PWA metadata
icons/                  generated PNG app icons
tools/make_icons.py     regenerates those icons (stdlib only)
test/core.test.js       66 assertions over the date maths and roll-up
```

`core.js` touches no DOM, which is what makes the roll-up logic testable on its own:

```sh
node test/core.test.js

# the date handling is timezone-sensitive, so it's worth running elsewhere too
TZ=Asia/Kolkata     node test/core.test.js
TZ=America/New_York node test/core.test.js   # DST
TZ=Pacific/Auckland node test/core.test.js   # southern-hemisphere DST
```

The suite covers DST-safe day counting, leap years, 29 February birthdays, week/month
clamping at the end of a life-year, tie propagation, streaks across gaps, and rejection of
malformed imported data.

### A note on the rendering split

The Days view holds ~33,000 cells. Rebuilding that on every click would be visibly slow, so
rendering is split in two:

- `buildChart()` writes the DOM. Only runs when the view, date of birth or lifespan changes.
- `paintChart()` walks a cached cell list and rewrites `className` only where it differs.

Measured in Chrome: **58 ms** to build the days grid, **4.5 ms** to repaint after logging a day.

## Credits

Concept: Tim Urban, *Wait But Why*. Interactive original: Bryan Braun.
