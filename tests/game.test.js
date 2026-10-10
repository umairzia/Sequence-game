// Unit tests for the game rules, the bots and the host logic. Run: npm test
var test = require('node:test');
var assert = require('node:assert/strict');
var E = require('../js/engine.js');
var AI = require('../js/ai.js');

// Small seeded random number generator so games can be replayed.
function seeded(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function cell(r, c) { return r * 10 + c; }

// Board string with chips for team 0 and team 1 at the given cells.
function boardWith(team0, team1) {
  var b = E.emptyBoard();
  (team0 || []).forEach(function (i) { b = E.setCell(b, i, '0'); });
  (team1 || []).forEach(function (i) { b = E.setCell(b, i, '1'); });
  return b;
}

function playing(board, extra) {
  var s = E.normState({ v: 5, status: 'playing', board: board, turn: 0, deck: 50 });
  Object.keys(extra || {}).forEach(function (k) { s[k] = extra[k]; });
  return s;
}

function secretWith(deck, discard) {
  return E.normSecret({ v: 5, deck: deck, discard: discard || [], bots: { s1: ['2S'], s3: ['3S'] } });
}

test('board: official layout, every non-jack card twice, free corners', function () {
  assert.equal(E.LAYOUT.length, 100);
  [0, 9, 90, 99].forEach(function (i) { assert.ok(E.isCorner(i), 'corner ' + i); });
  var counts = {};
  E.LAYOUT.forEach(function (card, i) {
    if (E.isCorner(i)) return;
    assert.ok(E.isCard(card), card);
    assert.ok(!E.isJack(card), 'no jacks on the board');
    counts[card] = (counts[card] || 0) + 1;
  });
  assert.equal(Object.keys(counts).length, 48);
  Object.keys(counts).forEach(function (card) { assert.equal(counts[card], 2, card); });
  assert.deepEqual(E.CELLS_FOR.AS, [cell(2, 1), cell(4, 9)]);
  assert.equal(E.LAYOUT[cell(1, 9)], 'TS');
  assert.equal(E.LAYOUT[cell(9, 1)], 'AD');
});

test('deck: two standard decks with 4 wild and 4 removing jacks', function () {
  var deck = E.fullDeck();
  assert.equal(deck.length, 104);
  assert.equal(deck.filter(E.isTwoEyed).length, 4);
  assert.equal(deck.filter(E.isOneEyed).length, 4);
  var sorted = E.shuffle(deck.slice(), seeded(1)).sort();
  assert.deepEqual(sorted, deck.slice().sort(), 'shuffle keeps every card');
  assert.equal(E.cardLabel('TH'), '10♥');
  assert.equal(E.cardName('QS'), 'Queen of spades');
  assert.ok(E.isRed('7D') && !E.isRed('7C'));
});

test('lines of five: rows, columns and diagonals', function () {
  assert.equal(E.WINDOWS.length, 60 + 60 + 36 + 36);
  assert.equal(E.WINDOWS_AT[0].length, 3);
  assert.equal(E.WINDOWS_AT[cell(4, 4)].length, 20);
});

test('targets: normal cards, wild jacks and removing jacks', function () {
  var b = boardWith([cell(2, 1)], [cell(4, 9), cell(5, 5)]);
  assert.deepEqual(E.targets(b, [], 'AS', 0), [], 'both aces of spades covered');
  assert.ok(E.isDead(b, 'AS'));
  assert.ok(!E.isDead(b, 'JS'), 'jacks are never dead');
  assert.deepEqual(E.targets(b, [], 'KS', 0), E.CELLS_FOR.KS);
  assert.equal(E.targets(b, [], 'JD', 0).length, 96 - 3, 'wild: every open space');
  assert.deepEqual(E.targets(b, [], 'JS', 0), [cell(4, 9), cell(5, 5)], 'opponent chips');
  assert.deepEqual(E.targets(b, [], 'JH', 1), [cell(2, 1)]);
  var locked = [{ t: 1, c: [cell(5, 5), 1, 2, 3, 4] }];
  assert.deepEqual(E.targets(b, locked, 'JS', 0), [cell(4, 9)], 'sequence chips are safe');
});

test('sequences: rows, columns, diagonals and the free corners', function () {
  var row = [cell(1, 0), cell(1, 1), cell(1, 2), cell(1, 3)];
  var b = boardWith(row.concat(cell(1, 4)));
  var made = E.newSequences(b, [], cell(1, 4), 0);
  assert.deepEqual(made, [{ t: 0, c: row.concat(cell(1, 4)) }]);
  assert.deepEqual(E.newSequences(b, [], cell(1, 4), 1), [], 'other team');

  // Top row: the corner counts as a chip.
  b = boardWith([cell(0, 1), cell(0, 2), cell(0, 3), cell(0, 4)]);
  assert.deepEqual(E.newSequences(b, [], cell(0, 3), 0)[0].c, [0, 1, 2, 3, 4]);

  b = boardWith([cell(3, 6), cell(4, 6), cell(5, 6), cell(6, 6), cell(7, 6)]);
  assert.equal(E.newSequences(b, [], cell(5, 6), 0).length, 1, 'column');
  b = boardWith([cell(2, 2), cell(3, 3), cell(4, 4), cell(5, 5), cell(6, 6)]);
  assert.equal(E.newSequences(b, [], cell(6, 6), 0).length, 1, 'diagonal');
  b = boardWith([cell(2, 7), cell(3, 6), cell(4, 5), cell(5, 4), cell(6, 3)]);
  assert.equal(E.newSequences(b, [], cell(2, 7), 0).length, 1, 'other diagonal');
  b = boardWith([cell(2, 7), cell(3, 6), cell(4, 5), cell(6, 3)]);
  assert.equal(E.newSequences(b, [], cell(2, 7), 0).length, 0, 'gap');
});

test('sequences: a second one may share only one chip with the first', function () {
  var first = { t: 0, c: [cell(3, 0), cell(3, 1), cell(3, 2), cell(3, 3), cell(3, 4)] };
  // Six in a row sharing four chips with the first sequence: not a new one.
  var b = boardWith(first.c.concat(cell(3, 5)));
  assert.deepEqual(E.newSequences(b, [first], cell(3, 5), 0), []);
  // Nine in a row: the second sequence shares the fifth chip.
  var nine = first.c.concat([cell(3, 5), cell(3, 6), cell(3, 7), cell(3, 8)]);
  b = boardWith(nine);
  assert.deepEqual(E.newSequences(b, [first], cell(3, 8), 0),
    [{ t: 0, c: [cell(3, 4), cell(3, 5), cell(3, 6), cell(3, 7), cell(3, 8)] }]);
  // Filling the middle of nine chips makes two sequences at once.
  assert.equal(E.newSequences(b, [], cell(3, 4), 0).length, 2);
  // Two lines crossing at the new chip.
  var cross = [cell(5, 1), cell(5, 2), cell(5, 3), cell(5, 4), cell(5, 5),
    cell(1, 3), cell(2, 3), cell(3, 3), cell(4, 3)];
  b = boardWith(cross);
  assert.equal(E.newSequences(b, [], cell(5, 3), 0).length, 2);
});

test('newGame deals 6 cards each and keeps the rest secret', function () {
  var g = E.newGame({ v: 2, game: 1, first: 0, diff: 'normal' }, seeded(7));
  assert.equal(g.hands.host.length, 6);
  assert.equal(g.hands.guest.length, 6);
  assert.equal(g.secret.bots.s1.length, 6);
  assert.equal(g.secret.bots.s3.length, 6);
  assert.equal(g.secret.deck.length, 80);
  assert.equal(g.state.deck, 80);
  assert.equal(g.state.turn, 0);
  assert.equal(g.state.status, 'playing');
  var all = g.secret.deck.concat(g.hands.host, g.hands.guest, g.secret.bots.s1, g.secret.bots.s3);
  assert.deepEqual(all.sort(), E.fullDeck().sort());
  // The public state holds no cards from the deck or the hands.
  var json = JSON.stringify(g.state);
  assert.ok(!/"deck":\[/.test(json) && !/hands|bots/.test(json));
});

test('applyMove: place a chip, draw a card, pass the turn', function () {
  var state = playing(E.emptyBoard());
  var secret = secretWith(['9C', 'KD']);
  var mv = { t: 'p', slot: 2, card: 'AS', i: cell(2, 1) };
  assert.equal(E.checkMove(state, 0, mv), null);
  assert.match(E.checkMove(state, 1, mv), /not your turn/);
  var res = E.applyMove(state, secret, 0, mv);
  assert.equal(res.card, 'KD');
  assert.equal(res.state.v, 6);
  assert.equal(res.secret.v, 6);
  assert.equal(res.state.board.charAt(cell(2, 1)), '0');
  assert.equal(res.state.turn, 1);
  assert.equal(res.state.top, 'AS');
  assert.equal(res.state.deck, 1);
  assert.deepEqual(res.state.last, { s: 0, k: 'p', c: 'AS', i: cell(2, 1) });
  assert.deepEqual(res.secret.discard, ['AS']);
  assert.equal(state.board.charAt(cell(2, 1)), '.', 'input not changed');
});

test('applyMove: one-eyed jack removes, dead card swap keeps the turn', function () {
  var state = playing(boardWith([], [cell(5, 5)]));
  var secret = secretWith(['9C', 'KD', '4H']);
  assert.match(E.checkMove(state, 0, { t: 'p', slot: 0, card: 'JS', i: cell(5, 6) }), /removes/);
  assert.match(E.checkMove(state, 0, { t: 'r', slot: 0, card: 'JD', i: cell(5, 5) }), /one-eyed/);
  var res = E.applyMove(state, secret, 0, { t: 'r', slot: 0, card: 'JS', i: cell(5, 5) });
  assert.equal(res.state.board.charAt(cell(5, 5)), '.');
  assert.equal(res.state.turn, 1);

  var b = boardWith([cell(2, 1)], [cell(4, 9)]);
  state = playing(b);
  assert.match(E.checkMove(state, 0, { t: 'x', slot: 1, card: 'KS' }), /not dead/);
  var swap = { t: 'x', slot: 1, card: 'AS' };
  assert.equal(E.checkMove(state, 0, swap), null);
  res = E.applyMove(state, secret, 0, swap);
  assert.equal(res.state.turn, 0, 'still my turn');
  assert.equal(res.state.xc, 1);
  assert.equal(res.card, '4H');
  assert.match(E.checkMove(res.state, 0, swap), /one dead card/);
  // Playing afterwards ends the turn and resets the swap.
  res = E.applyMove(res.state, res.secret, 0, { t: 'p', slot: 1, card: '4H', i: E.CELLS_FOR['4H'][0] });
  assert.equal(res.state.turn, 1);
  assert.equal(res.state.xc, 0);
});

test('applyMove: the discard pile is reshuffled when the deck runs out', function () {
  var state = playing(E.emptyBoard());
  var secret = secretWith([], ['2C', '3C', '4C']);
  var res = E.applyMove(state, secret, 0, { t: 'p', slot: 0, card: 'AS', i: cell(2, 1) }, seeded(3));
  assert.ok(['2C', '3C', '4C'].indexOf(res.card) >= 0, 'drew ' + res.card);
  assert.deepEqual(res.secret.discard, ['AS'], 'the card just played stays face up');
  assert.equal(res.secret.deck.length, 2);
  assert.equal(res.state.deck, 2);
});

test('applyMove: two sequences win; four passes in a row is a draw', function () {
  var first = { t: 0, c: [cell(1, 0), cell(1, 1), cell(1, 2), cell(1, 3), cell(1, 4)] };
  var b = boardWith(first.c.concat([cell(2, 1), cell(3, 1), cell(4, 1), cell(5, 1)]));
  var state = playing(b, { seqs: [first], turn: 2 });
  var res = E.applyMove(state, secretWith(['9C']), 2, { t: 'p', slot: 0, card: '9S', i: cell(6, 1) });
  assert.equal(res.state.status, 'over');
  assert.equal(res.state.win, 0);
  assert.equal(res.state.seqs.length, 2);
  assert.deepEqual(res.state.log.slice(-2).map(function (e) { return e.k; }), ['seq', 'win']);
  assert.match(E.checkMove(res.state, 3, { t: 'q' }), /not running/);

  state = playing(E.emptyBoard(), { passes: 3, turn: 3 });
  res = E.applyMove(state, secretWith(['9C']), 3, { t: 'q' });
  assert.equal(res.state.status, 'over');
  assert.equal(res.state.win, 2);
});

test('normState copes with what Firebase returns', function () {
  var s = E.normState({
    v: 3, status: 'playing', board: E.emptyBoard(),
    seqs: { 0: { t: 1, c: { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5 } } },
    log: { 0: { k: 'start', s: 0 }, 2: { k: 'p', s: 1 } }
  });
  assert.deepEqual(s.seqs, [{ t: 1, c: [1, 2, 3, 4, 5] }]);
  assert.equal(s.log.length, 2);
  assert.equal(s.win, -1);
  assert.equal(s.top, null);
  assert.deepEqual(E.normHand({ 0: 'AS', 2: 'KD' }), ['AS', null, 'KD', null, null, null]);
  assert.deepEqual(E.normState(null).status, 'lobby');
});

test('AI: completes the winning sequence', function () {
  var first = { t: 1, c: [cell(8, 1), cell(8, 2), cell(8, 3), cell(8, 4), cell(8, 5)] };
  var b = boardWith([], first.c.concat([cell(4, 3), cell(4, 4), cell(4, 5), cell(4, 6)]));
  var state = playing(b, { seqs: [first], turn: 1 });
  // 7C is on the board twice; only the one at row 5, column 3 wins.
  // Even Easy bots, which sometimes play at random, never miss a win.
  ['easy', 'normal', 'hard'].forEach(function (level) {
    for (var seed = 1; seed <= 10; seed++) {
      var mv = AI.chooseMove(state, ['2D', 'KC', '7C', '8S', '9S', 'QD'], 1, { level: level, rng: seeded(seed) });
      assert.deepEqual([mv.t, mv.card, mv.i], ['p', '7C', cell(4, 2)], level + ' seed ' + seed);
    }
  });
});

test('AI: blocks four in a row, or removes a chip when it cannot', function () {
  var four = [cell(6, 2), cell(6, 3), cell(6, 4), cell(6, 5)];
  var state = playing(boardWith(four, []), { turn: 1 });
  // QH is on the board at row 7, column 7: the open right end of the line.
  var hand = ['QH', '2C', '3C', '4C', '5C', '6C'];
  for (var seed = 1; seed <= 10; seed++) {
    var mv = AI.chooseMove(state, hand, 1, { level: 'hard', rng: seeded(seed) });
    assert.deepEqual([mv.card, mv.i], ['QH', cell(6, 6)], 'seed ' + seed);
  }
  // No card for either open end: take one of the four away with a one-eyed jack.
  var mv2 = AI.chooseMove(state, ['JH', '2C', '3C', '4C', '5C', '6C'], 1, { level: 'hard', rng: seeded(2) });
  assert.equal(mv2.t, 'r');
  assert.ok(four.indexOf(mv2.i) >= 0, 'removed one of the four');
});

test('AI: keeps wild jacks for when they matter, swaps dead cards, passes when stuck', function () {
  var state = playing(E.emptyBoard(), { turn: 1 });
  for (var seed = 1; seed <= 10; seed++) {
    var mv = AI.chooseMove(state, ['JD', '2C', '3C', '4C', '5C', '6C'], 1, { level: 'hard', rng: seeded(seed) });
    assert.notEqual(mv.card, 'JD', 'seed ' + seed);
  }
  var b = boardWith([], E.CELLS_FOR['2C']);
  assert.equal(AI.deadCardSlot(playing(b), ['5H', '2C', 'JS']), 1);
  assert.equal(AI.deadCardSlot(playing(E.emptyBoard()), ['5H', '2C', 'JS']), -1);
  // A dead card and a one-eyed jack with no opponent chip to remove: pass.
  assert.deepEqual(AI.chooseMove(playing(b), ['JS', '2C'], 1, { rng: seeded(1) }), { t: 'q' });
});

// Plays a whole game with bots in all four seats and checks the rules hold.
function playGame(levels, rng) {
  var g = E.newGame({ v: 1, game: 1, first: 0, diff: 'normal' }, rng);
  var state = g.state, secret = g.secret;
  var hands = [g.hands.host, secret.bots.s1, g.hands.guest, secret.bots.s3];
  for (var turns = 0; turns < 2000 && state.status === 'playing'; turns++) {
    var seat = state.turn, hand = hands[seat], res;
    var dead = AI.deadCardSlot(state, hand);
    if (dead >= 0 && !state.xc) {
      var swap = { t: 'x', slot: dead, card: hand[dead] };
      assert.equal(E.checkMove(state, seat, swap), null);
      res = E.applyMove(state, secret, seat, swap, rng);
      hand[dead] = res.card;
      state = res.state; secret = res.secret;
    }
    var mv = AI.chooseMove(state, hand, seat, { level: levels[E.teamOf(seat)], rng: rng });
    assert.equal(E.checkMove(state, seat, mv), null, JSON.stringify(mv));
    if (mv.t !== 'q') assert.equal(hand[mv.slot], mv.card);
    res = E.applyMove(state, secret, seat, mv, rng);
    if (mv.t !== 'q') hand[mv.slot] = res.card;
    state = res.state; secret = res.secret;

    // Every card is somewhere: deck, discard pile or a hand.
    var cards = secret.deck.concat(secret.discard, hands[0], hands[1], hands[2], hands[3])
      .filter(function (c) { return c; });
    assert.equal(cards.length, 104);
    assert.equal(state.deck, secret.deck.length);
    state.seqs.forEach(function (q) {
      q.c.forEach(function (i) { assert.ok(E.isCorner(i) || state.board.charAt(i) === String(q.t)); });
    });
  }
  return state;
}

test('bots play whole games to the end without breaking any rule', function () {
  var results = [];
  for (var seed = 1; seed <= 12; seed++) {
    var end = playGame({ 0: 'normal', 1: 'normal' }, seeded(seed));
    assert.equal(end.status, 'over', 'game ' + seed + ' finished');
    results.push(end.win);
    if (end.win !== 2) assert.ok(E.countSeqs(end.seqs, end.win) >= 2);
  }
  assert.ok(results.indexOf(0) >= 0 && results.indexOf(1) >= 0, 'both teams can win: ' + results);
});

test('Hard bots beat Easy bots most of the time', function () {
  // Cards bring a lot of luck, so this needs a fair number of games
  // (about 83% over 600 games when tuning the levels).
  var hardWins = 0, games = 60;
  for (var seed = 100; seed < 100 + games; seed++) {
    // Alternate sides so neither team always moves first.
    var hardTeam = seed % 2;
    var levels = {};
    levels[hardTeam] = 'hard';
    levels[1 - hardTeam] = 'easy';
    var end = playGame(levels, seeded(seed));
    if (end.win === hardTeam) hardWins++;
  }
  assert.ok(hardWins >= games * 0.65, 'hard won ' + hardWins + ' of ' + games);
});

// ---- Host authority, with an in-memory stand-in for the database ----------

var Host = require('../js/host.js');

// Applies a multi-path update like Firebase does, refusing it (all or
// nothing) when the game state's version is not exactly one higher.
function applyUpdates(db, updates) {
  var next = JSON.parse(JSON.stringify(db));
  Object.keys(updates).forEach(function (p) {
    var parts = p.split('/'), node = next;
    for (var k = 0; k < parts.length - 1; k++) {
      if (node[parts[k]] === undefined || node[parts[k]] === null) node[parts[k]] = {};
      node = node[parts[k]];
    }
    var last = parts[parts.length - 1];
    if (updates[p] === null) delete node[last];
    else node[last] = JSON.parse(JSON.stringify(updates[p]));
  });
  var before = db.rooms.ROOM.state.v, after = next.rooms.ROOM.state.v;
  if (after !== before && after !== before + 1) throw new Error('version ' + before + ' -> ' + after);
  return next;
}

function lobby() {
  return { rooms: { ROOM: { state: { v: 1, status: 'lobby', diff: 'normal' } } } };
}

test('host: deals a game with each hand under its own key', function () {
  var db = applyUpdates(lobby(), Host.startGame('ROOM', E.normState(lobby().rooms.ROOM.state), seeded(4)));
  var state = E.normState(db.rooms.ROOM.state);
  assert.equal(state.v, 2);
  assert.equal(state.status, 'playing');
  assert.equal(state.turn, 0, 'the host starts the first game');
  assert.equal(db.hands.ROOM.host.length, 6);
  assert.equal(db.hands.ROOM.guest.length, 6);
  var secret = E.normSecret(db.secret.ROOM);
  assert.equal(secret.deck.length, 80);
  assert.equal(typeof db.rooms.ROOM.state.deck, 'number', 'only the number of cards left is public');
  // The next game starts one seat further round.
  var again = Host.startGame('ROOM', E.normState(Object.assign({}, db.rooms.ROOM.state, { status: 'over' })), seeded(5));
  assert.equal(again['rooms/ROOM/state'].turn, 1);
  assert.equal(again['rooms/ROOM/state'].game, 2);
});

test('host: plays its own move, the guest request and both bots, one version at a time', function () {
  var rng = seeded(11);
  var db = applyUpdates(lobby(), Host.startGame('ROOM', E.normState(lobby().rooms.ROOM.state), rng));
  var guestWrites = 0;
  for (var turn = 0; turn < 400; turn++) {
    var state = E.normState(db.rooms.ROOM.state);
    if (state.status !== 'playing') break;
    var secret = E.normSecret(db.secret.ROOM);
    var updates;
    if (state.turn === 0) {
      var hand = E.normHand(db.hands.ROOM.host);
      var mv = AI.chooseMove(state, hand, 0, { level: 'normal', rng: rng });
      var r = Host.hostMove('ROOM', state, secret, hand, mv, rng);
      assert.ok(!r.error, r.error);
      updates = r.updates;
    } else if (state.turn === 2) {
      // The guest only writes a request; the host applies it.
      var ghand = E.normHand(db.hands.ROOM.guest);
      var gmv = AI.chooseMove(state, ghand, 2, { level: 'normal', rng: rng });
      var req = { id: 'r' + turn, v: state.v, t: gmv.t };
      if (gmv.t !== 'q') { req.slot = String(gmv.slot); req.card = gmv.card; req.i = gmv.i; }
      db.rooms.ROOM.req = req;
      assert.equal(Host.nextAction(state, secret, req), 'guest');
      updates = Host.guestMove('ROOM', state, secret, req, rng).updates;
      Object.keys(updates).forEach(function (p) {
        if (/^hands\/ROOM\/guest/.test(p)) { guestWrites++; assert.match(p, /^hands\/ROOM\/guest\/[0-5]$/); }
      });
      assert.equal(updates['rooms/ROOM/req'], null, 'request cleared');
    } else {
      assert.equal(Host.nextAction(state, secret, null), 'bot');
      updates = Host.botTurn('ROOM', state, secret, rng).updates;
    }
    db = applyUpdates(db, updates);
    assert.equal(db.rooms.ROOM.state.v, state.v + 1);
    assert.equal(db.secret.ROOM.v, db.rooms.ROOM.state.v, 'secret and state move together');

    var x = E.normSecret(db.secret.ROOM);
    var cards = x.deck.concat(x.discard, x.bots.s1, x.bots.s3, E.normHand(db.hands.ROOM.host), E.normHand(db.hands.ROOM.guest))
      .filter(function (c) { return c; });
    assert.equal(cards.length, 104, 'no card lost or duplicated');
  }
  assert.equal(E.normState(db.rooms.ROOM.state).status, 'over');
  assert.ok(guestWrites > 0, 'the guest got new cards');
});

test('host: turns down bad or stale guest requests', function () {
  var db = applyUpdates(lobby(), Host.startGame('ROOM', E.normState(lobby().rooms.ROOM.state), seeded(8)));
  var state = E.normState(db.rooms.ROOM.state);
  state.turn = 2;
  var secret = E.normSecret(db.secret.ROOM);
  // A space that doesn't match the card.
  var bad = { id: 'a', v: state.v, t: 'p', slot: '0', card: '2S', i: 55 };
  var r = Host.guestMove('ROOM', state, secret, bad);
  assert.match(r.error, /not open/);
  assert.deepEqual(Object.keys(r.updates), ['rooms/ROOM/req/err']);
  // Requests for an old version, or already answered, are left alone.
  assert.equal(Host.nextAction(state, secret, { id: 'b', v: state.v - 1, t: 'q' }), null);
  assert.equal(Host.nextAction(state, secret, { id: 'c', v: state.v, t: 'q', err: 'x' }), null);
  // Nothing happens while the secret is from another version.
  assert.equal(Host.nextAction(state, E.normSecret({ v: state.v - 1 }), { id: 'd', v: state.v, t: 'q' }), null);
  // The host can't play a card it doesn't hold.
  state.turn = 0;
  assert.match(Host.hostMove('ROOM', state, secret, ['AS'], { t: 'p', slot: 0, card: 'KD', i: 72 }).error, /not in your hand/);
  // Changing the bots' level is a new version too.
  var lv = Host.setLevel('ROOM', state, 'hard')['rooms/ROOM/state'];
  assert.equal(lv.diff, 'hard');
  assert.equal(lv.v, state.v + 1);
});

test('the game scripts are plain ES5 so they run on older iPhones', function () {
  var acorn = require('acorn');
  var fs = require('fs');
  var path = require('path');
  var dir = path.join(__dirname, '..', 'js');
  var files = fs.readdirSync(dir).filter(function (f) { return /\.js$/.test(f); });
  assert.ok(files.length >= 6, files.join(', '));
  files.forEach(function (f) {
    var src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotThrow(function () { acorn.parse(src, { ecmaVersion: 5 }); }, 'js/' + f + ' is not ES5');
  });
});
