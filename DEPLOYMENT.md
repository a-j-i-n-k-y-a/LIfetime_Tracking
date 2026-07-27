# Getting this onto your phone

Four options, cheapest first. All of them start from the same static files — there is no
backend to host, ever.

| | Effort | Cost | Offline | Home-screen icon | Play Store | Daily reminder |
|---|---|---|---|---|---|---|
| **1. PWA on GitHub Pages** | 5 min | ₹0 | yes | yes | no | unreliable |
| **2. PWABuilder → APK** | ~1 hr | ₹0 | yes | yes | possible | unreliable |
| **3. Bubblewrap → TWA APK** | 2–3 hr | ₹0 | yes | yes | possible | unreliable |
| **4. Capacitor → native APK** | 2–4 hr | ₹0 | yes | yes | possible | **yes** |
| *Play Store listing (adds to 2/3/4)* | +1 day | ₹2,100 once | | | yes | |

Cross-device sync works in all four — see [the last section](#keeping-the-laptop-and-the-phone-in-step).

**Start with option 1.** On a OnePlus Nord 2T it gives you a real app icon, full screen with
no address bar, and full offline use. Move to option 4 only if you decide you want a
notification at 9pm telling you to log the day — that is the one thing a PWA can't do
dependably on Android.

---

## Option 1 — PWA on GitHub Pages (recommended start)

**Publish.** In the repo: *Settings → Pages → Source: Deploy from a branch → `main` / `root`
→ Save*. Or from the terminal:

```sh
gh api -X POST repos/a-j-i-n-k-y-a/LIfetime_Tracking/pages \
  -f 'source[branch]=main' -f 'source[path]=/'
```

A minute later the app is live at:

```
https://a-j-i-n-k-y-a.github.io/LIfetime_Tracking/
```

**Install on the Nord 2T.** Open that URL in Chrome → **⋮** → **Add to Home screen** →
**Install**. Chrome sees `manifest.webmanifest` and `sw.js`, so it installs as a WebAPK: its
own icon in the launcher, its own entry in the app switcher, no browser UI, and it opens
offline once the service worker has cached the shell.

**On the laptop**, same URL. Chrome shows an install button in the address bar.

> **Note the trailing slash and the capital I.** The repo is `LIfetime_Tracking`
> (capital I, lowercase f) and GitHub Pages URLs are case-sensitive even though repo names
> aren't.

**Limits.** Android will not wake a PWA to fire a scheduled notification reliably — the OS
kills background service workers aggressively. That is the only real gap, and the only reason
to consider option 4. Cross-device sync is *not* a gap: it works here, see below.

---

## Option 2 — PWABuilder (a real APK, no local toolchain)

Fastest route to a file you can install directly.

1. Publish via option 1 first — this wraps a hosted URL.
2. Go to [pwabuilder.com](https://www.pwabuilder.com), paste your Pages URL, **Start**.
3. **Package for stores → Android → Download**. You get a signed APK, an AAB for Play, and
   `assetlinks.json`.
4. Transfer the APK to the phone, tap it, allow *Install unknown apps* for your file manager.

The output is a Trusted Web Activity: a thin native shell around Chrome pointed at your URL.
It needs the site to stay online, and it inherits the Digital Asset Links requirement below.

---

## Option 3 — Bubblewrap (same as 2, from the CLI)

Use this if you want to control the package name, version code and signing key — i.e. if
you're heading to the Play Store.

```sh
npm i -g @bubblewrap/cli
bubblewrap init --manifest https://a-j-i-n-k-y-a.github.io/LIfetime_Tracking/manifest.webmanifest
bubblewrap build          # produces app-release-signed.apk
bubblewrap install        # to a connected device
```

Needs JDK 17 and the Android SDK; `bubblewrap doctor` will fetch what's missing.

### The Digital Asset Links catch (options 2 and 3)

A TWA only hides the URL bar if the site proves it owns the app. That proof must live at the
**domain root**:

```
https://a-j-i-n-k-y-a.github.io/.well-known/assetlinks.json
```

Not under `/LIfetime_Tracking/`. On GitHub Pages you can only write to a domain root by
creating a repo literally named `a-j-i-n-k-y-a.github.io` and putting the file there — or by
attaching a custom domain, or by hosting on Netlify/Vercel instead (both give you root
control and a free HTTPS domain).

Skip this and the app still works, but with a permanent Chrome address bar at the top. If
that bothers you, **option 4 sidesteps the whole problem.**

---

## Option 4 — Capacitor (native APK, assets bundled, real notifications)

The most capable option and the only one that doesn't depend on a hosted URL — the HTML/CSS/JS
ship *inside* the APK, so it works from the moment it installs, with no network ever.

**Prerequisites:** Node 18+, JDK 17, Android Studio.

```sh
cd LIfetime_Tracking
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/android
npx cap init "Life in Colour" com.ajinkya.lifeincolour --web-dir=www

mkdir www && cp -r index.html css js icons manifest.webmanifest www/

npx cap add android
npx cap sync
npx cap open android
```

In Android Studio: **Build → Build Bundle(s)/APK(s) → Build APK(s)**. The debug APK lands in
`android/app/build/outputs/apk/debug/`. Copy it to the phone and install.

Re-run `cp -r ... www/ && npx cap sync` after every code change.

### The daily reminder

This is the reason to pick Capacitor:

```sh
npm i @capacitor/local-notifications
```

```js
import { LocalNotifications } from '@capacitor/local-notifications';

await LocalNotifications.requestPermissions();
await LocalNotifications.schedule({
  notifications: [{
    id: 1,
    title: 'How was today?',
    body: 'Tap to mark it green or red.',
    schedule: { on: { hour: 21, minute: 0 }, repeats: true }
  }]
});
```

OxygenOS is aggressive about battery optimisation — after installing, go to
*Settings → Battery → Battery optimisation* and set this app to **Don't optimise**, or the
reminder will be silently dropped.

---

## Putting it on the Play Store

Only needed if you want it installable by other people. Otherwise sideloading the APK is
entirely legitimate and free.

1. Google Play Console developer account: **$25 / ~₹2,100, one time.**
2. Upload an **AAB**, not an APK (`bubblewrap build` and Android Studio both emit one).
3. Provide a privacy policy URL. Yours is genuinely short — the app collects nothing and
   transmits nothing.
4. Complete the Data Safety form: *no data collected, no data shared.*
5. Review takes a few days for a new developer account.

Apple's App Store is not an option worth pursuing here: it needs a Mac, ₹8,000/year, and
Apple rejects thin web wrappers under guideline 4.2 ("minimum functionality"). You have an
Android phone anyway.

---

## Keeping the laptop and the phone in step

**This is built in** — see *Syncing your laptop and your phone* in the
[README](README.md#syncing-your-laptop-and-your-phone). Settings → Sync across devices, paste
a fine-grained GitHub token with the Gists permission on each device, done. The second device
finds the gist on its own.

Edits merge rather than overwrite, including edits made offline on both devices at once, so
you can log on the phone during the day and on the laptop in the evening without losing
either.

Two things worth knowing:

- Sync works in **every** option here — it is ordinary `fetch` to `api.github.com`, which
  sends permissive CORS headers. The service worker deliberately leaves cross-origin requests
  alone so a cached response can never be replayed as a sync result.
- It needs the network at the moment it runs, but nothing else. Offline, the app keeps
  logging locally and pushes the backlog when you're back.

If you ever outgrow a gist, **Supabase** (Postgres plus auth, free tier) is the honest next
step. You would keep `core.mergeStates` exactly as it is and swap only `js/sync.js` — the
transport is deliberately separate from the conflict logic.
