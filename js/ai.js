/*
 * The bots' move choice. A one-move look-ahead heuristic:
 *
 *  1. Swap a dead card first (the caller does this with deadCardSlot).
 *  2. Score every legal move:
 *     - win the game or complete a sequence: huge bonus;
 *     - attack: for every line of five through the space that the team can
 *       still turn into a sequence, how much closer the chip brings it
 *       (lines with more chips count much more);
 *     - defend: how much the chip spoils the opponents' open lines, with a
 *       large bonus for blocking a line where they already have four;
 *     - one-eyed jack: the same two scores for taking a chip away;
 *     - plan: a bonus when the chip makes four in a line and the bot holds
 *       a card that can finish it next turn;
 *     - jacks cost points, so they are kept for moves that matter.
 *  3. Add a little randomness (more on Easy) and play the best move.
 *
 * Plain ES5. Works in the browser (window.SeqAI) and in Node for tests.
 */
(function (root, factory) {
  var node = typeof module === 'object' && module.exports;
  var api = factory(node ? require('./engine.js') : root.SeqEngine);
  if (node) {
    module.exports = api;
  } else {
    root.SeqAI = api;
  }
})(this, function (E) {
  'use strict';

  // Worth of an open line of five that holds k of the team's chips.
  var LINE = [0, 1, 6, 30, 160];
  var WIN = 1000000;
  var SEQUENCE = 3000;
  var BLOCK_SEQUENCE = 900;  // the opponents have four in a line
  var BLOCK_WIN = 5000;      // ... and that line would win them the game
  var PLAN = 220;

  // defend: weight of spoiling the opponents' lines; noise: how much the
  // scores are blurred; random: chance of a random move (a winning move is
  // never missed); plan: weight of the look-ahead bonus; jack: what using a
  // jack costs. In bot-vs-bot games Hard beats Normal about 60% of the time
  // and Normal beats Easy about 73% of the time.
  var LEVELS = {
    easy: { defend: 0.3, noise: 1, random: 0.35, plan: 0, jack: 25 },
    normal: { defend: 0.7, noise: 0.4, random: 0.1, plan: 0.4, jack: 40 },
    hard: { defend: 1, noise: 0.03, random: 0, plan: 1, jack: 70 }
  };

  /**
   * For every line of five: each team's chips (corners count for both),
   * chips without corners, and whether the line can still become a new
   * sequence for that team.
   */
  function analyse(board, seqs) {
    var n = E.WINDOWS.length;
    var a = { cnt: [[], []], raw: [[], []], open: [[], []] };
    for (var w = 0; w < n; w++) {
      var cells = E.WINDOWS[w], t0 = 0, t1 = 0, free = 0;
      for (var k = 0; k < 5; k++) {
        var i = cells[k];
        if (E.isCorner(i)) free++;
        else if (board.charAt(i) === '0') t0++;
        else if (board.charAt(i) === '1') t1++;
      }
      a.raw[0][w] = t0; a.raw[1][w] = t1;
      a.cnt[0][w] = t0 + free; a.cnt[1][w] = t1 + free;
      a.open[0][w] = t1 === 0 && E.canAddSequence(cells, seqs, 0);
      a.open[1][w] = t0 === 0 && E.canAddSequence(cells, seqs, 1);
    }
    return a;
  }

  /** Cards in `hand` (other than `skipSlot`) that could fill cell `e` next turn. */
  function canFill(hand, skipSlot, e) {
    for (var s = 0; s < hand.length; s++) {
      var card = hand[s];
      if (s === skipSlot || !card) continue;
      if (E.isTwoEyed(card)) return true;
      if (!E.isJack(card) && E.LAYOUT[e] === card) return true;
    }
    return false;
  }

  function scorePlace(ctx, move) {
    var a = ctx.a, team = ctx.team, opp = 1 - team, i = move.i, lv = ctx.level;
    var score = 0, k, w;
    var board = E.setCell(ctx.state.board, i, E.chipOf(team));
    var made = E.newSequences(board, ctx.state.seqs, i, team).length;
    if (made) {
      if (ctx.mySeqs + made >= E.SEQS_TO_WIN) return WIN;
      score += SEQUENCE * made;
    }
    var finishCells = {};
    var finishes = 0;
    var wins = E.WINDOWS_AT[i];
    for (k = 0; k < wins.length; k++) {
      w = wins[k];
      var c = a.cnt[team][w];
      if (a.open[team][w] && c < 4) {
        score += LINE[c + 1] - LINE[c];
        if (c === 3 && lv.plan) {
          // Four in this line after the move: can we finish it next turn?
          var cells = E.WINDOWS[w];
          for (var m = 0; m < 5; m++) {
            var e = cells[m];
            if (e !== i && !E.isCorner(e) && ctx.state.board.charAt(e) === E.EMPTY &&
                !finishCells[e] && canFill(ctx.hand, move.slot, e)) {
              finishCells[e] = true;
              finishes++;
            }
          }
        }
      }
      if (a.open[opp][w]) {
        var o = a.cnt[opp][w];
        score += lv.defend * (o >= 4 ? ctx.blockValue : LINE[o]);
      }
    }
    score += lv.plan * PLAN * Math.min(finishes, 2);
    if (E.isTwoEyed(move.card)) score -= lv.jack;
    return score;
  }

  function scoreRemove(ctx, move) {
    var a = ctx.a, team = ctx.team, opp = 1 - team, i = move.i, lv = ctx.level;
    var score = 0;
    var wins = E.WINDOWS_AT[i];
    for (var k = 0; k < wins.length; k++) {
      var w = wins[k];
      if (a.open[opp][w]) {
        var o = a.cnt[opp][w];
        score += lv.defend * (o >= 4 ? 0.8 * ctx.blockValue : LINE[o] - LINE[o - 1]);
      }
      // Our lines that only this chip was spoiling open up again.
      if (a.raw[opp][w] === 1 && E.canAddSequence(E.WINDOWS[w], ctx.state.seqs, team)) {
        score += LINE[Math.min(a.cnt[team][w], 4)];
      }
    }
    return score - 0.8 * lv.jack;
  }

  /** Slot of a dead card to swap before playing, or -1. */
  function deadCardSlot(state, hand) {
    for (var s = 0; s < hand.length; s++) {
      if (hand[s] && E.isDead(state.board, hand[s])) return s;
    }
    return -1;
  }

  /**
   * Picks the move for the bot in `seat` holding `hand`.
   * Returns { t: 'p' | 'r', slot, card, i }, or { t: 'q' } (pass) when no
   * card can be played. opts: { level: 'easy' | 'normal' | 'hard', rng }
   */
  function chooseMove(state, hand, seat, opts) {
    opts = opts || {};
    var rng = opts.rng || E.random;
    var level = LEVELS[opts.level] || LEVELS.normal;
    var team = E.teamOf(seat);
    var moves = E.legalMoves(state.board, state.seqs, hand, team);
    if (!moves.length) return { t: 'q' };

    var ctx = {
      state: state, hand: hand, team: team, level: level,
      a: analyse(state.board, state.seqs),
      mySeqs: E.countSeqs(state.seqs, team),
      blockValue: E.countSeqs(state.seqs, 1 - team) >= E.SEQS_TO_WIN - 1 ? BLOCK_WIN : BLOCK_SEQUENCE
    };
    var scores = [], k;
    for (k = 0; k < moves.length; k++) {
      scores.push(moves[k].t === 'r' ? scoreRemove(ctx, moves[k]) : scorePlace(ctx, moves[k]));
      if (scores[k] >= WIN) return moves[k];
    }
    if (level.random && rng() < level.random) return moves[Math.floor(rng() * moves.length)];

    var best = null, bestScore = -Infinity;
    for (k = 0; k < moves.length; k++) {
      var score = scores[k] + level.noise * (Math.abs(scores[k]) + 10) * (rng() * 2 - 1);
      score += rng() * 0.01; // break ties at random
      if (score > bestScore) { bestScore = score; best = moves[k]; }
    }
    return best;
  }

  return {
    LEVELS: LEVELS,
    analyse: analyse,
    deadCardSlot: deadCardSlot,
    chooseMove: chooseMove
  };
});
