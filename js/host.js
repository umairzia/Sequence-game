/*
 * The host's authority. Only the host's browser runs this: it deals, keeps
 * the draw pile and the bots' hands, applies its own moves, checks and
 * applies the guest's move requests, and plays the bots' turns.
 *
 * Each function returns the database writes as one multi-path update
 * ({ 'path': value }), which the page sends with SeqNet.update so the game
 * state, the secret part and a hand always change together. The database
 * rules refuse an update whose version is not exactly one higher, so a
 * second tab working from an old copy can't apply a move twice.
 *
 * Paths: rooms/CODE/state (public), rooms/CODE/req (the guest's move
 * request), hands/CODE/host and hands/CODE/guest (each readable only by
 * that player), secret/CODE (draw pile, discards, bot hands: host only).
 *
 * Plain ES5. Works in the browser (window.SeqHost) and in Node for tests.
 */
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var api = node ? factory(require('./engine.js'), require('./ai.js')) : factory(root.SeqEngine, root.SeqAI);
  if (node) {
    module.exports = api;
  } else {
    root.SeqHost = api;
  }
})(this, function (E, AI) {
  'use strict';

  var HOST_SEAT = 0;
  var GUEST_SEAT = 2;

  function isBot(seat) { return seat === 1 || seat === 3; }

  function moveUpdates(code, res) {
    var u = {};
    u['rooms/' + code + '/state'] = res.state;
    u['secret/' + code] = res.secret;
    return u;
  }

  /**
   * Shuffles and deals a game. The host starts the first game; after that
   * the first turn moves one seat round the table each game.
   */
  function startGame(code, state, rng) {
    var first = state.game ? (state.first + 1) % E.SEATS : HOST_SEAT;
    var g = E.newGame({ v: state.v + 1, game: state.game + 1, first: first, diff: state.diff }, rng);
    var u = {};
    u['rooms/' + code + '/state'] = g.state;
    u['rooms/' + code + '/req'] = null;
    u['secret/' + code] = g.secret;
    u['hands/' + code] = g.hands;
    return u;
  }

  /** Changes how well the bots play (before a game or between games). */
  function setLevel(code, state, level) {
    var raw = JSON.parse(JSON.stringify(state));
    raw.v = state.v + 1;
    raw.diff = level;
    var u = {};
    u['rooms/' + code + '/state'] = E.normState(raw);
    return u;
  }

  /** The host's own move. Returns { error } or { updates }. */
  function hostMove(code, state, secret, hand, move, rng) {
    if (move.t !== 'q' && hand[move.slot] !== move.card) return { error: 'That card is not in your hand.' };
    var err = E.checkMove(state, HOST_SEAT, move);
    if (err) return { error: err };
    var res = E.applyMove(state, secret, HOST_SEAT, move, rng);
    var u = moveUpdates(code, res);
    if (move.t !== 'q') u['hands/' + code + '/host/' + move.slot] = res.card;
    return { updates: u };
  }

  /**
   * The guest's move request (rooms/CODE/req). The database rules have
   * already checked that the card is in that slot of the guest's hand, so
   * the host never needs to read the guest's cards. An illegal move is
   * answered with req/err; a legal one is applied and the replacement card
   * is dealt into the same slot.
   */
  function guestMove(code, state, secret, req, rng) {
    var move = { t: req.t, card: req.card, i: req.i };
    if (req.slot !== undefined && req.slot !== null) move.slot = Number(req.slot);
    var u = {};
    var err = E.checkMove(state, GUEST_SEAT, move);
    if (err) {
      u['rooms/' + code + '/req/err'] = err;
      return { error: err, updates: u };
    }
    var res = E.applyMove(state, secret, GUEST_SEAT, move, rng);
    u = moveUpdates(code, res);
    u['rooms/' + code + '/req'] = null;
    if (move.t !== 'q') u['hands/' + code + '/guest/' + move.slot] = res.card;
    return { updates: u };
  }

  /** A bot's whole turn: swap a dead card if it holds one, then play. */
  function botTurn(code, state, secret, rng) {
    var seat = state.turn;
    var key = 's' + seat;
    var hand = secret.bots[key].slice();
    var s = state, x = secret, res;
    var dead = AI.deadCardSlot(s, hand);
    if (dead >= 0 && !s.xc) {
      res = E.applyMove(s, x, seat, { t: 'x', slot: dead, card: hand[dead] }, rng);
      hand[dead] = res.card;
      s = res.state;
      x = res.secret;
    }
    var move = AI.chooseMove(s, hand, seat, { level: s.diff, rng: rng });
    res = E.applyMove(s, x, seat, move, rng);
    if (move.t !== 'q') hand[move.slot] = res.card;
    res.secret.bots[key] = hand;
    // The swap and the move are saved together, as one new version.
    res.state.v = state.v + 1;
    res.secret.v = state.v + 1;
    return { updates: moveUpdates(code, res), move: move };
  }

  /**
   * What the host should do next, given the latest state, secret and move
   * request: 'guest' (apply the guest's request), 'bot' (play a bot's turn)
   * or null (wait). Waits while the secret is from a different version,
   * which happens for a moment while a write is on its way.
   */
  function nextAction(state, secret, req) {
    if (!state || state.status !== 'playing' || !secret || secret.v !== state.v) return null;
    if (state.turn === GUEST_SEAT) return req && !req.err && req.v === state.v ? 'guest' : null;
    return isBot(state.turn) ? 'bot' : null;
  }

  return {
    HOST_SEAT: HOST_SEAT,
    GUEST_SEAT: GUEST_SEAT,
    isBot: isBot,
    startGame: startGame,
    setLevel: setLevel,
    hostMove: hostMove,
    guestMove: guestMove,
    botTurn: botTurn,
    nextAction: nextAction
  };
});
