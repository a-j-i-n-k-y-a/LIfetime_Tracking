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
    settle: () => new Promise(r => win.setTimeout(r, 0)),
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
    await app.settle(); await app.settle();

    app.$('btnBad').click();
    ok('badge shows pending right after an edit',
       app.$('syncBadge').textContent.trim() === 'Pending', app.$('syncBadge').textContent);

    app.$('btnSyncNow').click();
    await app.settle(); await app.settle();

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
    await app.settle(); await app.settle();

    // Another device writes a day this one has never seen.
    const gist = [...server.gists.values()][0];
    const remote = JSON.parse(gist.files['lifetime-tracking.json'].content);
    remote.entries['2026-02-02'] = 'good';
    remote.meta.entries['2026-02-02'] = Date.now();
    gist.files['lifetime-tracking.json'].content = JSON.stringify(remote);
    gist.etag = 'W/"moved"';

    app.$('btnSyncNow').click();
    await app.settle(); await app.settle();

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
    await app.settle(); await app.settle();

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
    await app.settle(); await app.settle();
    ok('precondition: gist has the day', server.stored().entries[todayKey] === 'good');

    app.$('btnReset').click();
    await app.settle(); await app.settle();

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
    await app.settle(); await app.settle();

    server.offline = true;
    app.$('btnGood').click();
    app.$('btnSyncNow').click();
    await app.settle(); await app.settle();

    ok('offline badge shown', app.$('syncBadge').textContent.trim() === 'Offline',
       app.$('syncBadge').textContent);
    ok('log kept locally while offline', app.localState().entries[todayKey] === 'good');

    server.offline = false;
    app.$('btnSyncNow').click();
    await app.settle(); await app.settle();
    ok('reconnect flushes the backlog', server.stored().entries[todayKey] === 'good');
    ok('badge recovers', app.$('syncBadge').textContent.trim() === 'Synced');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
