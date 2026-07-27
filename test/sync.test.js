// Two simulated devices talking to a fake Gist API, running the real sync.js.
// Each device gets its own vm context, so it has genuinely separate module
// state and localStorage — the same isolation a laptop and a phone have.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'core.js'), 'utf8');
const syncSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'sync.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL: ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ------------------------------------------------------------------ *
 * Fake GitHub Gist API
 * ------------------------------------------------------------------ */

function makeServer() {
  const server = {
    gists: new Map(),
    seq: 1,
    calls: [],
    offline: false,
    failWith: null,
    truncateOver: Infinity
  };

  function response(status, body, etag) {
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: {
        get: name => {
          const key = name.toLowerCase();
          if (key === 'etag') return etag || null;
          if (key === 'x-ratelimit-remaining') return server.failWith === 403 ? '0' : '4999';
          return null;
        }
      },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body))
    };
  }

  server.fetch = (url, options = {}) => {
    server.calls.push({ url, method: options.method || 'GET' });
    if (server.offline) return Promise.reject(new Error('network'));
    if (server.failWith) return Promise.resolve(response(server.failWith, { message: 'nope' }));

    // Raw content fetch for truncated gists.
    const raw = /\/raw\/(.+)$/.exec(url);
    if (raw) {
      const gist = server.gists.get(raw[1]);
      return Promise.resolve(response(200, gist.files['lifetime-tracking.json'].content));
    }

    if (url.endsWith('/gists?per_page=100')) {
      return Promise.resolve(response(200, [...server.gists.values()].map(view)));
    }

    if (url.endsWith('/gists') && options.method === 'POST') {
      const id = 'gist' + server.seq++;
      const body = JSON.parse(options.body);
      const gist = { id, files: body.files, etag: 'W/"' + Math.random() + '"' };
      server.gists.set(id, gist);
      return Promise.resolve(response(201, view(gist), gist.etag));
    }

    const id = url.split('/gists/')[1];
    const gist = server.gists.get(id);
    if (!gist) return Promise.resolve(response(404, { message: 'Not Found' }));

    if (options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      gist.files = body.files;
      gist.etag = 'W/"' + Math.random() + '"';
      return Promise.resolve(response(200, view(gist), gist.etag));
    }

    const sent = options.headers && options.headers['If-None-Match'];
    if (sent && sent === gist.etag) return Promise.resolve(response(304, null, gist.etag));
    return Promise.resolve(response(200, view(gist), gist.etag));
  };

  function view(gist) {
    const files = {};
    Object.keys(gist.files).forEach(name => {
      const content = gist.files[name].content;
      files[name] = content.length > server.truncateOver
        ? { truncated: true, raw_url: 'https://gist.example/raw/' + gist.id, content: content.slice(0, 10) }
        : { truncated: false, content };
    });
    return { id: gist.id, files };
  }

  return server;
}

/* ------------------------------------------------------------------ *
 * Device
 * ------------------------------------------------------------------ */

function makeDevice(server) {
  const store = {};
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    fetch: server.fetch
  };
  sandbox.window = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox);
  vm.runInContext(syncSrc, sandbox);

  const LT = sandbox.LT;
  const device = {
    LT,
    Sync: sandbox.LTSync,
    state: LT.load(),
    store,
    log(key, mark) { LT.setEntry(this.state, key, mark); LT.save(this.state); return this; },
    setting(field, value) { LT.setSetting(this.state, field, value); LT.save(this.state); return this; },
    connect(token) {
      return sandbox.LTSync.connect(token, this.state).then(r => { this.state = r.state; return r; });
    },
    sync() {
      return sandbox.LTSync.sync(this.state).then(s => { this.state = s; return s; });
    },
    marks() {
      return Object.keys(this.state.entries).sort()
        .map(k => k + '=' + this.state.entries[k]).join(',');
    }
  };
  return device;
}

const run = (fns) => fns.reduce((p, fn) => p.then(fn), Promise.resolve());

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */

const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

scenario('first device creates a private gist', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  laptop.setting('dob', '1998-03-15').log('2026-07-01', 'good');

  const result = await laptop.connect('tok');
  ok('gist created', result.created === true);
  ok('one gist exists', server.gists.size === 1);

  const stored = JSON.parse([...server.gists.values()][0].files['lifetime-tracking.json'].content);
  ok('gist holds the entry', stored.entries['2026-07-01'] === 'good');
  ok('gist holds the dob', stored.dob === '1998-03-15');
  ok('token never reaches the gist', !JSON.stringify(stored).includes('tok'));
});

scenario('second device adopts the existing gist with no gist id', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  laptop.setting('dob', '1998-03-15').log('2026-07-01', 'good');
  await laptop.connect('tok');

  const phone = makeDevice(server);            // completely empty
  const result = await phone.connect('tok');

  ok('reused the gist, did not create a second', result.created === false && server.gists.size === 1);
  ok('phone pulled the log down', phone.state.entries['2026-07-01'] === 'good');
  ok('phone pulled the dob down', phone.state.dob === '1998-03-15');
});

scenario('edits made offline on both devices all survive', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  await laptop.connect('tok');
  const phone = makeDevice(server);
  await phone.connect('tok');

  // Neither can see the other yet.
  laptop.log('2026-07-10', 'good').log('2026-07-11', 'bad');
  phone.log('2026-07-12', 'good').log('2026-07-13', 'bad');

  await laptop.sync();
  await phone.sync();
  await laptop.sync();

  const expected = '2026-07-10=good,2026-07-11=bad,2026-07-12=good,2026-07-13=bad';
  ok('laptop has all four days', laptop.marks() === expected, laptop.marks());
  ok('phone has all four days', phone.marks() === expected, phone.marks());
});

scenario('same day marked differently converges to the later edit', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  await laptop.connect('tok');
  const phone = makeDevice(server);
  await phone.connect('tok');

  laptop.log('2026-07-20', 'good');
  await new Promise(r => setTimeout(r, 5));
  phone.log('2026-07-20', 'bad');            // strictly later

  await laptop.sync();
  await phone.sync();
  await laptop.sync();

  ok('both devices agree', laptop.marks() === phone.marks(), laptop.marks() + ' | ' + phone.marks());
  ok('the later edit won', laptop.state.entries['2026-07-20'] === 'bad');
});

scenario('clearing a day propagates instead of being resurrected', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  await laptop.connect('tok');
  laptop.log('2026-07-05', 'good');
  await laptop.sync();

  const phone = makeDevice(server);
  await phone.connect('tok');
  ok('phone received the day', phone.state.entries['2026-07-05'] === 'good');

  laptop.log('2026-07-05', null);            // cleared on the laptop
  await laptop.sync();
  await phone.sync();

  ok('clear reached the phone', !('2026-07-05' in phone.state.entries));

  // And the phone must not push it back on the next round.
  await phone.sync();
  await laptop.sync();
  ok('clear stays cleared', !('2026-07-05' in laptop.state.entries));
});

scenario('an unchanged gist costs a 304 and no write', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  await laptop.connect('tok');
  laptop.log('2026-07-01', 'good');
  await laptop.sync();

  server.calls.length = 0;
  await laptop.sync();
  await laptop.sync();

  const patches = server.calls.filter(c => c.method === 'PATCH');
  ok('idle syncs write nothing', patches.length === 0, JSON.stringify(server.calls));
});

scenario('going offline leaves the local log intact', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  await laptop.connect('tok');
  laptop.log('2026-07-01', 'good');
  await laptop.sync();

  server.offline = true;
  laptop.log('2026-07-02', 'bad');
  await laptop.sync();

  ok('offline sync keeps both entries', laptop.marks() === '2026-07-01=good,2026-07-02=bad', laptop.marks());
  ok('status reports offline', laptop.Sync.status.state === 'offline', laptop.Sync.status.state);
  ok('still has unpushed changes', laptop.Sync.isDirty(laptop.state) === true);

  server.offline = false;
  await laptop.sync();
  ok('reconnecting pushes the backlog', laptop.Sync.status.state === 'ok');

  const phone = makeDevice(server);
  await phone.connect('tok');
  ok('the backlog reached the other device', phone.marks() === '2026-07-01=good,2026-07-02=bad', phone.marks());
});

scenario('a rejected token is dropped rather than retried forever', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  await laptop.connect('tok');
  laptop.log('2026-07-01', 'good');

  server.failWith = 401;
  await laptop.sync();

  ok('sync reports an error', laptop.Sync.status.state === 'error');
  ok('message names the cause', /rejected|expired|revoked/i.test(laptop.Sync.status.message),
     laptop.Sync.status.message);
  ok('token discarded', laptop.Sync.isConnected() === false);
  ok('log untouched', laptop.state.entries['2026-07-01'] === 'good');
});

scenario('rate limiting keeps the token', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  await laptop.connect('tok');

  server.failWith = 403;
  await laptop.sync();

  ok('reports rate limit', /rate limit/i.test(laptop.Sync.status.message), laptop.Sync.status.message);
  ok('stays connected so it can retry', laptop.Sync.isConnected() === true);
});

scenario('a deleted gist clears the pointer but keeps the token', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  await laptop.connect('tok');
  server.gists.clear();

  await laptop.sync();
  ok('no longer connected', laptop.Sync.isConnected() === false);
  ok('reports the gist is gone', /not found|deleted/i.test(laptop.Sync.status.message),
     laptop.Sync.status.message);
});

scenario('a gist over 1 MB is read from raw_url', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  await laptop.connect('tok');
  for (let i = 1; i <= 40; i++) {
    laptop.log('2026-07-' + String(i % 28 + 1).padStart(2, '0'), i % 2 ? 'good' : 'bad');
  }
  await laptop.sync();

  server.truncateOver = 50;                   // force the truncated path
  const phone = makeDevice(server);
  await phone.connect('tok');

  ok('truncated gist still syncs fully', phone.marks() === laptop.marks(),
     phone.marks().length + ' vs ' + laptop.marks().length);
  ok('followed raw_url', server.calls.some(c => /\/raw\//.test(c.url)));
});

scenario('corrupt gist content does not wipe the device', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  await laptop.connect('tok');
  laptop.log('2026-07-01', 'good');
  await laptop.sync();

  [...server.gists.values()][0].files['lifetime-tracking.json'].content = 'not json {{{';
  [...server.gists.values()][0].etag = 'W/"changed"';

  await laptop.sync();
  ok('local log survives corrupt remote', laptop.state.entries['2026-07-01'] === 'good');

  const stored = JSON.parse([...server.gists.values()][0].files['lifetime-tracking.json'].content);
  ok('gist was repaired from local state', stored.entries['2026-07-01'] === 'good');
});

scenario('settings changes sync too', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  await laptop.connect('tok');
  const phone = makeDevice(server);
  await phone.connect('tok');

  laptop.setting('dob', '1998-03-15').setting('lifespan', 85).setting('palette', 'cbSafe');
  await laptop.sync();
  await phone.sync();

  ok('dob synced', phone.state.dob === '1998-03-15');
  ok('lifespan synced', phone.state.lifespan === 85);
  ok('palette synced', phone.state.palette === 'cbSafe');
});

scenario('repeated syncs are stable — no ping-pong writes', async () => {
  const server = makeServer();
  const laptop = makeDevice(server);
  await laptop.connect('tok');
  const phone = makeDevice(server);
  await phone.connect('tok');

  laptop.log('2026-07-01', 'good');
  phone.log('2026-07-02', 'bad');

  for (let i = 0; i < 4; i++) { await laptop.sync(); await phone.sync(); }

  server.calls.length = 0;
  for (let i = 0; i < 4; i++) { await laptop.sync(); await phone.sync(); }

  const patches = server.calls.filter(c => c.method === 'PATCH').length;
  ok('settled state stops writing', patches === 0, patches + ' writes after convergence');
  ok('both devices identical', laptop.marks() === phone.marks());
});

/* ------------------------------------------------------------------ */

run(scenarios.map(s => async () => {
  try {
    await s.fn();
  } catch (err) {
    fail++;
    console.log('  THREW in "' + s.name + '": ' + err.stack.split('\n').slice(0, 3).join('\n'));
  }
})).then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
