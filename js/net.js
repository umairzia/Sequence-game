/*
 * Thin wrapper around the Firebase SDK (compat builds in vendor/firebase).
 * Everything the game reads from or writes to Firebase goes through here:
 * anonymous sign-in, the connection state, listeners, writes and presence.
 *
 * Plain ES5 so it runs on older iPhones. Exposed as window.SeqNet.
 */
(function (root) {
  'use strict';

  var db = null;
  var auth = null;
  var TIMESTAMP = { '.sv': 'timestamp' }; // Firebase fills in the server time

  /** True when the config file has been filled in. */
  function configured(cfg) {
    return !!(cfg && cfg.apiKey && cfg.databaseURL && cfg.projectId);
  }

  /** True when the Firebase SDK loaded (it needs iOS 11.3 or later). */
  function sdkLoaded() {
    return !!(root.firebase && root.firebase.initializeApp && root.firebase.database && root.firebase.auth);
  }

  /**
   * Connects to Firebase and signs in anonymously. The browser keeps the
   * anonymous account, so after a refresh the same user id comes back and
   * the player gets their seat and hand again. Resolves with the user id.
   */
  function start(cfg) {
    root.firebase.initializeApp(cfg);
    auth = root.firebase.auth();
    db = root.firebase.database();
    // Local emulators, used only by the automated tests.
    var emu = root.SEQUENCE_EMULATOR;
    if (emu) {
      auth.useEmulator('http://' + emu.host + ':' + emu.authPort);
      db.useEmulator(emu.host, emu.dbPort);
    }
    return new Promise(function (resolve, reject) {
      var asked = false;
      var stop = auth.onAuthStateChanged(function (user) {
        if (user) {
          stop();
          resolve(user.uid);
        } else if (!asked) {
          asked = true;
          auth.signInAnonymously().catch(function (err) { stop(); reject(err); });
        }
      }, reject);
    });
  }

  /** Calls back with true/false whenever the link to Firebase comes or goes. */
  function onConnection(cb) {
    db.ref('.info/connected').on('value', function (snap) { cb(snap.val() === true); });
  }

  /**
   * Listens to a path. onValue gets the value (null when there is none) now
   * and on every change. onError gets called if reading is refused (for
   * example after leaving the room). Returns a function that stops listening.
   */
  function watch(path, onValue, onError) {
    var ref = db.ref(path);
    var handler = ref.on('value', function (snap) { onValue(snap.val()); }, function (err) {
      if (onError) onError(err);
    });
    return function () { ref.off('value', handler); };
  }

  function get(path) {
    return db.ref(path).once('value').then(function (snap) { return snap.val(); });
  }

  // Firebase refuses `undefined` anywhere in a value; drop those fields.
  function clean(value) {
    if (value === null || typeof value !== 'object') return value;
    var out = Object.prototype.toString.call(value) === '[object Array]' ? [] : {};
    for (var k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k) && value[k] !== undefined) out[k] = clean(value[k]);
    }
    return out;
  }

  function set(path, value) { return db.ref(path).set(clean(value)); }

  /** Writes several paths at once: either all of them are saved or none. */
  function update(paths) { return db.ref().update(clean(paths)); }

  function remove(path) { return db.ref(path).remove(); }

  /**
   * Marks this player online at `path` while connected, and lets the server
   * mark them offline when the connection drops (closed tab, lost signal).
   * Returns a function that stops it and marks the player offline now.
   */
  function presence(path) {
    var ref = db.ref(path);
    var conn = db.ref('.info/connected');
    var handler = conn.on('value', function (snap) {
      if (snap.val() !== true) return;
      ref.onDisconnect().set({ on: false, at: TIMESTAMP }).then(function () {
        return ref.set({ on: true, at: TIMESTAMP });
      }).catch(function () { /* not in the room any more */ });
    });
    return function () {
      conn.off('value', handler);
      ref.onDisconnect().cancel().catch(function () {});
      ref.set({ on: false, at: TIMESTAMP }).catch(function () {});
    };
  }

  function isPermissionDenied(err) {
    return !!err && (err.code === 'PERMISSION_DENIED' || /permission/i.test(String(err.message || err)));
  }

  root.SeqNet = {
    TIMESTAMP: TIMESTAMP,
    configured: configured,
    sdkLoaded: sdkLoaded,
    start: start,
    onConnection: onConnection,
    watch: watch,
    get: get,
    set: set,
    update: update,
    remove: remove,
    presence: presence,
    clean: clean,
    isPermissionDenied: isPermissionDenied
  };
})(this);
