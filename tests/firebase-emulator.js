// Helpers for the Firebase tests:
//  - the official Realtime Database emulator (needs Java 11+; the jar is
//    downloaded once, checked, and kept where the Firebase CLI keeps it:
//    ~/.cache/firebase/emulators, or $FIREBASE_EMULATORS_PATH),
//  - a small stand-in for the Auth emulator that answers the three calls the
//    Firebase SDK makes for anonymous sign-in. Its tokens are unsigned, which
//    the database emulator accepts, just like the Auth emulator's tokens.
'use strict';

var path = require('path');
var fs = require('fs');
var os = require('os');
var net = require('net');
var http = require('http');
var crypto = require('crypto');
var childProcess = require('child_process');

var JAR_NAME = 'firebase-database-emulator-v4.11.2.jar';
var JAR_URL = 'https://storage.googleapis.com/firebase-preview-drop/emulator/' + JAR_NAME;
var JAR_SHA256 = 'b70d99344caf17c98b6f910fa8f6edf32a7c016cb1035e8915f70d38901eb97f';
var CACHE_DIR = process.env.FIREBASE_EMULATORS_PATH || path.join(os.homedir(), '.cache', 'firebase', 'emulators');

async function ensureJar() {
  var file = path.join(CACHE_DIR, JAR_NAME);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  var res = await fetch(JAR_URL);
  if (!res.ok) throw new Error('Could not download the database emulator: HTTP ' + res.status);
  var data = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash('sha256').update(data).digest('hex') !== JAR_SHA256) {
    throw new Error('The database emulator download has the wrong checksum');
  }
  // Both Firebase test files may download at once: write to a file of our
  // own, then rename, so neither ever starts Java on a half-written jar.
  var tmp = file + '.' + process.pid + '.part';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
  return file;
}

function freePort() {
  return new Promise(function (resolve, reject) {
    var srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', function () {
      var port = srv.address().port;
      srv.close(function () { resolve(port); });
    });
  });
}

/** Starts the database emulator. Resolves with { port, url, setRules(ns, rules), stop() }. */
async function startDatabase() {
  var jar = await ensureJar();
  var port = await freePort();
  var proc = childProcess.spawn('java', ['-Duser.language=en', '-jar', jar, '--host', '127.0.0.1', '--port', String(port)], {
    stdio: ['ignore', 'ignore', 'pipe']
  });
  var stderr = '';
  proc.stderr.on('data', function (d) { stderr += d; });
  var url = 'http://127.0.0.1:' + port;
  for (var i = 0; ; i++) {
    try {
      await fetch(url + '/.json?ns=ping');
      break;
    } catch (e) {
      if (i > 120 || proc.exitCode !== null) throw new Error('Database emulator did not start. Is Java 11+ installed?\n' + stderr);
      await new Promise(function (r) { setTimeout(r, 250); });
    }
  }
  return {
    port: port,
    url: url,
    setRules: async function (ns, rules) {
      var res = await fetch(url + '/.settings/rules.json?ns=' + ns, {
        method: 'PUT', headers: { Authorization: 'Bearer owner' }, body: JSON.stringify(rules)
      });
      if (!res.ok) throw new Error('Rules refused: ' + (await res.text()));
    },
    stop: function () { proc.kill(); }
  };
}

function unsignedToken(projectId, uid) {
  function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
  var now = Math.floor(Date.now() / 1000);
  return b64({ alg: 'none', typ: 'JWT' }) + '.' + b64({
    provider_id: 'anonymous', auth_time: now, user_id: uid, sub: uid,
    firebase: { identities: {}, sign_in_provider: 'anonymous' },
    iat: now, exp: now + 3600, aud: projectId, iss: 'https://securetoken.google.com/' + projectId
  }) + '.';
}

/**
 * Answers accounts:signUp, accounts:lookup and token refresh like the Auth
 * emulator does for anonymous users. Resolves with { port, users, stop() }.
 */
async function startAuth(projectId) {
  var users = {};
  var refresh = {};
  var server = http.createServer(function (req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || '*');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    var body = '';
    req.on('data', function (d) { body += d; });
    req.on('end', function () {
      var reply = function (status, data) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      var url = req.url.split('?')[0];
      var input = {};
      try { input = JSON.parse(body || '{}'); } catch (e) {
        input = require('querystring').parse(body);
      }
      if (/accounts:signUp$/.test(url)) {
        var uid = crypto.randomBytes(14).toString('hex');
        var token = crypto.randomBytes(20).toString('hex');
        users[uid] = { localId: uid, createdAt: String(Date.now()), lastLoginAt: String(Date.now()) };
        refresh[token] = uid;
        return reply(200, {
          kind: 'identitytoolkit#SignupNewUserResponse', localId: uid,
          idToken: unsignedToken(projectId, uid), refreshToken: token, expiresIn: '3600'
        });
      }
      if (/accounts:lookup$/.test(url)) {
        var claims = JSON.parse(Buffer.from(String(input.idToken).split('.')[1], 'base64url').toString());
        if (!users[claims.user_id]) return reply(400, { error: { code: 400, message: 'USER_NOT_FOUND' } });
        return reply(200, { kind: 'identitytoolkit#GetAccountInfoResponse', users: [users[claims.user_id]] });
      }
      if (/\/token$/.test(url)) {
        var who = refresh[input.refresh_token];
        if (!who) return reply(400, { error: { code: 400, message: 'INVALID_REFRESH_TOKEN' } });
        return reply(200, {
          access_token: unsignedToken(projectId, who), id_token: unsignedToken(projectId, who),
          expires_in: '3600', token_type: 'Bearer', refresh_token: input.refresh_token, user_id: who
        });
      }
      reply(404, { error: { code: 404, message: 'Not handled by the test stand-in: ' + url } });
    });
  });
  await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
  return { port: server.address().port, users: users, stop: function () { server.close(); } };
}

module.exports = { startDatabase: startDatabase, startAuth: startAuth };
