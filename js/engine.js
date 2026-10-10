/*
 * Sequence rules: board layout, cards, legal moves, sequences and turns.
 *
 * Pure functions with no Firebase or page code, so the same rules run in
 * the browser (window.SeqEngine) and in Node (module.exports) for tests.
 * Plain ES5 so it runs on older iPhones.
 *
 * Seats go round the table: 0 = host, 1 = Bot A, 2 = guest, 3 = Bot B.
 * Team 0 (blue) is the two people (seats 0 and 2), team 1 (red) the bots.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.SeqEngine = api;
  }
})(this, function () {
  'use strict';

  var SIZE = 10;
  var CELLS = SIZE * SIZE;
  var SEATS = 4;
  var HAND_SIZE = 6;     // official rules: 6 cards each with 4 players
  var SEQS_TO_WIN = 2;   // official rules: two sequences when 2 teams play
  var LOG_LENGTH = 30;
  var FREE = '**';
  var EMPTY = '.';
  var RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K'];
  var SUITS = ['S', 'H', 'D', 'C'];

  // The board printed on the official game. Each card except the jacks is
  // on it twice; the four corners are free spaces that count for everyone.
  var LAYOUT_ROWS = [
    '** 2S 3S 4S 5S 6S 7S 8S 9S **',
    '6C 5C 4C 3C 2C AH KH QH TH TS',
    '7C AS 2D 3D 4D 5D 6D 7D 9H QS',
    '8C KS 6C 5C 4C 3C 2C 8D 8H KS',
    '9C QS 7C 6H 5H 4H AH 9D 7H AS',
    'TC TS 8C 7H 2H 3H KH TD 6H 2D',
    'QC 9S 9C 8H 9H TH QH QD 5H 3D',
    'KC 8S TC QC KC AC AD KD 4H 4D',
    'AC 7S 6S 5S 4S 3S 2S 2H 3H 5D',
    '** AD KD QD TD 9D 8D 7D 6D **'
  ];

  var LAYOUT = [];
  var CELLS_FOR = {}; // card -> the two cells showing it
  (function () {
    for (var r = 0; r < SIZE; r++) {
      var row = LAYOUT_ROWS[r].split(' ');
      for (var c = 0; c < SIZE; c++) {
        var card = row[c];
        LAYOUT.push(card);
        if (card !== FREE) (CELLS_FOR[card] = CELLS_FOR[card] || []).push(r * SIZE + c);
      }
    }
  })();

  // Every line of five cells (rows, columns and both diagonals), and for
  // each cell the lines that pass through it. The AI scores moves with these.
  var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  var WINDOWS = [];
  var WINDOWS_AT = [];
  (function () {
    var i, d, r, c, k;
    for (i = 0; i < CELLS; i++) WINDOWS_AT.push([]);
    for (d = 0; d < DIRS.length; d++) {
      for (r = 0; r < SIZE; r++) {
        for (c = 0; c < SIZE; c++) {
          var endR = r + 4 * DIRS[d][0], endC = c + 4 * DIRS[d][1];
          if (endR < 0 || endR >= SIZE || endC < 0 || endC >= SIZE) continue;
          var win = [];
          for (k = 0; k < 5; k++) win.push((r + k * DIRS[d][0]) * SIZE + (c + k * DIRS[d][1]));
          for (k = 0; k < 5; k++) WINDOWS_AT[win[k]].push(WINDOWS.length);
          WINDOWS.push(win);
        }
      }
    }
  })();

  // ---- Cards ---------------------------------------------------------------

  function teamOf(seat) { return seat % 2; }
  function chipOf(team) { return String(team); }
  function isCorner(i) { return LAYOUT[i] === FREE; }
  function isJack(card) { return card.charAt(0) === 'J'; }
  /** Jack of diamonds or clubs: wild, place a chip on any open space. */
  function isTwoEyed(card) { return card === 'JD' || card === 'JC'; }
  /** Jack of spades or hearts: remove one opponent chip. */
  function isOneEyed(card) { return card === 'JS' || card === 'JH'; }

  function isCard(card) {
    return typeof card === 'string' && card.length === 2 &&
      RANKS.indexOf(card.charAt(0)) >= 0 && SUITS.indexOf(card.charAt(1)) >= 0;
  }

  var RANK_LABEL = { A: 'A', T: '10', J: 'J', Q: 'Q', K: 'K' };
  var RANK_NAME = { A: 'Ace', T: '10', J: 'Jack', Q: 'Queen', K: 'King' };
  var SUIT_SYMBOL = { S: '♠', H: '♥', D: '♦', C: '♣' };
  var SUIT_NAME = { S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' };

  function rankLabel(card) { var r = card.charAt(0); return RANK_LABEL[r] || r; }
  function suitSymbol(card) { return SUIT_SYMBOL[card.charAt(1)]; }
  function isRed(card) { return card.charAt(1) === 'H' || card.charAt(1) === 'D'; }
  /** Short label such as "10♥". */
  function cardLabel(card) { return rankLabel(card) + suitSymbol(card); }
  /** Spoken name such as "10 of hearts" for screen readers and the log. */
  function cardName(card) {
    var r = card.charAt(0);
    return (RANK_NAME[r] || r) + ' of ' + SUIT_NAME[card.charAt(1)];
  }

  /** Two standard 52-card decks: 104 cards. */
  function fullDeck() {
    var deck = [];
    for (var n = 0; n < 2; n++) {
      for (var s = 0; s < SUITS.length; s++) {
        for (var r = 0; r < RANKS.length; r++) deck.push(RANKS[r] + SUITS[s]);
      }
    }
    return deck;
  }

  /** Random number in [0, 1), from the browser's crypto source when there is one. */
  function random() {
    var c = typeof window !== 'undefined' && (window.crypto || window.msCrypto);
    if (c && c.getRandomValues) {
      var a = new Uint32Array(1);
      c.getRandomValues(a);
      return a[0] / 4294967296;
    }
    return Math.random();
  }

  /** Fisher-Yates shuffle (in place). `rng` is optional, for tests. */
  function shuffle(list, rng) {
    rng = rng || random;
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = list[i]; list[i] = list[j]; list[j] = t;
    }
    return list;
  }

  // ---- Board ---------------------------------------------------------------

  function emptyBoard() { return new Array(CELLS + 1).join(EMPTY); }

  function setCell(board, i, ch) { return board.substring(0, i) + ch + board.substring(i + 1); }

  /** Cells that belong to a completed sequence. These chips can't be removed. */
  function lockedCells(seqs) {
    var locked = {};
    for (var s = 0; s < seqs.length; s++) {
      for (var k = 0; k < seqs[s].c.length; k++) locked[seqs[s].c[k]] = true;
    }
    return locked;
  }

  function countSeqs(seqs, team) {
    var n = 0;
    for (var s = 0; s < seqs.length; s++) if (seqs[s].t === team) n++;
    return n;
  }

  function overlap(a, b) {
    var n = 0;
    for (var i = 0; i < a.length; i++) if (b.indexOf(a[i]) >= 0) n++;
    return n;
  }

  /**
   * A new sequence may share at most one chip with each of the team's
   * earlier sequences (official rule for two-sequence games).
   */
  function canAddSequence(cells, seqs, team) {
    for (var s = 0; s < seqs.length; s++) {
      if (seqs[s].t === team && overlap(cells, seqs[s].c) > 1) return false;
    }
    return true;
  }

  /**
   * The sequences completed by a chip that `team` just placed at `cell`.
   * Five in a row in any direction; corners count for everyone. One chip can
   * complete two sequences (a line of nine, or two crossing lines).
   */
  function newSequences(board, seqs, cell, team) {
    var own = chipOf(team);
    var found = [];
    function mine(r, c) {
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return false;
      var i = r * SIZE + c;
      return isCorner(i) || board.charAt(i) === own;
    }
    var row = Math.floor(cell / SIZE), col = cell % SIZE;
    for (var d = 0; d < DIRS.length; d++) {
      var dr = DIRS[d][0], dc = DIRS[d][1];
      var r = row, c = col;
      while (mine(r - dr, c - dc)) { r -= dr; c -= dc; }
      var line = [];
      while (mine(r, c)) { line.push(r * SIZE + c); r += dr; c += dc; }
      if (line.length < 5) continue;
      var pos = line.indexOf(cell);
      for (var start = Math.max(0, pos - 4); start <= Math.min(pos, line.length - 5); start++) {
        var cells = line.slice(start, start + 5);
        if (canAddSequence(cells, seqs, team) && canAddSequence(cells, found, team)) {
          found.push({ t: team, c: cells });
        }
      }
    }
    return found;
  }

  // ---- Moves ---------------------------------------------------------------

  /**
   * Cells where `team` can use `card`: matching empty spaces for normal
   * cards, any empty space for a two-eyed jack, and any opponent chip that
   * is not part of a sequence for a one-eyed jack.
   */
  function targets(board, seqs, card, team) {
    var out = [], i;
    if (isTwoEyed(card)) {
      for (i = 0; i < CELLS; i++) if (!isCorner(i) && board.charAt(i) === EMPTY) out.push(i);
    } else if (isOneEyed(card)) {
      var opp = chipOf(1 - team), locked = lockedCells(seqs);
      for (i = 0; i < CELLS; i++) if (board.charAt(i) === opp && !locked[i]) out.push(i);
    } else {
      var cells = CELLS_FOR[card] || [];
      for (i = 0; i < cells.length; i++) if (board.charAt(cells[i]) === EMPTY) out.push(cells[i]);
    }
    return out;
  }

  /** A dead card: both of its spaces are already covered. Jacks are never dead. */
  function isDead(board, card) {
    if (!isCard(card) || isJack(card)) return false;
    var cells = CELLS_FOR[card];
    return board.charAt(cells[0]) !== EMPTY && board.charAt(cells[1]) !== EMPTY;
  }

  /** Every play (place or remove) the hand allows, as move objects. */
  function legalMoves(board, seqs, hand, team) {
    var moves = [];
    for (var slot = 0; slot < hand.length; slot++) {
      var card = hand[slot];
      if (!isCard(card)) continue;
      var cells = targets(board, seqs, card, team);
      for (var k = 0; k < cells.length; k++) {
        moves.push({ t: isOneEyed(card) ? 'r' : 'p', slot: slot, card: card, i: cells[k] });
      }
    }
    return moves;
  }

  /**
   * Checks a move against the public state. Returns null when it is allowed,
   * otherwise a short reason. Whether the card is really in the player's
   * hand is checked by the caller (or, for the guest, by the database rules).
   *
   * Move types: p = place a chip, r = remove a chip (one-eyed jack),
   * x = swap a dead card (once per turn, then play), q = pass (no legal move).
   */
  function checkMove(state, seat, move) {
    if (state.status !== 'playing') return 'The game is not running.';
    if (state.turn !== seat) return 'It is not your turn.';
    if (!move || ['p', 'r', 'x', 'q'].indexOf(move.t) < 0) return 'Unknown move.';
    if (move.t === 'q') return null;
    if (!isCard(move.card)) return 'Unknown card.';
    if (typeof move.slot !== 'number' || move.slot < 0 || move.slot >= HAND_SIZE) return 'Unknown card.';
    if (move.t === 'x') {
      if (state.xc) return 'Only one dead card can be swapped per turn.';
      return isDead(state.board, move.card) ? null : 'That card is not dead.';
    }
    if (move.t === 'r' && !isOneEyed(move.card)) return 'Only a one-eyed jack removes a chip.';
    if (move.t === 'p' && isOneEyed(move.card)) return 'A one-eyed jack removes a chip; it cannot place one.';
    var cells = targets(state.board, state.seqs, move.card, teamOf(seat));
    if (cells.indexOf(move.i) < 0) {
      return move.t === 'r' ? 'That chip cannot be removed.' : 'That space is not open for this card.';
    }
    return null;
  }

  // ---- State ---------------------------------------------------------------

  // Firebase drops empty lists and may return lists as objects, so every
  // list read from the database goes through here.
  function list(x) {
    if (!x) return [];
    if (Object.prototype.toString.call(x) === '[object Array]') {
      return x.filter(function (v) { return v !== null && v !== undefined; });
    }
    if (typeof x === 'object') {
      return Object.keys(x).sort(function (a, b) { return Number(a) - Number(b); })
        .map(function (k) { return x[k]; })
        .filter(function (v) { return v !== null && v !== undefined; });
    }
    return [];
  }

  function num(x, fallback) { return typeof x === 'number' && isFinite(x) ? x : fallback; }

  /** Hands keep their slots (a slot can be empty), so they are not compacted. */
  function normHand(x) {
    var hand = [];
    for (var i = 0; i < HAND_SIZE; i++) {
      var v = x ? x[i] : null;
      hand.push(isCard(v) ? v : null);
    }
    return hand;
  }

  /** A complete public game state from whatever the database returned. */
  function normState(raw) {
    raw = raw || {};
    var board = typeof raw.board === 'string' && raw.board.length === CELLS ? raw.board : emptyBoard();
    return {
      v: num(raw.v, 0),
      status: raw.status === 'playing' || raw.status === 'over' ? raw.status : 'lobby',
      game: num(raw.game, 0),
      first: num(raw.first, 0),
      turn: num(raw.turn, 0),
      board: board,
      seqs: list(raw.seqs).map(function (q) { return { t: num(q.t, 0), c: list(q.c) }; }),
      win: num(raw.win, -1),
      last: raw.last && typeof raw.last === 'object' ? {
        s: num(raw.last.s, 0), k: raw.last.k, c: raw.last.c, i: num(raw.last.i, -1)
      } : null,
      top: isCard(raw.top) ? raw.top : null,
      deck: num(raw.deck, 0),
      xc: raw.xc ? 1 : 0,
      passes: num(raw.passes, 0),
      log: list(raw.log),
      diff: raw.diff === 'easy' || raw.diff === 'hard' ? raw.diff : 'normal'
    };
  }

  /** The host-only part: draw pile, discard pile and the bots' hands. */
  function normSecret(raw) {
    raw = raw || {};
    var bots = raw.bots || {};
    return {
      v: num(raw.v, 0),
      deck: list(raw.deck),
      discard: list(raw.discard),
      bots: { s1: normHand(bots.s1), s3: normHand(bots.s3) }
    };
  }

  function copyState(s) {
    return {
      v: s.v, status: s.status, game: s.game, first: s.first, turn: s.turn,
      board: s.board,
      seqs: s.seqs.map(function (q) { return { t: q.t, c: q.c.slice() }; }),
      win: s.win, last: s.last, top: s.top, deck: s.deck, xc: s.xc,
      passes: s.passes, log: s.log.slice(), diff: s.diff
    };
  }

  function copySecret(x) {
    return {
      v: x.v, deck: x.deck.slice(), discard: x.discard.slice(),
      bots: { s1: x.bots.s1.slice(), s3: x.bots.s3.slice() }
    };
  }

  function addLog(state, entry) {
    state.log.push(entry);
    if (state.log.length > LOG_LENGTH) state.log = state.log.slice(state.log.length - LOG_LENGTH);
  }

  /**
   * Takes the top card of the draw pile. When it is empty, the discard pile
   * (except the card just played) is shuffled to make a new one.
   */
  function draw(secret, rng) {
    if (!secret.deck.length && secret.discard.length > 1) {
      var keep = secret.discard.pop();
      secret.deck = shuffle(secret.discard, rng);
      secret.discard = [keep];
    }
    return secret.deck.length ? secret.deck.pop() : null;
  }

  /**
   * Shuffles and deals a new game. Returns the public state, the host-only
   * secret, and the two people's hands (each stored under its own key).
   * opts: { v, game, first, diff }
   */
  function newGame(opts, rng) {
    var deck = shuffle(fullDeck(), rng);
    var hands = [[], [], [], []];
    for (var k = 0; k < HAND_SIZE; k++) {
      for (var s = 0; s < SEATS; s++) hands[(opts.first + s) % SEATS].push(deck.pop());
    }
    var state = normState({
      v: opts.v, status: 'playing', game: opts.game, first: opts.first, turn: opts.first,
      deck: deck.length, diff: opts.diff
    });
    addLog(state, { k: 'start', s: opts.first });
    return {
      state: state,
      secret: { v: opts.v, deck: deck, discard: [], bots: { s1: hands[1], s3: hands[3] } },
      hands: { host: hands[0], guest: hands[2] }
    };
  }

  /**
   * Plays a checked move for `seat`. Returns the new public state, the new
   * secret and the card drawn into the played card's slot (null for a pass).
   * The caller writes all three to the database in one atomic update.
   */
  function applyMove(state, secret, seat, move, rng) {
    var s = copyState(state), x = copySecret(secret);
    var team = teamOf(seat);
    s.v = state.v + 1;
    x.v = s.v;
    var drawn = null;

    if (move.t === 'q') {
      addLog(s, { k: 'q', s: seat });
      s.passes = state.passes + 1;
      if (s.passes >= SEATS) {
        s.status = 'over';
        s.win = 2; // nobody can move: a draw
        addLog(s, { k: 'draw' });
      } else {
        s.turn = (seat + 1) % SEATS;
        s.xc = 0;
      }
      s.deck = x.deck.length;
      return { state: s, secret: x, card: null };
    }

    x.discard.push(move.card);
    s.top = move.card;
    drawn = draw(x, rng);
    s.deck = x.deck.length;

    if (move.t === 'x') {
      s.xc = 1;
      addLog(s, { k: 'x', s: seat, c: move.card });
      return { state: s, secret: x, card: drawn };
    }

    if (move.t === 'r') {
      s.board = setCell(s.board, move.i, EMPTY);
    } else {
      s.board = setCell(s.board, move.i, chipOf(team));
    }
    s.last = { s: seat, k: move.t, c: move.card, i: move.i };
    s.passes = 0;
    addLog(s, { k: move.t, s: seat, c: move.card, i: move.i });

    if (move.t === 'p') {
      var made = newSequences(s.board, s.seqs, move.i, team);
      for (var n = 0; n < made.length; n++) {
        s.seqs.push(made[n]);
        addLog(s, { k: 'seq', t: team, n: countSeqs(s.seqs, team) });
      }
      if (countSeqs(s.seqs, team) >= SEQS_TO_WIN) {
        s.status = 'over';
        s.win = team;
        addLog(s, { k: 'win', t: team });
        return { state: s, secret: x, card: drawn };
      }
    }
    s.turn = (seat + 1) % SEATS;
    s.xc = 0;
    return { state: s, secret: x, card: drawn };
  }

  /** Row and column for people: "row 3, column 7" (1-based). */
  function cellName(i) {
    return 'row ' + (Math.floor(i / SIZE) + 1) + ', column ' + (i % SIZE + 1);
  }

  return {
    SIZE: SIZE,
    CELLS: CELLS,
    SEATS: SEATS,
    HAND_SIZE: HAND_SIZE,
    SEQS_TO_WIN: SEQS_TO_WIN,
    EMPTY: EMPTY,
    LAYOUT: LAYOUT,
    CELLS_FOR: CELLS_FOR,
    WINDOWS: WINDOWS,
    WINDOWS_AT: WINDOWS_AT,
    teamOf: teamOf,
    chipOf: chipOf,
    isCorner: isCorner,
    isCard: isCard,
    isJack: isJack,
    isTwoEyed: isTwoEyed,
    isOneEyed: isOneEyed,
    isRed: isRed,
    rankLabel: rankLabel,
    suitSymbol: suitSymbol,
    cardLabel: cardLabel,
    cardName: cardName,
    cellName: cellName,
    fullDeck: fullDeck,
    shuffle: shuffle,
    random: random,
    emptyBoard: emptyBoard,
    setCell: setCell,
    lockedCells: lockedCells,
    countSeqs: countSeqs,
    canAddSequence: canAddSequence,
    newSequences: newSequences,
    targets: targets,
    isDead: isDead,
    legalMoves: legalMoves,
    checkMove: checkMove,
    list: list,
    normHand: normHand,
    normState: normState,
    normSecret: normSecret,
    newGame: newGame,
    applyMove: applyMove
  };
});
