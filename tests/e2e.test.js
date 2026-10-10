// Browser tests for the Sequence game: two players in separate browsers
// against the bots. Firebase is replaced by tests/fake-firebase.js, so the
// tests run offline. Run: npm run test:e2e
var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');
var playwright = require('playwright');
var createServer = require('./server');
var FakeFirebase = require('./fake-firebase');

var SCREENSHOT_DIR = path.join(__dirname, '..', 'test-results');
var PHONE = { width: 390, height: 844 };
var server, baseURL, browser;

test.before(async function () {
  server = createServer();
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve); });
  baseURL = 'http://localhost:' + server.address().port + '/';
  var opts = {};
  if (fs.existsSync('/opt/pw-browsers/chromium')) opts.executablePath = '/opt/pw-browsers/chromium';
  try { browser = await playwright.chromium.launch(opts); } catch (e) { browser = await playwright.chromium.launch(); }
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
});

test.after(async function () {
  if (browser) await browser.close();
  if (server) server.close();
});

// One player's phone (or laptop with { viewport }), with its own storage.
async function openPlayer(fake, opts) {
  opts = opts || {};
  var context = await browser.newContext({
    viewport: opts.viewport || PHONE,
    deviceScaleFactor: 2,
    isMobile: !opts.viewport,
    hasTouch: !opts.viewport,
    serviceWorkers: 'block'
  });
  if (fake) await fake.attach(context);
  if (opts.emptyConfig) {
    await context.route('**/js/firebase-config.js', function (route) {
      route.fulfill({ contentType: 'text/javascript', body: 'window.SEQUENCE_FIREBASE_CONFIG = { apiKey: "", databaseURL: "", projectId: "" };' });
    });
  }
  await context.addInitScript(function () { window.SEQUENCE_BOT_DELAY = 120; });
  var page = await context.newPage();
  page.setDefaultTimeout(10000);
  var errors = [];
  page.on('pageerror', function (e) { errors.push(e.message); });
  // The real page may confirm before leaving or passing.
  page.on('dialog', function (d) { d.accept(); });
  await page.goto(baseURL + (opts.hash ? '#' + opts.hash : ''));
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

function text(page, selector) { return page.textContent(selector); }

/** The player's cards, in slot order, as "10 of hearts"-style names. */
function handNames(page) {
  return page.$$eval('#hand .card', function (els) {
    return els.map(function (el) { return (el.getAttribute('aria-label') || '').split(',')[0]; });
  });
}

/** Board as a 100-character string: . empty, 0 blue, 1 red. */
function boardOf(page) {
  return page.$$eval('#board .cell', function (els) {
    return els.map(function (el) {
      return /has-0/.test(el.className) ? '0' : /has-1/.test(el.className) ? '1' : '.';
    }).join('');
  });
}

/**
 * Places a chip with the first card that can, on its first space. A one-eyed
 * jack (which takes a chip away) is used only when nothing else can be
 * played, so tests can count the chips on the board.
 */
async function playAnyMove(page) {
  var selectors = ['#board .cell.target', '#board .cell.target-remove'];
  for (var pass = 0; pass < selectors.length; pass++) {
    var cards = await page.$$('#hand .card:not(.empty)');
    for (var k = 0; k < cards.length; k++) {
      await cards[k].click();
      var target = await page.$(selectors[pass]);
      if (target) {
        var label = await target.getAttribute('aria-label');
        await target.click();
        return label;
      }
      if (await page.isVisible('#btn-swap')) {
        await page.click('#btn-swap');
        return playAnyMove(page);
      }
      await cards[k].click(); // unselect
    }
  }
  throw new Error('no playable card');
}

async function createRoom(fake, name, level) {
  var host = await openPlayer(fake);
  await visible(host.page, 'screen-home');
  await host.page.fill('#name', name || 'Ayesha');
  if (level) await host.page.selectOption('#level', level);
  await host.page.click('#btn-create');
  await visible(host.page, 'screen-lobby');
  host.code = (await text(host.page, '#lobby-code')).trim();
  return host;
}

async function joinRoom(fake, code, name) {
  var guest = await openPlayer(fake, { hash: code });
  await visible(guest.page, 'screen-home');
  await guest.page.fill('#name', name || 'Bilal');
  await guest.page.click('#btn-join');
  await visible(guest.page, 'screen-lobby');
  return guest;
}

// Hard bots never make random moves, so the tests can count chips.
async function startedGame(fake) {
  var host = await createRoom(fake, 'Ayesha', 'hard');
  var guest = await joinRoom(fake, host.code);
  await host.page.waitForFunction(function () { return !document.getElementById('btn-start').disabled; });
  await host.page.click('#btn-start');
  await visible(host.page, 'screen-game');
  await visible(guest.page, 'screen-game');
  return { host: host, guest: guest, code: host.code };
}

async function closeAll() {
  for (var i = 0; i < arguments.length; i++) if (arguments[i]) await arguments[i].context.close();
}

test('shows the set-up steps until Firebase is configured', async function () {
  var p = await openPlayer(null, { emptyConfig: true });
  await visible(p.page, 'screen-setup');
  assert.match(await text(p.page, '#screen-setup'), /firebase-config\.js/);
  assert.match(await text(p.page, '#conn'), /Not set up/);
  assert.deepEqual(p.errors, []);
  await closeAll(p);
});

test('says so when the database rules have not been published', async function () {
  var fake = new FakeFirebase();
  fake.canRead = function () { return false; };
  fake.canWrite = function () { return false; };
  var p = await openPlayer(fake);
  await visible(p.page, 'screen-home');
  await p.page.fill('#name', 'Ayesha');
  await p.page.click('#btn-create');
  await waitForText(p.page, '#home-msg', /published database\.rules\.json/);
  assert.equal(await p.page.isDisabled('#btn-create'), false);
  assert.deepEqual(p.errors, []);
  await closeAll(p);
});

test('host creates a room, the guest joins with the link, and the lobby shows both', async function () {
  var fake = new FakeFirebase();
  var host = await createRoom(fake, 'Ayesha', 'hard');
  assert.match(host.code, /^[A-HJ-NP-Z]{4}$/);
  assert.match(await text(host.page, '#lobby-players'), /Waiting for your friend/);
  assert.equal(await host.page.isDisabled('#btn-start'), true);
  assert.match(await text(host.page, '#room-chip'), new RegExp(host.code));

  var guest = await openPlayer(fake, { hash: host.code });
  await visible(guest.page, 'screen-home');
  assert.equal(await guest.page.inputValue('#join-code'), host.code);
  assert.match(await text(guest.page, '#home-msg'), /Ayesha invited you/);
  await guest.page.fill('#name', 'Bilal');
  await guest.page.click('#btn-join');
  await visible(guest.page, 'screen-lobby');
  await waitForText(guest.page, '#lobby-msg', /Waiting for Ayesha to start/);
  assert.match(await text(guest.page, '#lobby-players'), /Hard/);
  assert.equal(await guest.page.isVisible('#btn-start'), false, 'only the host starts');

  await waitForText(host.page, '#lobby-players', /Bilal/);
  await host.page.waitForFunction(function () { return !document.getElementById('btn-start').disabled; });
  await host.page.screenshot({ path: path.join(SCREENSHOT_DIR, 'lobby-host.png') });

  // A third person can't take a seat.
  var third = await openPlayer(fake, { hash: host.code });
  await waitForText(third.page, '#home-msg', /already has two players/);
  await third.page.fill('#name', 'Eve');
  await third.page.click('#btn-join');
  await waitForText(third.page, '#home-msg', /already has two players/);
  assert.equal(fake.get('rooms/' + host.code + '/players/guest/name'), 'Bilal');

  assert.deepEqual(host.errors.concat(guest.errors, third.errors), []);
  await closeAll(host, guest, third);
});

test('both players see the same game; the host runs the bots and the guest only sends its moves', async function () {
  var fake = new FakeFirebase();
  var g = await startedGame(fake);
  var host = g.host, guest = g.guest, code = g.code;

  await waitForText(host.page, '#turn', /Your turn/);
  await waitForText(guest.page, '#turn', /Ayesha's turn/);
  assert.match(await text(host.page, '#conn'), /Online/);
  assert.match(await text(guest.page, '#conn'), /Online/);
  assert.equal((await handNames(host.page)).length, 6);
  assert.match(await host.page.getAttribute('#seats li:nth-child(1)', 'class'), /is-turn/);

  // Host plays; Bot A answers; then it is the guest's turn.
  await playAnyMove(host.page);
  await waitForText(guest.page, '#turn', /Your turn/);
  await waitForText(host.page, '#turn', /Bilal's turn/);
  var board = await boardOf(guest.page);
  assert.equal(board.replace(/[^0]/g, '').length, 1, 'one blue chip');
  assert.equal(board.replace(/[^1]/g, '').length, 1, 'one red chip');
  assert.equal(await boardOf(host.page), board);
  await guest.page.screenshot({ path: path.join(SCREENSHOT_DIR, 'game-guest-turn.png') });

  // The guest plays; the host applies it and deals the replacement card.
  var deckBefore = Number(/(\d+) cards left/.exec(await text(guest.page, '#pile'))[1]);
  await playAnyMove(guest.page);
  await waitForText(host.page, '#turn', /Your turn/);
  await waitForText(guest.page, '#turn', /Ayesha's turn/);
  assert.equal(Number(/(\d+) cards left/.exec(await text(guest.page, '#pile'))[1]), deckBefore - 2, 'guest and Bot B drew');
  assert.equal((await handNames(guest.page)).filter(function (n) { return n && n !== 'Empty'; }).length, 6);
  assert.equal((await boardOf(host.page)).replace(/[^0]/g, '').length, 2);
  assert.equal(await boardOf(guest.page), await boardOf(host.page));
  assert.match(await text(guest.page, '#log'), /Bilal|You/);

  // Hands and the deck never reach the other player.
  var guestUid = fake.get('rooms/' + code + '/players/guest/uid');
  var hostUid = fake.get('rooms/' + code + '/players/host/uid');
  fake.log.forEach(function (r) {
    if (r.uid === guestUid) assert.ok(!/^(hands\/\w+\/host|secret)/.test(r.path), 'guest read ' + r.path);
    if (r.uid === hostUid) assert.ok(!/^hands\/\w+\/guest/.test(r.path), 'host read ' + r.path);
  });
  var state = fake.get('rooms/' + code + '/state');
  assert.equal(typeof state.deck, 'number', 'only the number of cards left is public');
  assert.ok(!/"(hands|bots)"/.test(JSON.stringify(fake.get('rooms/' + code))), 'no hands in the room');
  assert.equal(fake.get('rooms/' + code + '/req'), null, 'request cleared');

  await host.page.setViewportSize({ width: 1280, height: 800 });
  await host.page.waitForTimeout(200);
  await host.page.screenshot({ path: path.join(SCREENSHOT_DIR, 'game-host-desktop.png') });
  assert.deepEqual(host.errors.concat(guest.errors), []);
  await closeAll(host, guest);
});

test('refreshing or reopening the room brings back the same seat and hand', async function () {
  var fake = new FakeFirebase();
  var g = await startedGame(fake);
  var host = g.host, guest = g.guest, code = g.code;
  await waitForText(host.page, '#turn', /Your turn/);
  await playAnyMove(host.page);
  await waitForText(guest.page, '#turn', /Your turn/);

  // The guest refreshes on its own turn.
  var hand = await handNames(guest.page);
  var board = await boardOf(guest.page);
  await guest.page.reload();
  await visible(guest.page, 'screen-game');
  await waitForText(guest.page, '#turn', /Your turn/);
  assert.deepEqual(await handNames(guest.page), hand);
  assert.equal(await boardOf(guest.page), board);
  assert.match(await text(guest.page, '#seats li:nth-child(3)'), /Bilal \(you\)/);

  // ... then goes to the start page and continues the room from there.
  await guest.page.goto(baseURL);
  await guest.page.reload();
  await visible(guest.page, 'screen-home');
  await waitForText(guest.page, '#resume-code', new RegExp(code));
  await guest.page.click('#btn-resume');
  await visible(guest.page, 'screen-game');
  assert.deepEqual(await handNames(guest.page), hand);

  // Typing the room code in Join works too.
  await guest.page.goto(baseURL);
  await guest.page.reload();
  await visible(guest.page, 'screen-home');
  await guest.page.fill('#join-code', code.toLowerCase());
  await guest.page.click('#btn-join');
  await visible(guest.page, 'screen-game');
  assert.deepEqual(await handNames(guest.page), hand);
  await playAnyMove(guest.page);

  // The host refreshes while it is a bot's turn: the bots carry on.
  var hostHand = await handNames(host.page);
  await host.page.reload();
  await visible(host.page, 'screen-game');
  await waitForText(host.page, '#turn', /Your turn/);
  assert.deepEqual(await handNames(host.page), hostHand);
  assert.equal((await boardOf(host.page)).replace(/\./g, '').length, 4, 'two blue and two red chips');
  assert.deepEqual(host.errors.concat(guest.errors), []);
  await closeAll(host, guest);
});

test('a guest on a new phone gets the same seat and cards after the host frees the seat', async function () {
  var fake = new FakeFirebase();
  var g = await startedGame(fake);
  var host = g.host, guest = g.guest, code = g.code;
  await waitForText(host.page, '#turn', /Your turn/);
  await playAnyMove(host.page);
  await waitForText(guest.page, '#turn', /Your turn/);
  var hand = await handNames(guest.page);
  assert.equal(await host.page.isVisible('#btn-free-seat'), false, 'only offered while the guest is away');

  // The guest's phone is gone: a new browser is a new anonymous account.
  await guest.context.close();
  await host.page.waitForSelector('#btn-free-seat:not([hidden])');
  var other = await openPlayer(fake, { hash: code });
  await waitForText(other.page, '#home-msg', /already has two players/);

  await host.page.click('#btn-free-seat');
  await waitForText(host.page, '#turn', /seat is free/);
  await other.page.fill('#name', 'Bilal');
  await other.page.click('#btn-join');
  await visible(other.page, 'screen-game');
  await waitForText(other.page, '#turn', /Your turn/);
  assert.deepEqual(await handNames(other.page), hand);
  await waitForText(host.page, '#turn', /Bilal's turn/);
  await playAnyMove(other.page);
  await waitForText(host.page, '#turn', /Your turn/);
  assert.deepEqual(host.errors.concat(other.errors), []);
  await closeAll(host, other);
});

test('connection indicator and partner presence follow the network', async function () {
  var fake = new FakeFirebase();
  var g = await startedGame(fake);
  var host = g.host, guest = g.guest;
  await waitForText(host.page, '#turn', /Your turn/);
  await host.page.waitForSelector('#seats li:nth-child(3) .presence.is-on');

  fake.setOnline(guest.page, false);
  await waitForText(guest.page, '#conn', /Offline/);
  await host.page.waitForSelector('#seats li:nth-child(3) .presence.is-off');

  fake.setOnline(guest.page, true);
  await waitForText(guest.page, '#conn', /Online/);
  await host.page.waitForSelector('#seats li:nth-child(3) .presence.is-on');

  // The host drops out: the guest's move waits for the host to come back.
  await playAnyMove(host.page);
  await waitForText(guest.page, '#turn', /Your turn/);
  fake.setOnline(host.page, false);
  await waitForText(host.page, '#conn', /Offline/);
  await guest.page.waitForSelector('#seats li:nth-child(1) .presence.is-off');
  await playAnyMove(guest.page);
  await waitForText(guest.page, '#turn', /Your move is saved\. It will be played when Ayesha \(host\) is back online/);
  await guest.page.waitForTimeout(400);
  assert.equal(fake.get('rooms/' + g.code + '/req').t !== undefined, true, 'the request waits in the room');
  fake.setOnline(host.page, true);
  await waitForText(host.page, '#conn', /Online/);
  await waitForText(host.page, '#turn', /Your turn/);
  await waitForText(guest.page, '#turn', /Ayesha's turn/);
  assert.equal((await boardOf(guest.page)).replace(/\./g, '').length, 4);

  // Closing the tab marks the player offline for the other one.
  await guest.context.close();
  await host.page.waitForSelector('#seats li:nth-child(3) .presence.is-off');
  assert.deepEqual(host.errors, []);
  await closeAll(host);
});

test('dead cards are swapped, one-eyed jacks remove, and two sequences win', async function () {
  var fake = new FakeFirebase();
  var g = await startedGame(fake);
  var host = g.host, guest = g.guest, code = g.code;
  await waitForText(host.page, '#turn', /Your turn/);

  // Set up a position: blue already has one sequence (row 2) and four in a
  // row on row 9; both 4H spaces are taken; a red chip on 9H.
  var E = require('../js/engine.js');
  var b = E.emptyBoard();
  [10, 11, 12, 13, 14, 81, 82, 83, 84].forEach(function (i) { b = E.setCell(b, i, '0'); });
  E.CELLS_FOR['4H'].forEach(function (i) { b = E.setCell(b, i, '1'); });
  b = E.setCell(b, E.CELLS_FOR['9H'][0], '1');
  var state = fake.get('rooms/' + code + '/state');
  var v = state.v + 1;
  state.v = v;
  state.board = b;
  state.turn = 2;
  state.seqs = [{ t: 0, c: [10, 11, 12, 13, 14] }];
  fake.adminSet('hands/' + code + '/guest', ['4H', 'JS', '2C', '2D', '7C', '8C']);
  fake.adminSet('hands/' + code + '/host', ['3S', 'KD', 'QD', '9D', '8D', '7D']);
  var secret = fake.get('secret/' + code);
  secret.v = v;
  secret.bots.s3 = ['2C', '3C', '4C', '5C', '6C', '7C']; // Bot B can't block row 9
  fake.adminSet('secret/' + code, secret);
  fake.adminSet('rooms/' + code + '/state', state);
  await waitForText(guest.page, '#turn', /Your turn/);

  // 4H is dead: swap it. The turn stays with the guest.
  await guest.page.click('#hand .card:nth-child(1)');
  await waitForText(guest.page, '#turn', /dead/);
  await guest.page.click('#btn-swap');
  await waitForText(guest.page, '#log', /You swapped a dead 4/);
  await waitForText(guest.page, '#turn', /Your turn/);
  assert.equal(await guest.page.isVisible('#btn-swap'), false, 'one swap per turn');

  // One-eyed jack: remove the red chip on 9H.
  await guest.page.click('#hand .card:nth-child(2)');
  var targets = await guest.page.$$('#board .cell.target-remove');
  assert.equal(targets.length, 3, 'three red chips, none in a sequence');
  await guest.page.click('#board .cell[data-i="' + E.CELLS_FOR['9H'][0] + '"]');
  await waitForText(host.page, '#log', /Bilal used J/);
  await guest.page.waitForFunction(function (i) {
    return !/has-1/.test(document.querySelector('#board .cell[data-i="' + i + '"]').className);
  }, E.CELLS_FOR['9H'][0]);

  // Back to the host: 3S on row 9 completes the second sequence.
  await waitForText(host.page, '#turn', /Your turn/);
  await host.page.click('#hand .card:nth-child(1)');
  await host.page.click('#board .cell[data-i="85"]');
  await visible(host.page, 'over');
  await visible(guest.page, 'over');
  assert.match(await text(host.page, '#over-title'), /You win/);
  assert.match(await text(guest.page, '#over-title'), /You win/);
  assert.match(await text(guest.page, '#over-wait'), /Waiting for Ayesha/);
  assert.equal(await host.page.$$eval('#board .cell.locked', function (els) { return els.length; }), 10);
  await guest.page.screenshot({ path: path.join(SCREENSHOT_DIR, 'game-over-guest.png') });

  // The result box can be closed to look at the board, and opened again.
  await host.page.click('#btn-over-board');
  await host.page.waitForSelector('#over', { state: 'hidden' });
  await host.page.click('#btn-result');
  await visible(host.page, 'over');

  // Host starts the next game: Bot A goes first this time.
  await host.page.click('#btn-again');
  await host.page.waitForSelector('#over', { state: 'hidden' });
  await guest.page.waitForSelector('#over', { state: 'hidden' });
  await waitForText(host.page, '#log', /New game\. Bot A goes first/);
  await waitForText(guest.page, '#turn', /Your turn/);
  assert.equal((await boardOf(guest.page)).replace(/\./g, '').length, 1, 'a fresh board after Bot A\'s first move');
  assert.deepEqual(host.errors.concat(guest.errors), []);
  await closeAll(host, guest);
});

test('leaving: the guest frees the seat, the host closes the room', async function () {
  var fake = new FakeFirebase();
  var host = await createRoom(fake);
  var guest = await joinRoom(fake, host.code);
  await waitForText(host.page, '#lobby-players', /Bilal/);
  await guest.page.click('#btn-leave-lobby');
  await visible(guest.page, 'screen-home');
  await waitForText(host.page, '#lobby-players', /Waiting for your friend/);

  var other = await joinRoom(fake, host.code, 'Chen');
  await waitForText(host.page, '#lobby-players', /Chen/);
  await host.page.click('#btn-leave-lobby');
  await visible(host.page, 'screen-home');
  await visible(other.page, 'screen-home');
  await waitForText(other.page, '#home-msg', /closed|no longer/);
  assert.equal(fake.get('rooms/' + host.code), null);
  assert.deepEqual(host.errors.concat(guest.errors, other.errors), []);
  await closeAll(host, guest, other);
});
