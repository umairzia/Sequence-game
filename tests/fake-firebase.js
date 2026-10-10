// A stand-in for Firebase for the browser tests. One in-memory database is
// shared by every browser page in the test, so two "phones" can play each
// other offline. Reads and writes are checked like database.rules.json
// (the real rules are tested against the official emulator in
// rules.test.js). The pages get a small copy of the Firebase compat
// API (window.firebase) instead of the real SDK.
'use strict';

// ---- Runs inside the page --------------------------------------------------
function browserSdk() {
  var KEY = 'fakeFirebase.uid';
  var connected = false;
  var connWatchers = [];
  var listeners = {}; // path -> [{ cb, err }]
  var values = {};    // path -> last value from the "server"
  var queue = [];     // calls made while offline
  var user = null;
  var authWatchers = [];

  try { var saved = localStorage.getItem(KEY); if (saved) user = { uid: saved, isAnonymous: true }; } catch (e) {}

  function norm(path) { return String(path || '').split('/').filter(function (x) { return x; }).join('/'); }
  function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
  function snap(path, v) {
    return { key: path.split('/').pop() || null, val: function () { return clone(v); }, exists: function () { return v !== null && v !== undefined; } };
  }
  function denied() {
    var e = new Error('PERMISSION_DENIED: Permission denied');
    e.code = 'PERMISSION_DENIED';
    return e;
  }
  function raw(op, args) {
    args = args || {};
    args.uid = user ? user.uid : null;
    return window.__fakeDb(op, args).then(function (res) {
      if (res && res.error) throw denied();
      return res;
    });
  }
  // Calls wait while offline, like Firebase queues writes.
  function send(op, args) {
    if (connected) return raw(op, args);
    return new Promise(function (resolve, reject) { queue.push({ op: op, args: args, resolve: resolve, reject: reject }); });
  }
  function flush() {
    var q = queue;
    queue = [];
    q.forEach(function (item) { raw(item.op, item.args).then(item.resolve, item.reject); });
  }
  function fire(path) {
    (listeners[path] || []).slice().forEach(function (l) { l.cb(snap(path, values[path])); });
  }
  function setConnected(on) {
    connected = on;
    connWatchers.slice().forEach(function (cb) { cb(snap('.info/connected', on)); });
    if (on) flush();
  }

  window.__fakeDbEvent = function (ev) {
    if (ev.type === 'value') {
      values[ev.path] = ev.value;
      fire(ev.path);
    } else if (ev.type === 'cancel') {
      var ls = listeners[ev.path] || [];
      delete listeners[ev.path];
      delete values[ev.path];
      ls.forEach(function (l) { if (l.err) l.err(denied()); });
    } else if (ev.type === 'connected') {
      setConnected(ev.value);
    }
  };

  function Ref(path) {
    this.path = norm(path);
    this.key = this.path.split('/').pop() || null;
  }
  Ref.prototype.child = function (p) { return new Ref(this.path + '/' + p); };
  Ref.prototype.on = function (event, cb, err) {
    var path = this.path;
    if (path === '.info/connected') {
      connWatchers.push(cb);
      setTimeout(function () { cb(snap(path, connected)); }, 0);
      return cb;
    }
    var first = !listeners[path];
    var entry = { cb: cb, err: err };
    (listeners[path] = listeners[path] || []).push(entry);
    if (first) {
      send('listen', { path: path }).then(function (res) {
        values[path] = res.value;
        fire(path);
      }, function (e) {
        listeners[path] = (listeners[path] || []).filter(function (l) { return l !== entry; });
        if (err) err(e);
      });
    } else if (path in values) {
      setTimeout(function () { cb(snap(path, values[path])); }, 0);
    }
    return cb;
  };
  Ref.prototype.off = function (event, cb) {
    var path = this.path;
    if (path === '.info/connected') {
      connWatchers = connWatchers.filter(function (c) { return c !== cb; });
      return;
    }
    listeners[path] = (listeners[path] || []).filter(function (l) { return cb && l.cb !== cb; });
    if (!listeners[path].length) {
      delete listeners[path];
      delete values[path];
      send('unlisten', { path: path });
    }
  };
  Ref.prototype.once = function () {
    var path = this.path;
    return send('get', { path: path }).then(function (res) { return snap(path, res.value); });
  };
  Ref.prototype.set = function (v) {
    var paths = {};
    paths[this.path] = clone(v);
    return send('update', { paths: paths }).then(function () {});
  };
  Ref.prototype.update = function (obj) {
    var base = this.path;
    var paths = {};
    Object.keys(obj).forEach(function (k) { paths[norm(base + '/' + k)] = clone(obj[k]); });
    return send('update', { paths: paths }).then(function () {});
  };
  Ref.prototype.remove = function () { return this.set(null); };
  Ref.prototype.onDisconnect = function () {
    var path = this.path;
    return {
      set: function (v) { return send('onDisconnect', { path: path, value: clone(v) }).then(function () {}); },
      remove: function () { return send('onDisconnect', { path: path, value: null }).then(function () {}); },
      cancel: function () { return send('onDisconnectCancel', { path: path }).then(function () {}); }
    };
  };

  var auth = {
    useEmulator: function () {},
    onAuthStateChanged: function (cb) {
      authWatchers.push(cb);
      setTimeout(function () { cb(user); }, 0);
      return function () { authWatchers = authWatchers.filter(function (c) { return c !== cb; }); };
    },
    signInAnonymously: function () {
      if (!user) {
        user = { uid: 'u' + Math.random().toString(36).slice(2, 12), isAnonymous: true };
        try { localStorage.setItem(KEY, user.uid); } catch (e) {}
      }
      setTimeout(function () { authWatchers.slice().forEach(function (cb) { cb(user); }); }, 0);
      return Promise.resolve({ user: user });
    }
  };
  Object.defineProperty(auth, 'currentUser', { get: function () { return user; } });

  var database = { ref: function (p) { return new Ref(p || ''); }, useEmulator: function () {} };
  function databaseFn() { return database; }
  databaseFn.ServerValue = { TIMESTAMP: { '.sv': 'timestamp' } };

  window.firebase = {
    initializeApp: function (cfg) { return { options: cfg }; },
    auth: function () { return auth; },
    database: databaseFn
  };

  // A new page load is a new connection: the server forgets the old one.
  window.__fakeDb('hello', {}).then(function (res) { setConnected(res.online); });
}

// ---- Runs in Node -------------------------------------------------------------

function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
function parts(path) { return String(path).split('/').filter(function (x) { return x; }); }

function getAt(tree, path) {
  var node = tree;
  var ps = parts(path);
  for (var i = 0; i < ps.length; i++) {
    if (node === null || typeof node !== 'object' || !(ps[i] in node)) return null;
    node = node[ps[i]];
  }
  return node === undefined ? null : node;
}

function isEmpty(v) { return v === null || (typeof v === 'object' && Object.keys(v).length === 0); }

function setAt(tree, path, value) {
  var ps = parts(path);
  if (!ps.length) return isEmpty(value) ? {} : value;
  var node = tree;
  var trail = [];
  for (var i = 0; i < ps.length - 1; i++) {
    if (node[ps[i]] === null || typeof node[ps[i]] !== 'object') node[ps[i]] = {};
    trail.push([node, ps[i]]);
    node = node[ps[i]];
  }
  var last = ps[ps.length - 1];
  if (isEmpty(value)) delete node[last];
  else node[last] = value;
  // Firebase does not keep empty objects.
  for (var k = trail.length - 1; k >= 0; k--) {
    if (isEmpty(trail[k][0][trail[k][1]])) delete trail[k][0][trail[k][1]];
  }
  return tree;
}

function serverValues(v) {
  if (v && typeof v === 'object') {
    if (v['.sv'] === 'timestamp') return Date.now();
    Object.keys(v).forEach(function (k) { v[k] = serverValues(v[k]); });
  }
  return v;
}

function uidOf(room, seat) {
  return room && room.players && room.players[seat] ? room.players[seat].uid : null;
}

function FakeFirebase() {
  this.tree = {};
  this.clients = [];
  this.log = []; // every read attempt: { uid, path, ok }
}

FakeFirebase.prototype.canRead = function (uid, path) {
  var p = parts(path);
  if (!uid) return false;
  var room = getAt(this.tree, 'rooms/' + p[1]);
  if (p[0] === 'rooms' && p.length >= 2) {
    if (p[2] === 'players') return true;
    return !!room && (uidOf(room, 'host') === uid || uidOf(room, 'guest') === uid);
  }
  if (p[0] === 'hands' && p.length >= 3) return (p[2] === 'host' || p[2] === 'guest') && uidOf(room, p[2]) === uid;
  if (p[0] === 'secret' && p.length >= 2) return uidOf(room, 'host') === uid;
  return false;
};

// The checks from database.rules.json that the game's flows depend on.
FakeFirebase.prototype.canWrite = function (before, after, uid, path) {
  var p = parts(path);
  if (!uid || p.length < 2) return false;
  var code = p[1];
  var room = getAt(before, 'rooms/' + code);
  var host = uidOf(room, 'host');
  var guest = uidOf(room, 'guest');
  if (p[0] === 'rooms') {
    if (host === uid) return true;
    if (p.length === 2) return !room && uidOf(getAt(after, path), 'host') === uid;
    if (p[2] === 'players' && p[3] === 'guest' && p.length === 4) {
      var was = getAt(before, path);
      var now = getAt(after, path);
      if (!was) return !!room && host !== uid && !!now && now.uid === uid;
      return was.uid === uid && (!now || now.uid === uid);
    }
    if (p[2] === 'presence' && p[3] === 'guest') return guest === uid;
    if (p[2] === 'req' && p.length === 3) {
      if (guest !== uid) return false;
      var req = getAt(after, path);
      if (!req) return true;
      var st = room.state || {};
      if (st.status !== 'playing' || st.turn !== 2 || req.v !== st.v || req.err) return false;
      return req.t === 'q' || getAt(before, 'hands/' + code + '/guest/' + req.slot) === req.card;
    }
    return false;
  }
  if (p[0] === 'hands' || p[0] === 'secret') return host === uid;
  return false;
};

/** Applies a multi-path update for `uid`: all of it, or nothing. */
FakeFirebase.prototype.write = function (uid, paths) {
  var before = this.tree;
  var after = clone(before) || {};
  var keys = Object.keys(paths);
  var self = this;
  keys.forEach(function (path) { after = setAt(after, path, serverValues(clone(paths[path]))); });
  for (var i = 0; i < keys.length; i++) {
    if (!self.canWrite(before, after, uid, keys[i])) return false;
  }
  // The game state's version must go up by exactly one.
  var codes = {};
  keys.forEach(function (k) { if (parts(k)[0] === 'rooms') codes[parts(k)[1]] = true; });
  for (var code in codes) {
    var s0 = getAt(before, 'rooms/' + code + '/state');
    var s1 = getAt(after, 'rooms/' + code + '/state');
    if (s0 && s1 && JSON.stringify(s0) !== JSON.stringify(s1) && s1.v !== s0.v + 1) return false;
  }
  this.tree = after;
  this.broadcast();
  return true;
};

FakeFirebase.prototype.client = function (page) {
  for (var i = 0; i < this.clients.length; i++) if (this.clients[i].page === page) return this.clients[i];
  var c = { page: page, uid: null, online: true, subs: {}, onDisc: {}, chain: Promise.resolve() };
  this.clients.push(c);
  return c;
};

FakeFirebase.prototype.push = function (c, ev) {
  c.chain = c.chain.then(function () {
    return c.page.evaluate(function (e) { if (window.__fakeDbEvent) window.__fakeDbEvent(e); }, ev);
  }).catch(function () { /* page closed or reloading */ });
};

FakeFirebase.prototype.broadcast = function () {
  var self = this;
  this.clients.forEach(function (c) {
    if (!c.online) return;
    Object.keys(c.subs).forEach(function (path) {
      if (!self.canRead(c.uid, path)) {
        delete c.subs[path];
        self.push(c, { type: 'cancel', path: path });
        return;
      }
      var json = JSON.stringify(getAt(self.tree, path));
      if (json !== c.subs[path]) {
        c.subs[path] = json;
        self.push(c, { type: 'value', path: path, value: JSON.parse(json) });
      }
    });
  });
};

// The connection dropped: the server runs the client's onDisconnect writes.
FakeFirebase.prototype.dropConnection = function (c) {
  var self = this;
  var ops = c.onDisc;
  c.onDisc = {};
  Object.keys(ops).forEach(function (path) {
    var paths = {};
    paths[path] = ops[path];
    self.write(c.uid, paths);
  });
};

FakeFirebase.prototype.handle = function (page, op, args) {
  var c = this.client(page);
  if (args.uid) c.uid = args.uid;
  var path = args.path;
  switch (op) {
    case 'hello':
      this.dropConnection(c);
      c.subs = {};
      return { online: c.online };
    case 'listen':
    case 'get':
      var ok = this.canRead(c.uid, path);
      this.log.push({ uid: c.uid, path: path, ok: ok });
      if (!ok) return { error: 'denied' };
      var value = getAt(this.tree, path);
      if (op === 'listen') c.subs[path] = JSON.stringify(value);
      return { value: clone(value) };
    case 'unlisten':
      delete c.subs[path];
      return {};
    case 'update':
      return this.write(c.uid, args.paths) ? {} : { error: 'denied' };
    case 'onDisconnect':
      c.onDisc[path] = args.value;
      return {};
    case 'onDisconnectCancel':
      delete c.onDisc[path];
      return {};
    default:
      return { error: 'unknown ' + op };
  }
};

/**
 * Hooks a browser context up to this database: serves the fake SDK in place
 * of the real one and a filled-in config file.
 */
FakeFirebase.prototype.attach = async function (context) {
  var self = this;
  await context.exposeBinding('__fakeDb', function (source, op, args) {
    return self.handle(source.page, op, args || {});
  });
  await context.route('**/vendor/firebase/*.js', function (route) {
    var app = /firebase-app-compat\.js$/.test(route.request().url());
    route.fulfill({ contentType: 'text/javascript', body: app ? '(' + browserSdk.toString() + ')();' : '' });
  });
  await context.route('**/js/firebase-config.js', function (route) {
    route.fulfill({
      contentType: 'text/javascript',
      body: 'window.SEQUENCE_FIREBASE_CONFIG = { apiKey: "test", authDomain: "test", ' +
        'databaseURL: "https://test.firebaseio.com", projectId: "test", appId: "test" };'
    });
  });
  context.on('page', function (page) { self.watchClose(page); });
};

FakeFirebase.prototype.watchClose = function (page) {
  var self = this;
  page.on('close', function () {
    var c = self.client(page);
    self.dropConnection(c);
    self.clients = self.clients.filter(function (x) { return x !== c; });
  });
};

/** Simulates losing (false) or getting back (true) the network on one page. */
FakeFirebase.prototype.setOnline = function (page, online) {
  var c = this.client(page);
  if (c.online === online) return;
  if (!online) {
    this.push(c, { type: 'connected', value: false });
    c.online = false;
    this.dropConnection(c);
  } else {
    c.online = true;
    this.push(c, { type: 'connected', value: true });
    this.broadcast();
  }
};

/** Changes the database directly, as the test's "admin". */
FakeFirebase.prototype.adminSet = function (path, value) {
  this.tree = setAt(clone(this.tree) || {}, path, clone(value));
  this.broadcast();
};

FakeFirebase.prototype.get = function (path) { return clone(getAt(this.tree, path)); };

module.exports = FakeFirebase;
