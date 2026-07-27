// Boots the real index.html in a DOM and drives the app the way a user would.
//
// Optional: needs jsdom, which the app itself does not. Skips cleanly if absent.
//   npm i jsdom && NODE_PATH=./node_modules node test/ui.test.js
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch (err) {
  console.log('SKIP ui.test.js — jsdom not installed (npm i jsdom)');
  process.exit(0);
}

const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL: ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ------------------------------------------------------------------ *
 * Minimal fake Gist API
 * ------------------------------------------------------------------ */

function makeServer() {
  const server = { gists: new Map(), seq: 1, calls: [], offline: false };

  const respond = (status, body, etag) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: n => (n.toLowerCase() === 'etag' ? etag || null : '4999') },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body))
  });

  const view = g => ({
    id: g.id,
    files: Object.fromEntries(Object.entries(g.files)
      .map(([n, f]) => [n, { truncated: false, content: f.content }]))
  });

  server.fetch = (url, options = {}) => {
    server.calls.push({ url, method: options.method || 'GET' });
    if (server.offline) return Promise.reject(new Error('network'));

    if (url.endsWith('/gists?per_page=100')) {
      return Promise.resolve(respond(200, [...server.gists.values()].map(view)));
    }
    if (url.endsWith('/gists') && options.method === 'POST') {
      const id = 'gist' + server.seq++;
      const g = { id, files: JSON.parse(options.body).files, etag: 'W/"' + Math.random() + '"' };
      server.gists.set(id, g);
      return Promise.resolve(respond(201, view(g), g.etag));
    }

    const g = server.gists.get(url.split('/gists/')[1]);
    if (!g) return Promise.resolve(respond(404, { message: 'Not Found' }));

    if (options.method === 'PATCH') {
      g.files = JSON.parse(options.body).files;
      g.etag = 'W/"' + Math.random() + '"';
      return Promise.resolve(respond(200, view(g), g.etag));
    }
    const sent = options.headers && options.headers['If-None-Match'];
    if (sent && sent === g.etag) return Promise.resolve(respond(304, null, g.etag));
    return Promise.resolve(respond(200, view(g), g.etag));
  };

  server.stored = () => {
    const g = [...server.gists.values()][0];
    return g ? JSON.parse(g.files['lifetime-tracking.json'].content) : null;
  };
  return server;
}

/* ------------------------------------------------------------------ *
 * Boot the page
 * ------------------------------------------------------------------ */

async function boot(server) {
  const html = read('index.html').replace(/<script src="[^"]*"><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'dangerously' });
  const win = dom.window;

  win.fetch = server.fetch;
  win.confirm = () => true;
  win.URL.createObjectURL = () => 'blob:stub';
  win.URL.revokeObjectURL = () => {};

  win.eval(read('js/core.js'));
  win.eval(read('js/sync.js'));
  win.eval(read('js/app.js'));

  // The scripts register a DOMContentLoaded listener, exactly as they do in a
  // real browser. Wait for it before asserting anything about the rendered page.
  await new Promise(resolve => {
    if (win.document.readyState === 'loading') {
      win.document.addEventListener('DOMContentLoaded', resolve);
    } else {
      resolve();
    }
  });

  const $ = id => win.document.getElementById(id);
  return {
    win, $,
    // Wait on a real signal, not a guessed number of ticks. A sync is a chain
    // of promises (fetch -> json -> merge -> save -> PATCH); polling status.busy
    // means the assertions run when the cycle has actually finished instead of
    // whenever two arbitrary ticks happen to have elapsed.
    async settle() {
      for (let i = 0; i < 200; i++) {
        await new Promise(r => win.setTimeout(r, 0));
        if (!win.LTSync.status.busy) break;
      }
      // One more, so the .then() that follows the final report() can run.
      await new Promise(r => win.setTimeout(r, 0));
    },
    localState: () => JSON.parse(win.localStorage.getItem('lifetime-tracking-v1')),
    syncConfig: () => JSON.parse(win.localStorage.getItem('lifetime-tracking-sync') || '{}'),
    setDob(value) {
      $('dob').value = value;
      $('dob').dispatchEvent(new win.Event('change'));
    }
  };
}

const todayKey = (() => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
         '-' + String(d.getDate()).padStart(2, '0');
})();

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

async function main() {
  /* --- boots and renders ------------------------------------------- */
  {
    const server = makeServer();
    const app = await boot(server);

    ok('page boots with no chart until a DOB is set', app.$('chart').hidden === true);
    ok('settings open themselves for a first-time user', app.$('settings').open === true);
    ok('sync starts off', app.$('syncBadge').textContent.trim() === 'Off');
    ok('connect form visible, active controls hidden',
       app.$('syncConnect').hidden === false && app.$('syncActive').hidden === true);

    app.setDob('1998-03-15');
    ok('chart appears once DOB is set', app.$('chart').hidden === false);
    ok('weeks view renders 90 x 52 cells',
       app.win.document.querySelectorAll('.chart i').length === 90 * 52,
       String(app.win.document.querySelectorAll('.chart i').length));
    ok('subtitle reports an age', /^Age \d+ · /.test(app.$('subtitle').textContent),
       app.$('subtitle').textContent);
  }

  /* --- logging ------------------------------------------------------ */
  {
    const server = makeServer();
    const app = await boot(server);
    app.setDob('1998-03-15');

    app.$('btnGood').click();
    ok('good day recorded', app.localState().entries[todayKey] === 'good');
    ok('write is stamped', typeof app.localState().meta.entries[todayKey] === 'number');
    ok('stats update', app.$('statLogged').textContent === '1');

    app.$('btnBad').click();
    ok('overwrite works', app.localState().entries[todayKey] === 'bad');

    app.$('btnClear').click();
    ok('clear removes the entry', !(todayKey in app.localState().entries));
    ok('clear leaves a tombstone', todayKey in app.localState().meta.entries);
  }

  /* --- connecting --------------------------------------------------- */
  {
    const server = makeServer();
    const app = await boot(server);
    app.setDob('1998-03-15');
    app.$('btnGood').click();

    app.$('ghToken').value = 'github_pat_secret';
    app.$('btnConnect').click();
    await app.settle();

    ok('a gist was created', server.gists.size === 1);
    ok('badge shows synced', app.$('syncBadge').textContent.trim() === 'Synced',
       app.$('syncBadge').textContent);
    ok('connect form hidden once connected', app.$('syncConnect').hidden === true);
    ok('sync controls shown', app.$('syncActive').hidden === false);
    const gistId = [...server.gists.keys()][0];
    ok('gist link points at the gist',
       app.$('gistLink').href === 'https://gist.github.com/' + gistId,
       app.$('gistLink').href);
    ok('token cleared from the input', app.$('ghToken').value === '');

    const stored = server.stored();
    ok('gist holds the log', stored.entries[todayKey] === 'good');
    ok('gist holds the dob', stored.dob === '1998-03-15');
    ok('token is NOT in the gist', !JSON.stringify(stored).includes('github_pat_secret'));
    ok('token is NOT in the app state', !JSON.stringify(app.localState()).includes('github_pat_secret'));
    ok('token is NOT in the DOM', !app.win.document.body.innerHTML.includes('github_pat_secret'));
    ok('token is in sync config only', app.syncConfig().token === 'github_pat_secret');
  }

  /* --- an edit reaches the gist ------------------------------------- */
  {
    const server = makeServer();
    const app = await boot(server);
    app.setDob('1998-03-15');
    app.$('ghToken').value = 'tok';
    app.$('btnConnect').click();
    await app.settle();

    app.$('btnBad').click();
    ok('badge shows pending right after an edit',
       app.$('syncBadge').textContent.trim() === 'Pending', app.$('syncBadge').textContent);

    app.$('btnSyncNow').click();
    await app.settle();

    ok('edit reached the gist', server.stored().entries[todayKey] === 'bad');
    ok('badge back to synced', app.$('syncBadge').textContent.trim() === 'Synced');
  }

  /* --- pulling a remote change in ----------------------------------- */
  {
    const server = makeServer();
    const app = await boot(server);
    app.setDob('1998-03-15');
    app.$('ghToken').value = 'tok';
    app.$('btnConnect').click();
    await app.settle();

    // Another device writes a day this one has never seen.
    const gist = [...server.gists.values()][0];
    const remote = JSON.parse(gist.files['lifetime-tracking.json'].content);
    remote.entries['2026-02-02'] = 'good';
    remote.meta.entries['2026-02-02'] = Date.now();
    gist.files['lifetime-tracking.json'].content = JSON.stringify(remote);
    gist.etag = 'W/"moved"';

    app.$('btnSyncNow').click();
    await app.settle();

    ok('remote day pulled into local state', app.localState().entries['2026-02-02'] === 'good');
    ok('stats reflect the pulled day', app.$('statLogged').textContent === '1',
       app.$('statLogged').textContent);
    ok('chart repainted from merged state',
       app.win.document.querySelectorAll('.chart i.g, .chart i.b').length > 0);
  }

  /* --- disconnect ---------------------------------------------------- */
  {
    const server = makeServer();
    const app = await boot(server);
    app.setDob('1998-03-15');
    app.$('ghToken').value = 'tok';
    app.$('btnConnect').click();
    await app.settle();

    app.$('btnDisconnect').click();
    ok('badge back to off', app.$('syncBadge').textContent.trim() === 'Off');
    ok('token discarded', !app.syncConfig().token);
    ok('connect form returns', app.$('syncConnect').hidden === false);
    ok('log survives disconnect', app.localState() !== null);
  }

  /* --- reset must not be undone by the next sync -------------------- */
  {
    const server = makeServer();
    const app = await boot(server);
    app.setDob('1998-03-15');
    app.$('btnGood').click();
    app.$('ghToken').value = 'tok';
    app.$('btnConnect').click();
    await app.settle();
    ok('precondition: gist has the day', server.stored().entries[todayKey] === 'good');

    app.$('btnReset').click();
    await app.settle();

    ok('local log cleared', Object.keys(app.localState().entries).length === 0);
    ok('erase left a tombstone', todayKey in app.localState().meta.entries);
    ok('erase propagated to the gist', !(todayKey in server.stored().entries));
    ok('gist keeps the tombstone so other devices erase too',
       todayKey in server.stored().meta.entries);
  }

  /* --- offline ------------------------------------------------------- */
  {
    const server = makeServer();
    const app = await boot(server);
    app.setDob('1998-03-15');
    app.$('ghToken').value = 'tok';
    app.$('btnConnect').click();
    await app.settle();

    server.offline = true;
    app.$('btnGood').click();
    app.$('btnSyncNow').click();
    await app.settle();

    ok('offline badge shown', app.$('syncBadge').textContent.trim() === 'Offline',
       app.$('syncBadge').textContent);
    ok('log kept locally while offline', app.localState().entries[todayKey] === 'good');

    server.offline = false;
    app.$('btnSyncNow').click();
    await app.settle();
    ok('reconnect flushes the backlog', server.stored().entries[todayKey] === 'good');
    ok('badge recovers', app.$('syncBadge').textContent.trim() === 'Synced');
  }

  /* --- uniform cell shape across every view ------------------------- */
  {
    const server = makeServer();
    const app = await boot(server);
    app.setDob('1998-03-15');

    const shapes = {};
    for (const view of ['days', 'weeks', 'months', 'years']) {
      app.win.document.querySelector(`.view[data-view=${view}]`).click();
      const cell = app.win.document.querySelector('.chart i');
      const style = app.win.getComputedStyle(cell);
      shapes[view] = {
        radius: style.borderRadius,
        transform: style.transform,
        klass: app.win.document.getElementById('chart').className
      };
    }

    ok('no view rotates its cells into diamonds',
       Object.values(shapes).every(s => !/rotate|matrix/.test(s.transform)),
       JSON.stringify(shapes));
    ok('no view rounds its cells into circles',
       Object.values(shapes).every(s => s.radius !== '50%'),
       JSON.stringify(Object.entries(shapes).map(([k, v]) => k + ':' + v.radius)));
    ok('every view uses the same corner radius',
       new Set(Object.values(shapes).map(s => s.radius)).size === 1,
       JSON.stringify(Object.entries(shapes).map(([k, v]) => k + ':' + v.radius)));

    // Counts stay right after the layout change.
    app.win.document.querySelector('.view[data-view=years]').click();
    ok('years view still has one cell per year',
       app.win.document.querySelectorAll('.chart i').length === 90);
    app.win.document.querySelector('.view[data-view=months]').click();
    ok('months view still has 12 per year',
       app.win.document.querySelectorAll('.chart i').length === 90 * 12);
  }

  /* --- phase shading ------------------------------------------------- */
  {
    const server = makeServer();
    const app = await boot(server);
    app.setDob('1998-03-15');

    const rowAt = age => app.win.document.querySelectorAll('.chart .row')[age];

    // Weeks: one row per age, so the rail is a solid colour per row.
    app.win.document.querySelector('.view[data-view=weeks]').click();
    const childhood = rowAt(5).querySelector('.rail');
    const college = rowAt(21).querySelector('.rail');

    ok('rail is coloured inside a phase', /rgba?\(/.test(childhood.style.background),
       childhood.style.background);
    ok('different phases get different rail colours',
       childhood.style.background !== college.style.background);
    ok('rail carries the phase name for screen readers and hover',
       /Childhood/.test(childhood.title), childhood.title);
    ok('rail rounds at the start of a phase',
       rowAt(0).querySelector('.rail').className.includes('rail--first'));
    ok('rail does not round mid-phase',
       !rowAt(5).querySelector('.rail').className.includes('rail--first'));

    // A gap between phases must render untinted rather than guessing.
    const gapState = app.localState();
    ok('precondition: default phases have no gap at 5',
       app.win.LT.phaseAt(gapState.phases, 5) !== null);

    ok('row behind the cells is tinted', /rgba?\(/.test(rowAt(5).querySelector('.cells').style.background),
       rowAt(5).querySelector('.cells').style.background);

    // Years: a row spans a decade, so a vertical rail cannot express a boundary
    // that falls mid-row. Each cell sits on its own phase-coloured pad instead.
    app.win.document.querySelector('.view[data-view=years]').click();
    const decade2 = app.win.document.querySelectorAll('.chart .row')[2]; // ages 20-29
    const slots = decade2.querySelectorAll('.slot');

    ok('years view wraps each cell in a phase slot', slots.length === 10, String(slots.length));
    ok('slots are coloured', /rgba?\(/.test(slots[0].style.background), slots[0].style.background);
    ok('a phase boundary inside a row changes the slot colour',
       slots[0].style.background !== slots[5].style.background,
       slots[0].style.background + ' | ' + slots[5].style.background);
    ok('ages 20-22 share the College colour',
       slots[0].style.background === slots[2].style.background);
    ok('age 23 starts the next phase',
       slots[2].style.background !== slots[3].style.background);
    ok('slot carries the phase name', /College/.test(slots[0].title), slots[0].title);
    ok('years view drops the row tint in favour of slots',
       !decade2.querySelector('.cells').style.background,
       decade2.querySelector('.cells').style.background);
  }

  /* --- phase legend and editor --------------------------------------- */
  {
    const server = makeServer();
    const app = await boot(server);
    app.setDob('1998-03-15');
    app.$('btnGood').click();

    ok('legend lists every phase',
       app.$('phaseLegend').querySelectorAll('.phase-item').length === 8,
       String(app.$('phaseLegend').querySelectorAll('.phase-item').length));
    ok('legend names a phase', /Twenties/.test(app.$('phaseLegend').textContent));
    ok('legend reports per-phase stats', /100% good/.test(app.$('phaseLegend').textContent),
       app.$('phaseLegend').textContent.slice(0, 200));

    ok('editor renders a row per phase',
       app.$('phaseRows').querySelectorAll('.phase-edit').length === 8);

    // Rename, and confirm it reaches state, legend and chart.
    const label = app.$('phaseRows').querySelector('.phase-edit .pe-label');
    label.value = 'Little kid';
    label.dispatchEvent(new app.win.Event('change', { bubbles: true }));

    ok('rename saved', app.localState().phases[0].label === 'Little kid');
    ok('rename reaches the legend', /Little kid/.test(app.$('phaseLegend').textContent));
    ok('rename reaches the chart',
       /Little kid/.test(app.win.document.querySelector('.chart .rail').title));

    // Change a range and confirm the chart re-shades.
    const before = app.win.document.querySelectorAll('.chart .row')[15]
      .querySelector('.rail').style.background;
    const to = app.$('phaseRows').querySelector('.phase-edit .pe-to');
    to.value = '18';
    to.dispatchEvent(new app.win.Event('change', { bubbles: true }));
    const after = app.win.document.querySelectorAll('.chart .row')[15]
      .querySelector('.rail').style.background;
    ok('widening a phase re-shades the chart', before !== after, before + ' -> ' + after);

    // Add, remove, reset.
    const count = app.localState().phases.length;
    app.$('btnAddPhase').click();
    ok('add appends a phase', app.localState().phases.length === count + 1);

    app.$('phaseRows').querySelector('.pe-remove').click();
    ok('remove drops a phase', app.localState().phases.length === count);

    app.$('btnResetPhases').click();
    ok('reset restores the defaults',
       app.localState().phases.length === 8 && app.localState().phases[0].label === 'Childhood');

    // Removing everything must be respected, not silently re-defaulted.
    for (let i = 0; i < 8; i++) app.$('phaseRows').querySelector('.pe-remove').click();
    ok('all phases can be removed', app.localState().phases.length === 0);
    ok('empty state hint shown', app.$('phaseEmpty').hidden === false);
    ok('legend hides when there are no phases', app.$('phaseLegend').hidden === true);
    ok('chart still renders with no phases',
       app.win.document.querySelectorAll('.chart i').length > 0);
    ok('rails are blank with no phases',
       !app.win.document.querySelector('.chart .rail').style.background);
  }

  /* --- phases travel with sync --------------------------------------- */
  {
    const server = makeServer();
    const app = await boot(server);
    app.setDob('1998-03-15');
    app.$('ghToken').value = 'tok';
    app.$('btnConnect').click();
    await app.settle();

    ok('phases pushed to the gist', server.stored().phases.length === 8);

    const gist = [...server.gists.values()][0];
    const remote = JSON.parse(gist.files['lifetime-tracking.json'].content);
    remote.phases = [{ label: 'Sabbatical', from: 33, to: 34, color: '#123456' }];
    remote.meta.settings.phases = Date.now() + 5000;
    gist.files['lifetime-tracking.json'].content = JSON.stringify(remote);
    gist.etag = 'W/"moved"';

    app.$('btnSyncNow').click();
    await app.settle();

    ok('remote phase list pulled in', app.localState().phases[0].label === 'Sabbatical');
    ok('editor follows a pulled change',
       app.$('phaseRows').querySelectorAll('.phase-edit').length === 1);
    ok('chart follows a pulled change',
       /Sabbatical/.test(app.win.document.querySelectorAll('.chart .row')[33]
         .querySelector('.rail').title));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
