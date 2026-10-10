// The game with the real Firebase SDK (vendor/firebase) against the
// official Realtime Database emulator running database.rules.json.
// Sign-in goes to a small stand-in for the Auth emulator (see
// firebase-emulator.js). Needs Java 11+. Run: npm run test:firebase
var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');
var playwright = require('playwright');
var createServer = require('./server');
var emulator = require('./firebase-emulator');

var PROJECT = 'demo-sequence';
var NS = PROJECT + '-default-rtdb';
var RULES = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'database.rules.json'), 'utf8'));
var EMU, db, auth, server, baseURL, browser;

test.before(async function () {
  db = await emulator.startDatabase();
  await db.setRules(NS, RULES);
  auth = await emulator.startAuth(PROJECT);
  EMU = { host: '127.0.0.1', authPort: auth.port, dbPort: db.port };
  server = createServer();
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  baseURL = 'http://localhost:' + server.address().port + '/';
  var opts = {};
  if (fs.existsSync('/opt/pw-browsers/chromium')) opts.executablePath = '/opt/pw-browsers/chromium';
  try { browser = await playwright.chromium.launch(opts); } catch (e) { browser = await playwright.chromium.launch(); }
});

test.after(async function () {
  if (browser) await browser.close();
  if (server) server.close();
  if (auth) auth.stop();
  if (db) db.stop();
});

async function openPlayer(hash) {
  var context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(function (emu) {
    window.SEQUENCE_EMULATOR = emu;
    window.SEQUENCE_BOT_DELAY = 150;
  }, EMU);
  await context.route('**/js/firebase-config.js', function (route) {
    route.fulfill({
      contentType: 'text/javascript',
      body: 'window.SEQUENCE_FIREBASE_CONFIG = { apiKey: "demo-key", authDomain: "demo-sequence.firebaseapp.com", ' +
        'databaseURL: "https://' + NS + '.firebaseio.com", projectId: "' + PROJECT + '", appId: "1:1:web:1" };'
    });
  });
  var page = await context.newPage();
  page.setDefaultTimeout(15000);
  var errors = [];
  page.on('pageerror', function (e) { errors.push(e.message); });
  page.on('dialog', function (d) { d.accept(); });
  await page.goto(baseURL + (hash ? '#' + hash : ''));
  return { context: context, page: page, errors: errors };
}

function visible(page, id) {
  return page.waitForSelector('#' + id + ':not([hidden])', { state: 'visible' });
}

async function waitForText(page, selector, re) {
  await page.waitForFunction(function (a) {
    var el = document.querySelector(a.sel);
    return el && new RegExp(a.re).test(el.textContent);
  }, { sel: selector, re: re.source });
}

// Places a chip with the first card that can; a one-eyed jack (which takes a
// chip away) only when nothing else can be played, so tests can count chips.
async function playAnyMove(page) {
  var selectors = ['#board .cell.target', '#board .cell.target-remove'];
  for (var pass = 0; pass < selectors.length; pass++) {
    var cards = await page.$$('#hand .card:not(.empty)');
    for (var k = 0; k < cards.length; k++) {
      await cards[k].click();
      var target = await page.$(selectors[pass]);
      if (target) { await target.click(); return; }
      if (await page.isVisible('#btn-swap')) { await page.click('#btn-swap'); return playAnyMove(page); }
      await cards[k].click();
    }
  }
  throw new Error('no playable card');
}

function handNames(page) {
  return page.$$eval('#hand .card', function (els) {
    return els.map(function (el) { return (el.getAttribute('aria-label') || '').split(',')[0]; });
  });
}

// Reads the database as an admin (the emulator's "owner" token skips the rules).
async function adminGet(path) {
  var res = await fetch('http://' + EMU.host + ':' + EMU.dbPort + '/' + path + '.json?ns=' + NS, {
    headers: { Authorization: 'Bearer owner' }
  });
  return res.json();
}

// Tries a read or write from inside a page, with the page's signed-in user.
function tryInPage(page, op, path, value) {
  return page.evaluate(function (a) {
    var ref = window.firebase.database().ref(a.path);
    var p = a.op === 'read' ? ref.once('value') : ref.set(a.value);
    return p.then(function () { return 'allowed'; }, function (e) { return e.code || e.message; });
  }, { op: op, path: path, value: value === undefined ? null : value });
}

test('real SDK + emulators: create, join, play, refresh and rules', async function () {
  var host = await openPlayer();
  await visible(host.page, 'screen-home');
  await host.page.fill('#name', 'Ayesha');
  await host.page.selectOption('#level', 'hard');
  await host.page.click('#btn-create');
  await visible(host.page, 'screen-lobby');
  var code = (await host.page.textContent('#lobby-code')).trim();
  await waitForText(host.page, '#conn', /Online/);

  var guest = await openPlayer(code);
  await visible(guest.page, 'screen-home');
  await waitForText(guest.page, '#home-msg', /Ayesha invited you/);
  await guest.page.fill('#name', 'Bilal');
  await guest.page.click('#btn-join');
  await visible(guest.page, 'screen-lobby');
  await host.page.waitForFunction(function () { return !document.getElementById('btn-start').disabled; });
  await host.page.click('#btn-start');
  await visible(guest.page, 'screen-game');

  await waitForText(host.page, '#turn', /Your turn/);
  await playAnyMove(host.page);
  await waitForText(guest.page, '#turn', /Your turn/);
  await playAnyMove(guest.page);
  await waitForText(host.page, '#turn', /Your turn/);
  await waitForText(guest.page, '#turn', /Ayesha's turn/);

  var room = await adminGet('rooms/' + code);
  assert.equal(room.state.status, 'playing');
  assert.equal(room.state.board.replace(/\./g, '').length, 4);
  assert.equal(room.presence.host.on, true);
  assert.equal(room.presence.guest.on, true);
  assert.ok(!room.req, 'the guest request was applied and cleared');
  var secret = await adminGet('secret/' + code);
  assert.equal(secret.v, room.state.v);
  assert.equal(secret.deck.length, room.state.deck);

  // The rules hold for the real client too.
  assert.equal(await tryInPage(guest.page, 'read', 'hands/' + code + '/host'), 'PERMISSION_DENIED');
  assert.equal(await tryInPage(guest.page, 'read', 'secret/' + code), 'PERMISSION_DENIED');
  assert.equal(await tryInPage(guest.page, 'write', 'rooms/' + code + '/state/turn', 2), 'PERMISSION_DENIED');
  assert.equal(await tryInPage(host.page, 'read', 'hands/' + code + '/guest'), 'PERMISSION_DENIED');
  assert.equal(await tryInPage(guest.page, 'read', 'hands/' + code + '/guest'), 'allowed');

  // Refresh: same anonymous account, same seat and hand.
  var hand = await handNames(guest.page);
  await guest.page.reload();
  await visible(guest.page, 'screen-game');
  await waitForText(guest.page, '#seats', /Bilal \(you\)/);
  assert.deepEqual(await handNames(guest.page), hand);

  // The host opens the game in a second tab: both tabs run the bots, but the
  // version check lets only one write through, so no bot moves twice.
  var tab2 = await host.context.newPage();
  tab2.on('dialog', function (d) { d.accept(); });
  await tab2.goto(baseURL + '#' + code);
  await visible(tab2, 'screen-game');
  await waitForText(tab2, '#seats', /Ayesha \(you\)/);
  for (var round = 0; round < 3; round++) {
    await waitForText(host.page, '#turn', /Your turn/);
    await playAnyMove(host.page);
    await waitForText(guest.page, '#turn', /Your turn/);
    await playAnyMove(guest.page);
  }
  await waitForText(host.page, '#turn', /Your turn/);
  await waitForText(tab2, '#turn', /Your turn/);
  var state = (await adminGet('rooms/' + code)).state;
  var moves = state.log.filter(function (e) { return e.k === 'p' || e.k === 'r'; });
  var seats = moves.map(function (e) { return e.s; }).join('');
  assert.match(seats, /^(0123)+$/, 'one move per seat per round, in order: ' + seats);
  assert.equal(state.board.replace(/\./g, '').length + 2 * moves.filter(function (e) { return e.k === 'r'; }).length,
    moves.length, 'one chip per move');
  await tab2.close();

  // Losing the network: the indicator says so, and comes back.
  await guest.context.setOffline(true);
  await waitForText(guest.page, '#conn', /Offline/);
  await guest.context.setOffline(false);
  await waitForText(guest.page, '#conn', /Online/);

  // Closing the tab: the server's onDisconnect marks the guest offline.
  await guest.context.close();
  await host.page.waitForSelector('#seats li:nth-child(3) .presence.is-off');
  assert.equal((await adminGet('rooms/' + code + '/presence/guest')).on, false);

  assert.deepEqual(host.errors.concat(guest.errors), []);
  await host.context.close();
});
