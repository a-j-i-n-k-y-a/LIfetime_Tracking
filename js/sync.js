/**
 * Lifetime Tracking — sync via a private GitHub Gist.
 *
 * The gist is dumb storage: one private gist, one JSON file, no server of ours
 * anywhere. All of the intelligence is in LT.mergeStates, which is a CRDT — so
 * this module never has to decide who wins a conflict, it only has to make sure
 * both sides eventually see each other's state.
 *
 * The cycle is pull -> merge -> save -> push, and it is safe to run at any time
 * from any number of devices.
 *
 * Lost updates heal themselves. If two devices push within the same instant and
 * one overwrites the other, the loser still holds its own entry locally with its
 * own stamp; its next pull merges that entry back in and pushes it. Nothing is
 * permanently lost unless a device's local storage is wiped before it syncs.
 */
(function (global) {
  'use strict';

  var LT = global.LT;

  var API = 'https://api.github.com';
  var FILENAME = 'lifetime-tracking.json';
  var CONFIG_KEY = 'lifetime-tracking-sync';
  var GIST_DESCRIPTION = 'Your Life in Colour — day log (private)';

  var config = loadConfig();
  var listeners = [];
  var status = { state: 'off', message: '', at: null, busy: false };
  var dirty = false;
  var revision = 0;
  var timer = null;
  var inFlight = null;

  /* ------------------------------------------------------------------ *
   * Config — device-local, never synced. The token must never reach the gist.
   * ------------------------------------------------------------------ */

  function loadConfig() {
    try {
      var raw = JSON.parse(global.localStorage.getItem(CONFIG_KEY)) || {};
      return {
        token: typeof raw.token === 'string' ? raw.token : '',
        gistId: typeof raw.gistId === 'string' ? raw.gistId : '',
        etag: typeof raw.etag === 'string' ? raw.etag : '',
        lastPushedHash: typeof raw.lastPushedHash === 'string' ? raw.lastPushedHash : '',
        lastSyncAt: typeof raw.lastSyncAt === 'number' ? raw.lastSyncAt : null
      };
    } catch (err) {
      return { token: '', gistId: '', etag: '', lastPushedHash: '', lastSyncAt: null };
    }
  }

  function saveConfig() {
    try {
      global.localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch (err) { /* nothing useful to do */ }
  }

  function isConnected() {
    return !!(config.token && config.gistId);
  }

  /* ------------------------------------------------------------------ *
   * Status reporting
   * ------------------------------------------------------------------ */

  function onChange(fn) {
    listeners.push(fn);
  }

  function report(state, message) {
    status.state = state;
    status.message = message || '';
    status.busy = state === 'syncing';
    if (state === 'ok') status.at = config.lastSyncAt;
    listeners.forEach(function (fn) { fn(status); });
  }

  /* ------------------------------------------------------------------ *
   * Canonical JSON — sorted keys, so two devices that hold the same logical
   * state produce byte-identical text. Without this, "did anything change?"
   * would be answered by key ordering rather than content.
   * ------------------------------------------------------------------ */

  function canonical(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';

    return '{' + Object.keys(value).sort().map(function (key) {
      return JSON.stringify(key) + ':' + canonical(value[key]);
    }).join(',') + '}';
  }

  /**
   * Fingerprint of a state, used to answer "is there anything to push?".
   *
   * This is deliberately derived from the state itself rather than tracked by a
   * dirty flag. A flag has to be set by every mutation path, and the one caller
   * that forgets leaves edits stranded on the device forever with the UI
   * cheerfully reporting "Synced". FNV-1a plus the length; a collision costs one
   * skipped push, and the next edit corrects it.
   */
  function fingerprint(state) {
    var text = canonical(state);
    var h = 0x811c9dc5;

    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16) + ':' + text.length;
  }

  function hasUnpushedChanges(state) {
    return fingerprint(state) !== config.lastPushedHash;
  }

  /* ------------------------------------------------------------------ *
   * GitHub API
   * ------------------------------------------------------------------ */

  function request(path, options) {
    options = options || {};

    var headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': 'Bearer ' + config.token
    };
    if (options.etag) headers['If-None-Match'] = options.etag;
    if (options.body) headers['Content-Type'] = 'application/json';

    return fetch(API + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      // Manage revalidation ourselves rather than letting the HTTP cache do it,
      // so a 304 is always visible to us.
      cache: 'no-store'
    }).then(function (response) {
      if (response.status === 304) return { notModified: true, etag: options.etag };
      if (response.ok) {
        return response.json().then(function (data) {
          return { data: data, etag: response.headers.get('ETag') || '' };
        });
      }
      return response.json().catch(function () { return {}; }).then(function (body) {
        throw describeError(response, body);
      });
    }, function () {
      throw new Error('offline');
    });
  }

  function describeError(response, body) {
    var remaining = response.headers.get('X-RateLimit-Remaining');
    var error;

    if (response.status === 401) {
      error = new Error('Token rejected. It may have expired, or been revoked.');
      error.fatal = true;
    } else if (response.status === 403 && remaining === '0') {
      error = new Error('GitHub rate limit reached. It resets within the hour.');
    } else if (response.status === 403) {
      error = new Error('Token lacks Gist read/write permission.');
      error.fatal = true;
    } else if (response.status === 404) {
      error = new Error('Gist not found — it may have been deleted.');
      error.missing = true;
    } else {
      error = new Error((body && body.message) || ('GitHub returned ' + response.status));
    }

    error.status = response.status;
    return error;
  }

  /**
   * Gists over 1 MB come back with their content truncated and a raw_url to
   * fetch instead. A full lifetime of entries will eventually cross that line,
   * so follow the pointer rather than silently syncing a half-parsed log.
   */
  function readFile(gist) {
    var file = gist && gist.files && gist.files[FILENAME];
    if (!file) return Promise.resolve(null);

    if (file.truncated && file.raw_url) {
      return fetch(file.raw_url, { cache: 'no-store' })
        .then(function (response) { return response.text(); })
        .then(parseOrNull);
    }
    return Promise.resolve(parseOrNull(file.content));
  }

  function parseOrNull(text) {
    try {
      return JSON.parse(text);
    } catch (err) {
      // A corrupt or hand-edited gist must not wipe the device. Treat it as
      // "nothing there" and let the next push rewrite it from local state.
      return null;
    }
  }

  function writeBody(state) {
    var files = {};
    files[FILENAME] = { content: JSON.stringify(state, null, 2) };
    return { description: GIST_DESCRIPTION, files: files };
  }

  /* ------------------------------------------------------------------ *
   * Connect
   * ------------------------------------------------------------------ */

  /**
   * Reuses an existing log gist if the account already has one, so the second
   * device needs nothing but the token — no gist ID to copy across.
   */
  function connect(token, localState) {
    config.token = String(token || '').trim();
    if (!config.token) return Promise.reject(new Error('No token given.'));

    report('syncing', 'Connecting…');

    return request('/gists?per_page=100')
      .then(function (result) {
        var match = (result.data || []).filter(function (gist) {
          return gist.files && gist.files[FILENAME];
        })[0];

        if (match) {
          config.gistId = match.id;
          config.etag = '';
          saveConfig();
          return sync(localState).then(function (merged) {
            return { created: false, state: merged };
          });
        }

        return request('/gists', {
          method: 'POST',
          body: {
            description: GIST_DESCRIPTION,
            public: false,
            files: writeBody(localState).files
          }
        }).then(function (created) {
          config.gistId = created.data.id;
          config.etag = created.etag;
          config.lastPushedHash = fingerprint(localState);
          config.lastSyncAt = Date.now();
          saveConfig();
          dirty = false;
          report('ok', 'Created a new private gist.');
          return { created: true, state: localState };
        });
      })
      .catch(function (err) {
        config.token = '';
        saveConfig();
        report('error', err.message);
        throw err;
      });
  }

  function disconnect() {
    config = { token: '', gistId: '', etag: '', lastPushedHash: '', lastSyncAt: null };
    saveConfig();
    dirty = false;
    report('off', '');
  }

  /* ------------------------------------------------------------------ *
   * Sync
   * ------------------------------------------------------------------ */

  /**
   * One full cycle. Returns the merged state, or the state passed in if there
   * was nothing to do or the network was unavailable.
   */
  function sync(localState) {
    if (!isConnected()) return Promise.resolve(localState);
    if (inFlight) return inFlight;

    report('syncing', 'Syncing…');

    inFlight = request('/gists/' + config.gistId, { etag: config.etag })
      .then(function (result) {
        // 304 means the gist still holds exactly what we last merged, so local
        // is a superset of it. No need to re-merge — just push if we have news.
        if (result.notModified) {
          if (!hasUnpushedChanges(localState)) {
            dirty = false;
            report('ok', '');
            return localState;
          }
          return push(localState);
        }

        config.etag = result.etag;

        return readFile(result.data).then(function (remote) {
          if (!remote) return push(localState);

          var merged = LT.mergeStates(localState, remote);
          LT.observeStamp(merged, merged.meta.hlc);
          LT.save(merged);

          // Only spend a write if the gist would actually change.
          if (canonical(merged) !== canonical(LT.sanitize(remote))) return push(merged);

          dirty = false;
          config.lastPushedHash = fingerprint(merged);
          config.lastSyncAt = Date.now();
          saveConfig();
          report('ok', '');
          return merged;
        });
      })
      .catch(function (err) {
        if (err.missing) {
          // The gist is gone. Keep the token, drop the pointer, and let the
          // next connect() make a fresh one rather than looping on 404s.
          config.gistId = '';
          config.etag = '';
          saveConfig();
        }
        if (err.fatal) {
          config.token = '';
          saveConfig();
        }
        report(err.message === 'offline' ? 'offline' : 'error',
               err.message === 'offline' ? 'Offline — will retry.' : err.message);
        return localState;
      })
      .then(function (state) {
        inFlight = null;
        return state;
      }, function (err) {
        inFlight = null;
        throw err;
      });

    return inFlight;
  }

  function push(state) {
    // Note which edit the body reflects. If the user logs another day while the
    // request is in flight, clearing `dirty` on success would strand that edit
    // until something else happened to trigger a sync.
    var sent = revision;

    return request('/gists/' + config.gistId, { method: 'PATCH', body: writeBody(state) })
      .then(function (result) {
        config.etag = result.etag;
        config.lastPushedHash = fingerprint(state);
        config.lastSyncAt = Date.now();
        saveConfig();

        if (revision === sent) {
          dirty = false;
          report('ok', '');
        } else {
          report('pending', 'Unsynced changes');
        }
        return state;
      });
  }

  /**
   * Called on every local edit. Batches a burst of logging into one write
   * instead of hammering the API once per click.
   */
  function schedule(getState, delay) {
    dirty = true;
    revision++;
    if (!isConnected()) return;

    report('pending', 'Unsynced changes');
    clearTimeout(timer);
    timer = setTimeout(function () {
      sync(getState());
    }, delay === undefined ? 2500 : delay);
  }

  function flush(getState) {
    clearTimeout(timer);
    return sync(getState());
  }

  global.LTSync = {
    FILENAME: FILENAME,
    canonical: canonical,
    status: status,
    onChange: onChange,
    isConnected: isConnected,
    isDirty: function (state) {
      return state ? hasUnpushedChanges(state) : dirty;
    },
    config: function () { return { gistId: config.gistId, lastSyncAt: config.lastSyncAt }; },
    connect: connect,
    disconnect: disconnect,
    sync: sync,
    schedule: schedule,
    flush: flush
  };
})(window);
