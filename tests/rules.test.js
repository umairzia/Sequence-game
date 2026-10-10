// Tests database.rules.json against the official Firebase Realtime
// Database emulator. Needs Java 11+; the emulator (about 34 MB) is
// downloaded once (see firebase-emulator.js). Run: npm run test:firebase
var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');
var emulator = require('./firebase-emulator');

var RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8'));
var NS = 'sequence-rules-test';
var db, BASE;

// Unsigned ID token for a signed-in (anonymous) user. The emulator accepts
// these without checking the signature, like Firebase's own test tools.
function token(uid) {
  function b64(o) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }
  var now = Math.floor(Date.now() / 1000);
  return b64({ alg: 'none', type: 'JWT' }) + '.' + b64({
    iss: 'https://securetoken.google.com/demo-sequence', aud: 'demo-sequence',
    iat: now, exp: now + 3600, auth_time: now, sub: uid, user_id: uid,
    firebase: { sign_in_provider: 'anonymous', identities: {} }
  }) + '.';
}

// REST call as `who`: a uid, 'owner' (admin, ignores the rules) or null.
// The user's token goes in ?auth=: the emulator treats any Authorization
// header as an admin, which would skip the rules.
async function call(method, who, dbPath, body) {
  var headers = { 'Content-Type': 'application/json' };
  var url = BASE + '/' + dbPath + '.json?ns=' + NS;
  if (who === 'owner') headers.Authorization = 'Bearer owner';
  else if (who) url += '&auth=' + token(who);
  var res = await fetch(url, {
    method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  var text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function allowed(promise, what) {
  var res = await promise;
  assert.equal(res.status, 200, what + ' should be allowed, got ' + JSON.stringify(res.body));
  return res.body;
}

async function denied(promise, what) {
  var res = await promise;
  assert.equal(res.status, 401, what + ' should be denied, got ' + res.status + ' ' + JSON.stringify(res.body));
}

function read(who, p) { return call('GET', who, p); }
function put(who, p, v) { return call('PUT', who, p, v); }
function remove(who, p) { return call('DELETE', who, p); }
// Several paths in one atomic update, like ref().update() in the app.
function update(who, paths) { return call('PATCH', who, '', paths); }

var HOST = 'host-uid', GUEST = 'guest-uid', STRANGER = 'stranger-uid';

function newRoom(hostUid) {
  return {
    created: Date.now() - 1000,
    players: { host: { uid: hostUid || HOST, name: 'Ayesha' } },
    state: { v: 1, status: 'lobby', diff: 'normal' }
  };
}

function playingState(v, turn) {
  return { v: v, status: 'playing', game: 1, first: 0, turn: turn, board: new Array(101).join('.'), deck: 80 };
}

// A room with both players, a game on and the guest to play.
async function setUpGame(code) {
  await call('PUT', 'owner', 'rooms/' + code, {
    created: Date.now() - 1000,
    players: { host: { uid: HOST, name: 'Ayesha' }, guest: { uid: GUEST, name: 'Bilal' } },
    state: playingState(7, 2)
  });
  await call('PUT', 'owner', 'hands/' + code, {
    host: ['AS', 'KD', '2C', '3C', '4C', '5C'],
    guest: ['7H', 'JD', 'QS', '9C', 'TH', 'JS']
  });
  await call('PUT', 'owner', 'secret/' + code, { v: 7, deck: ['2H', '3H'], bots: { s1: ['4H'], s3: ['5H'] } });
}

test.before(async function () {
  db = await emulator.startDatabase();
  BASE = db.url;
  await db.setRules(NS, RULES);
});

test.after(function () {
  if (db) db.stop();
});

test('creating a room: only for yourself, only once, only a valid code', async function () {
  await allowed(put(HOST, 'rooms/ABCD', newRoom()), 'host creates a room');
  await denied(put(STRANGER, 'rooms/ABCD', newRoom(STRANGER)), 'taking over an existing room');
  await denied(put(null, 'rooms/ABCE', newRoom()), 'creating a room without signing in');
  await denied(put(STRANGER, 'rooms/ABCF', newRoom(HOST)), 'creating a room for someone else');
  await denied(put(HOST, 'rooms/abcd', newRoom()), 'lower-case code');
  await denied(put(HOST, 'rooms/ABCI', newRoom()), 'code with an I (looks like 1)');
  await denied(put(HOST, 'rooms/ABCDE', newRoom()), 'five-letter code');
  var bad = newRoom();
  bad.extra = true;
  await denied(put(HOST, 'rooms/ABCG', bad), 'unknown field');
  bad = newRoom();
  bad.players.host.name = '';
  await denied(put(HOST, 'rooms/ABCH', bad), 'empty name');
});

test('outsiders see only who is in a room, never the game', async function () {
  await put(HOST, 'rooms/BCDE', newRoom());
  var players = await allowed(read(STRANGER, 'rooms/BCDE/players'), 'reading the seats');
  assert.equal(players.host.name, 'Ayesha');
  await denied(read(STRANGER, 'rooms/BCDE'), 'reading the room');
  await denied(read(STRANGER, 'rooms/BCDE/state'), 'reading the game');
  await denied(read(null, 'rooms/BCDE/players'), 'reading without signing in');
  await denied(read(HOST, 'rooms'), 'listing all rooms');
  await allowed(read(HOST, 'rooms/BCDE'), 'host reads own room');
});

test('joining: the first person takes the guest seat, then it is closed', async function () {
  await put(HOST, 'rooms/CDEF', newRoom());
  await denied(put(GUEST, 'rooms/CDEF/players/guest', { uid: STRANGER, name: 'Bilal' }), 'joining as someone else');
  await allowed(put(GUEST, 'rooms/CDEF/players/guest', { uid: GUEST, name: 'Bilal' }), 'guest joins');
  await denied(put(STRANGER, 'rooms/CDEF/players/guest', { uid: STRANGER, name: 'Eve' }), 'third person joins');
  await allowed(read(GUEST, 'rooms/CDEF'), 'guest reads the room');
  await allowed(put(GUEST, 'rooms/CDEF/players/guest/name', 'Bilal K'), 'guest renames');
  await denied(put(GUEST, 'rooms/CDEF/players/guest/uid', STRANGER), 'guest hands the seat on');
  await denied(put(GUEST, 'rooms/CDEF/players/host', { uid: GUEST, name: 'x' }), 'guest takes the host seat');
  await denied(put(GUEST, 'rooms/NOPE/players/guest', { uid: GUEST, name: 'Bilal' }), 'joining a room that does not exist');
  // Leaving frees the seat.
  await allowed(remove(GUEST, 'rooms/CDEF/players/guest'), 'guest leaves');
  await allowed(put(STRANGER, 'rooms/CDEF/players/guest', { uid: STRANGER, name: 'Eve' }), 'someone else joins');
  await denied(read(GUEST, 'rooms/CDEF'), 'the old guest can no longer read');
});

test('presence: each person sets only their own', async function () {
  await setUpGame('DEFG');
  var on = { on: true, at: Date.now() };
  await allowed(put(GUEST, 'rooms/DEFG/presence/guest', on), 'guest presence');
  await denied(put(GUEST, 'rooms/DEFG/presence/host', on), 'guest sets host presence');
  await allowed(put(HOST, 'rooms/DEFG/presence/host', on), 'host presence');
  await denied(put(STRANGER, 'rooms/DEFG/presence/guest', on), 'outsider sets presence');
  await denied(put(GUEST, 'rooms/DEFG/presence/guest', { on: 'yes', at: 1 }), 'bad presence value');
});

test('game state: only the host writes it, one version at a time', async function () {
  await setUpGame('EFGH');
  await allowed(put(HOST, 'rooms/EFGH/state', playingState(8, 3)), 'host writes the next version');
  await denied(put(HOST, 'rooms/EFGH/state', playingState(8, 0)), 'host writes a stale version');
  await denied(put(HOST, 'rooms/EFGH/state/turn', 1), 'changing a field without a new version');
  await denied(put(GUEST, 'rooms/EFGH/state', playingState(9, 0)), 'guest writes the game');
  await denied(put(STRANGER, 'rooms/EFGH/state', playingState(9, 0)), 'outsider writes the game');
  await denied(put(GUEST, 'rooms/EFGH/created', 5), 'guest changes the room');
});

test('hands: each person reads only their own; only the host deals', async function () {
  await setUpGame('FGHJ');
  var mine = await allowed(read(GUEST, 'hands/FGHJ/guest'), 'guest reads own hand');
  assert.deepEqual(mine, ['7H', 'JD', 'QS', '9C', 'TH', 'JS']);
  await denied(read(GUEST, 'hands/FGHJ/host'), 'guest reads the host hand');
  await denied(read(GUEST, 'hands/FGHJ'), 'guest reads all hands');
  await allowed(read(HOST, 'hands/FGHJ/host'), 'host reads own hand');
  await denied(read(HOST, 'hands/FGHJ/guest'), 'host reads the guest hand');
  await denied(read(STRANGER, 'hands/FGHJ/guest'), 'outsider reads a hand');
  await denied(put(GUEST, 'hands/FGHJ/guest/0', 'JD'), 'guest deals itself a card');
  await allowed(put(HOST, 'hands/FGHJ/guest/0', '8D'), 'host deals the guest a card');
  await denied(put(HOST, 'hands/FGHJ/guest/0', 'XX'), 'dealing something that is not a card');
  await denied(put(HOST, 'hands/FGHJ/guest/6', '8D'), 'a seventh card');
  await denied(put(HOST, 'hands/FGHJ/bot', ['8D']), 'a hand for an unknown seat');
});

test('deck and bot hands: only the host can see them', async function () {
  await setUpGame('GHJK');
  await allowed(read(HOST, 'secret/GHJK'), 'host reads the deck');
  await denied(read(GUEST, 'secret/GHJK'), 'guest reads the deck');
  await denied(read(GUEST, 'secret/GHJK/deck'), 'guest reads the deck directly');
  await denied(read(STRANGER, 'secret/GHJK'), 'outsider reads the deck');
  await denied(put(GUEST, 'secret/GHJK/deck', ['JD', 'JC']), 'guest stacks the deck');
  await denied(read(GUEST, 'secret'), 'guest lists all decks');
});

test('guest moves: only on their turn, for the current version, with a card they hold', async function () {
  await setUpGame('HJKL');
  var ok = { id: 'r1', v: 7, t: 'p', slot: '2', card: 'QS', i: 29 };
  await denied(put(GUEST, 'rooms/HJKL/req', Object.assign({}, ok, { card: 'JD' })), 'a card not in that slot');
  await denied(put(GUEST, 'rooms/HJKL/req', Object.assign({}, ok, { v: 6 })), 'an old version');
  await denied(put(GUEST, 'rooms/HJKL/req', Object.assign({}, ok, { err: 'x' })), 'setting an error');
  await denied(put(GUEST, 'rooms/HJKL/req', Object.assign({}, ok, { slot: '7' })), 'a slot that does not exist');
  await denied(put(STRANGER, 'rooms/HJKL/req', ok), 'outsider moves');
  await allowed(put(GUEST, 'rooms/HJKL/req', ok), 'guest moves');
  await allowed(put(GUEST, 'rooms/HJKL/req', { id: 'r2', v: 7, t: 'q' }), 'guest passes');
  await allowed(put(HOST, 'rooms/HJKL/req/err', 'That space is taken.'), 'host turns the move down');
  await allowed(remove(GUEST, 'rooms/HJKL/req'), 'guest clears the request');

  // Not the guest's turn any more.
  await call('PUT', 'owner', 'rooms/HJKL/state', playingState(8, 3));
  await denied(put(GUEST, 'rooms/HJKL/req', Object.assign({}, ok, { v: 8 })), 'moving out of turn');
});

test('the host applies a move in one atomic update, and a stale copy is refused', async function () {
  await setUpGame('JKLM');
  await put(GUEST, 'rooms/JKLM/req', { id: 'r1', v: 7, t: 'p', slot: '2', card: 'QS', i: 29 });
  var move = {
    'rooms/JKLM/state': playingState(8, 3),
    'rooms/JKLM/req': null,
    'hands/JKLM/guest/2': '3H',
    'secret/JKLM': { v: 8, deck: ['2H'], discard: ['QS'], bots: { s1: ['4H'], s3: ['5H'] } }
  };
  await allowed(update(HOST, move), 'host applies the guest move');
  var hand = await allowed(read(GUEST, 'hands/JKLM/guest'), 'guest reads new hand');
  assert.equal(hand[2], '3H');
  // A second tab of the host working from the same old version is refused as a whole.
  move['hands/JKLM/guest/2'] = '2H';
  await denied(update(HOST, move), 'the same move again');
  hand = (await read(GUEST, 'hands/JKLM/guest')).body;
  assert.equal(hand[2], '3H', 'nothing from the refused update was written');
  await denied(update(GUEST, { 'rooms/JKLM/state': playingState(9, 0), 'rooms/JKLM/req': null }), 'guest bundles a state change');
});

test('deleting a room: only the host', async function () {
  await setUpGame('KLMN');
  var all = { 'rooms/KLMN': null, 'hands/KLMN': null, 'secret/KLMN': null };
  await denied(update(GUEST, all), 'guest deletes the room');
  await denied(update(STRANGER, all), 'outsider deletes the room');
  await allowed(update(HOST, all), 'host deletes the room');
  var left = await call('GET', 'owner', 'rooms/KLMN');
  assert.equal(left.body, null);
});
