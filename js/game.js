/*
 * Sequence online: rooms, lobby, board and the host's game loop.
 *
 * How the two browsers stay in step:
 *  - One game state per room in Firebase (rooms/CODE/state). Both players
 *    listen to it and redraw whenever it changes.
 *  - Only the host's browser writes it. The host deals, plays the bots'
 *    turns and applies the guest's moves (see host.js).
 *  - The guest writes just one thing: a request for its own move
 *    (rooms/CODE/req). The host checks it and applies it.
 *  - Each hand is stored under its own key (hands/CODE/host,
 *    hands/CODE/guest), and the database rules let only its owner read it.
 *    The draw pile and the bots' hands (secret/CODE) are for the host only.
 *  - Players sign in anonymously; the browser remembers the account, so a
 *    refresh or reconnect brings back the same seat and hand.
 *
 * Plain ES5 so it runs on older iPhones.
 */
(function () {
  'use strict';

  var E = window.SeqEngine;
  var Host = window.SeqHost;
  var Net = window.SeqNet;
  var CONFIG = window.SEQUENCE_FIREBASE_CONFIG;

  var CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O: they look like 1 and 0
  var BOT_DELAY = window.SEQUENCE_BOT_DELAY || 1200; // ms, so people can follow the bots' moves
  var NAME_KEY = 'sequence.name';
  var ROOM_KEY = 'sequence.room';
  var ROLE_SEAT = { host: 0, guest: 2 };
  var BOT_NAMES = { 1: 'Bot A', 3: 'Bot B' };
  var TEAM_NAMES = ['Blue', 'Red'];
  var LEVEL_NAMES = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
  var RULES_HINT = 'The database refused it. Has the site owner published database.rules.json in Firebase (see the README)?';
  var STALL_MS = 10000; // a bot's turn taking longer than this means the host's device is asleep

  var app = {
    uid: null,
    code: null,
    role: null,         // 'host' or 'guest'
    room: null,         // the room as stored (players, presence, state, req)
    state: null,        // the game state, normalised
    hand: E.normHand(null),
    secret: null,       // host only: draw pile, discards, bot hands
    connected: false,
    everConnected: false,
    selected: -1,       // slot of the selected card
    pending: null,      // guest: the move request on its way to the host
    overHidden: -1,     // game number whose result box was closed
    stops: [],
    botTimer: null,
    botFor: -1,         // state version a bot move is scheduled for
    since: 0,           // when the current game version arrived
    cells: [],
    cards: []
  };

  function $(id) { return document.getElementById(id); }

  // ---- Small helpers ------------------------------------------------------

  function load(key) {
    try { return window.localStorage.getItem(key) || ''; } catch (e) { return ''; }
  }

  function save(key, value) {
    try {
      if (value) window.localStorage.setItem(key, value);
      else window.localStorage.removeItem(key);
    } catch (e) { /* private mode */ }
  }

  function randomFrom(letters, n) {
    var out = '';
    for (var i = 0; i < n; i++) out += letters.charAt(Math.floor(E.random() * letters.length));
    return out;
  }

  function cleanCode(text) {
    return String(text || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  }

  function codeFromHash() {
    var code = cleanCode(window.location.hash.replace(/^#/, ''));
    return code.length === 4 ? code : '';
  }

  function inviteLink() {
    return window.location.href.split('#')[0] + '#' + app.code;
  }

  var toastTimer = null;
  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4000);
  }

  function errorText(err) {
    return (err && err.message) || String(err);
  }

  function show(name) {
    var screens = ['setup', 'old', 'home', 'lobby', 'game'];
    for (var i = 0; i < screens.length; i++) $('screen-' + screens[i]).hidden = screens[i] !== name;
    $('room-chip').hidden = !(app.code && (name === 'lobby' || name === 'game'));
    $('room-chip-code').textContent = app.code || '';
    document.body.className = 'on-' + name;
    if (name === 'game') sizeBoard();
  }

  function homeMsg(text) {
    var el = $('home-msg');
    el.textContent = text || '';
    el.hidden = !text;
  }

  // ---- Connection indicator -----------------------------------------------

  function setConn(kind, text) {
    $('conn').className = 'conn conn-' + kind;
    $('conn-text').textContent = text;
  }

  function onConnection(on) {
    app.connected = on;
    if (on && !app.everConnected && /server can't be reached/.test($('home-msg').textContent)) homeMsg('');
    if (on) app.everConnected = true;
    if (on) setConn('on', 'Online');
    else if (app.everConnected) setConn('off', 'Offline – reconnecting…');
    else setConn('wait', 'Connecting…');
    if (app.state) render();
  }

  // ---- Players ------------------------------------------------------------

  function mySeat() { return ROLE_SEAT[app.role]; }

  function player(seat) {
    var p = app.room && app.room.players;
    if (!p) return null;
    return seat === 0 ? p.host || null : seat === 2 ? p.guest || null : null;
  }

  function seatName(seat) {
    if (BOT_NAMES[seat]) return BOT_NAMES[seat];
    var p = player(seat);
    return p ? p.name : (seat === 0 ? 'The host' : 'Your friend');
  }

  /** "You" for this player, otherwise the seat's name. */
  function who(seat) { return seat === mySeat() ? 'You' : seatName(seat); }

  function isOnline(seat) {
    var pr = app.room && app.room.presence;
    var p = pr && pr[seat === 0 ? 'host' : 'guest'];
    return !!(p && p.on);
  }

  function isMyTurn() {
    return !!app.state && app.state.status === 'playing' && app.state.turn === mySeat();
  }

  // ---- Starting up ----------------------------------------------------------

  function init() {
    buildBoard();
    buildHand();
    bindUi();
    $('name').value = load(NAME_KEY);
    var rules = document.querySelector('#screen-home .rules');
    if (rules) $('game-rules').appendChild(rules.querySelector('ul').cloneNode(true));

    if (!Net.configured(CONFIG)) {
      setConn('off', 'Not set up');
      show('setup');
      return;
    }
    if (!Net.sdkLoaded()) {
      setConn('off', 'Not supported');
      show('old');
      return;
    }
    setTimeout(function () {
      if (app.everConnected) return;
      setConn('off', 'Cannot reach Firebase');
      homeMsg('The game server can\'t be reached. Check your internet connection. If it works for other sites, ' +
        'the databaseURL in js/firebase-config.js may be wrong.');
    }, 15000);
    Net.start(CONFIG).then(function (uid) {
      app.uid = uid;
      Net.onConnection(onConnection);
      var code = codeFromHash();
      if (code) resume(code);
      else showHome();
    }, function (err) {
      setConn('off', 'Sign-in failed');
      showHome();
      homeMsg('Could not connect: ' + errorText(err) + '. Check that Anonymous sign-in is turned on in Firebase.');
    });
  }

  function showHome() {
    stopRoom();
    var last = load(ROOM_KEY);
    $('resume-box').hidden = !last;
    $('resume-code').textContent = last;
    show('home');
  }

  /** Opening a room link: back to your seat if you have one, else offer to join. */
  function resume(code) {
    homeMsg('');
    return Net.get('rooms/' + code + '/players').then(function (players) {
      if (players && players.host && players.host.uid === app.uid) return enterRoom(code, 'host');
      if (players && players.guest && players.guest.uid === app.uid) return enterRoom(code, 'guest');
      showHome();
      $('join-code').value = code;
      if (!players || !players.host) homeMsg('There is no room ' + code + '. Check the code with your friend.');
      else if (players.guest) homeMsg('Room ' + code + ' already has two players.');
      else homeMsg(players.host.name + ' invited you. Type your name and tap Join.');
    }, function (err) {
      showHome();
      homeMsg('Could not open room ' + code + ': ' + errorText(err));
    });
  }

  function myName() {
    var name = $('name').value.replace(/\s+/g, ' ').replace(/^ | $/g, '').slice(0, 20);
    if (!name) {
      homeMsg('Please type your name first.');
      $('name').focus();
      return '';
    }
    save(NAME_KEY, name);
    return name;
  }

  function createRoom() {
    var name = myName();
    if (!name || !app.uid) return;
    var level = $('level').value;
    var tries = 0;
    homeMsg('');
    $('btn-create').disabled = true;
    function attempt() {
      var code = randomFrom(CODE_LETTERS, 4);
      var room = {
        created: Net.TIMESTAMP,
        players: { host: { uid: app.uid, name: name } },
        state: { v: 1, status: 'lobby', game: 0, diff: level }
      };
      // The rules refuse a code that is already in use; then try another.
      // If several fresh codes are all refused, the rules are not set up.
      return Net.set('rooms/' + code, room).then(function () { return code; }, function (err) {
        if (!Net.isPermissionDenied(err)) throw err;
        if (++tries < 5) return attempt();
        throw new Error(RULES_HINT);
      });
    }
    attempt().then(function (code) {
      $('btn-create').disabled = false;
      enterRoom(code, 'host');
    }, function (err) {
      $('btn-create').disabled = false;
      homeMsg('Could not create a room: ' + errorText(err));
    });
  }

  function joinRoom(code) {
    var name = myName();
    if (!name || !app.uid) return;
    code = cleanCode(code);
    if (code.length !== 4) {
      homeMsg('Room codes have four letters.');
      return;
    }
    homeMsg('');
    $('btn-join').disabled = true;
    Net.get('rooms/' + code + '/players').then(function (players) {
      if (!players || !players.host) throw new Error('There is no room ' + code + '. Check the code with your friend.');
      if (players.host.uid === app.uid) return 'host';
      if (players.guest && players.guest.uid === app.uid) return 'guest';
      if (players.guest) throw new Error('Room ' + code + ' already has two players.');
      return Net.set('rooms/' + code + '/players/guest', { uid: app.uid, name: name }).then(function () {
        return 'guest';
      }, function (err) {
        if (Net.isPermissionDenied(err)) throw new Error('Someone else just took the seat in room ' + code + '.');
        throw err;
      });
    }).then(function (role) {
      $('btn-join').disabled = false;
      enterRoom(code, role);
    }, function (err) {
      $('btn-join').disabled = false;
      homeMsg(errorText(err));
    });
  }

  function enterRoom(code, role) {
    stopRoom();
    app.code = code;
    app.role = role;
    save(ROOM_KEY, code);
    if (codeFromHash() !== code) window.location.hash = code;
    app.stops.push(Net.watch('rooms/' + code, onRoom, onRoomLost));
    app.stops.push(Net.watch('hands/' + code + '/' + role, onHand));
    if (role === 'host') app.stops.push(Net.watch('secret/' + code, onSecret));
    app.stops.push(Net.presence('rooms/' + code + '/presence/' + role));
  }

  function stopRoom() {
    for (var i = 0; i < app.stops.length; i++) app.stops[i]();
    app.stops = [];
    clearTimeout(app.botTimer);
    app.code = null;
    app.role = null;
    app.room = null;
    app.state = null;
    app.secret = null;
    app.hand = E.normHand(null);
    app.selected = -1;
    app.pending = null;
    app.botFor = -1;
  }

  function leaveRoom() {
    var code = app.code;
    if (!code) return;
    var host = app.role === 'host';
    var question = host ?
      'Close room ' + code + ' for both of you? The game will be deleted.' :
      'Leave room ' + code + '? Your seat will be free for someone else.';
    if (!window.confirm(question)) return;
    var done = function () {
      save(ROOM_KEY, '');
      clearHash();
      showHome();
    };
    if (host) {
      var u = {};
      u['rooms/' + code] = null;
      u['hands/' + code] = null;
      u['secret/' + code] = null;
      stopRoom();
      Net.update(u).then(done, function (err) { done(); toast('Could not delete the room: ' + errorText(err)); });
    } else {
      stopRoom();
      Net.remove('rooms/' + code + '/players/guest').then(done, done);
    }
  }

  // ---- Data from Firebase -----------------------------------------------------

  function onRoom(room) {
    if (!room) {
      roomGone('Room ' + app.code + ' was closed.');
      return;
    }
    app.room = room;
    var v = app.state ? app.state.v : -1;
    app.state = E.normState(room.state);
    if (app.state.v !== v) app.since = Date.now();
    if (app.role === 'guest') checkPending();
    render();
    if (app.role === 'host') hostTick();
  }

  function onRoomLost() {
    roomGone(app.role === 'guest' ?
      'You are no longer in room ' + app.code + '. The host closed it or gave your seat away.' :
      'Room ' + app.code + ' can no longer be opened.');
  }

  function clearHash() {
    if (window.history && window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } else {
      window.location.hash = '';
    }
  }

  function roomGone(text) {
    save(ROOM_KEY, '');
    clearHash();
    showHome();
    homeMsg(text);
  }

  function onHand(value) {
    app.hand = E.normHand(value);
    if (app.selected >= 0 && !app.hand[app.selected]) app.selected = -1;
    if (app.state) render();
  }

  function onSecret(value) {
    app.secret = value ? E.normSecret(value) : null;
    hostTick();
  }

  // ---- The host's game loop -------------------------------------------------

  /** Saves one move. If it is refused (for example a second tab got there first), try again. */
  function commit(updates) {
    return Net.update(updates).catch(function (err) {
      app.botFor = -1;
      if (!Net.isPermissionDenied(err)) toast('Could not save the move: ' + errorText(err));
      setTimeout(hostTick, 500);
    });
  }

  function hostTick() {
    if (app.role !== 'host' || !app.room) return;
    var action = Host.nextAction(app.state, app.secret, app.room.req);
    if (action === 'guest') {
      commit(Host.guestMove(app.code, app.state, app.secret, app.room.req).updates);
    } else if (action === 'bot') {
      scheduleBot();
    }
  }

  function scheduleBot() {
    var v = app.state.v;
    if (app.botFor === v) return;
    app.botFor = v;
    clearTimeout(app.botTimer);
    app.botTimer = setTimeout(function () {
      if (Host.nextAction(app.state, app.secret, null) !== 'bot' || app.state.v !== v) {
        app.botFor = -1;
        hostTick();
        return;
      }
      commit(Host.botTurn(app.code, app.state, app.secret).updates);
    }, BOT_DELAY);
  }

  function startGame() {
    if (app.role !== 'host' || !app.state) return;
    commit(Host.startGame(app.code, app.state));
  }

  function setLevel(level) {
    if (app.role !== 'host' || !app.state || !LEVEL_NAMES[level] || level === app.state.diff) return;
    commit(Host.setLevel(app.code, app.state, level));
  }

  // ---- Moves ------------------------------------------------------------------

  function play(move) {
    if (!isMyTurn() || app.pending) return;
    app.selected = -1;
    if (app.role === 'host') {
      if (!app.secret || app.secret.v !== app.state.v) {
        toast('One moment, still saving the last move…');
        return;
      }
      var r = Host.hostMove(app.code, app.state, app.secret, app.hand, move);
      if (r.error) { toast(r.error); render(); return; }
      commit(r.updates);
    } else {
      sendRequest(move);
    }
    render();
  }

  /** The guest's move goes to the host as a request (rooms/CODE/req). */
  function sendRequest(move) {
    var req = { id: randomFrom('abcdefghijklmnopqrstuvwxyz0123456789', 10), v: app.state.v, t: move.t };
    if (move.t !== 'q') {
      req.slot = String(move.slot);
      req.card = move.card;
    }
    if (typeof move.i === 'number') req.i = move.i;
    app.pending = req;
    Net.set('rooms/' + app.code + '/req', req).catch(function (err) {
      if (app.pending && app.pending.id === req.id) app.pending = null;
      toast(Net.isPermissionDenied(err) ? 'That move was refused: it is no longer your turn.' :
        'Could not send your move: ' + errorText(err));
      render();
    });
  }

  function checkPending() {
    var req = app.room.req;
    var p = app.pending;
    if (p && app.state.v > p.v) app.pending = null; // the host applied it
    if (req && req.err) {
      if (!p || req.id === p.id) toast(req.err);
      if (p && req.id === p.id) app.pending = null;
      Net.remove('rooms/' + app.code + '/req').catch(function () {});
    }
  }

  function selectedCard() {
    return app.selected >= 0 ? app.hand[app.selected] : null;
  }

  function onCardClick(slot) {
    if (!app.hand[slot]) return;
    app.selected = app.selected === slot ? -1 : slot;
    render();
  }

  function onCellClick(i) {
    var card = selectedCard();
    if (!isMyTurn() || app.pending) return;
    if (!card) {
      // No card picked yet: pick the one that fits this space, if there is one.
      for (var s = 0; s < app.hand.length; s++) {
        if (app.hand[s] === E.LAYOUT[i] && app.state.board.charAt(i) === E.EMPTY) {
          app.selected = s;
          render();
          return;
        }
      }
      toast('Pick a card from your hand first.');
      return;
    }
    var team = E.teamOf(mySeat());
    if (E.targets(app.state.board, app.state.seqs, card, team).indexOf(i) < 0) {
      toast(E.isOneEyed(card) ? 'Pick a red chip that is not part of a sequence.' :
        E.isDead(app.state.board, card) ? 'This card is dead: both of its spaces are taken. Swap it.' :
          'That space is not open for ' + E.cardLabel(card) + '.');
      return;
    }
    play({ t: E.isOneEyed(card) ? 'r' : 'p', slot: app.selected, card: card, i: i });
  }

  function swapDead() {
    var card = selectedCard();
    if (card && E.isDead(app.state.board, card)) play({ t: 'x', slot: app.selected, card: card });
  }

  function pass() {
    if (window.confirm('You have no card you can play. Pass your turn?')) play({ t: 'q' });
  }

  // ---- Drawing the page -------------------------------------------------------

  function buildBoard() {
    var board = $('board');
    for (var i = 0; i < E.CELLS; i++) {
      var card = E.LAYOUT[i];
      var el = document.createElement('button');
      el.type = 'button';
      el.setAttribute('data-i', i);
      el.tabIndex = -1;
      if (E.isCorner(i)) {
        el.innerHTML = '<span class="free-star">★</span><span class="chip"></span>';
      } else {
        el.innerHTML = '<span class="rank">' + E.rankLabel(card) + '</span><span class="suit">' +
          E.suitSymbol(card) + '</span><span class="chip"></span>';
      }
      board.appendChild(el);
      app.cells.push(el);
    }
    board.addEventListener('click', function (e) {
      var el = e.target;
      while (el && el !== board && !el.hasAttribute('data-i')) el = el.parentNode;
      if (el && el !== board) onCellClick(Number(el.getAttribute('data-i')));
    }, false);
  }

  function buildHand() {
    var hand = $('hand');
    for (var s = 0; s < E.HAND_SIZE; s++) {
      var el = document.createElement('button');
      el.type = 'button';
      el.setAttribute('data-slot', s);
      el.innerHTML = '<span class="c-rank"></span><span class="c-suit"></span><span class="c-big"></span><span class="c-tag"></span>';
      hand.appendChild(el);
      app.cards.push(el);
    }
    hand.addEventListener('click', function (e) {
      var el = e.target;
      while (el && el !== hand && !el.hasAttribute('data-slot')) el = el.parentNode;
      if (el && el !== hand) onCardClick(Number(el.getAttribute('data-slot')));
    }, false);
  }

  // Board text scales with the board, so it reads well on a phone and a laptop.
  function sizeBoard() {
    var board = $('board');
    var w = board.offsetWidth;
    if (w) board.style.fontSize = Math.max(8, w / 10 * 0.3) + 'px';
  }

  function render() {
    if (!app.state) return;
    if (app.state.status === 'lobby') {
      show('lobby');
      renderLobby();
    } else {
      if ($('screen-game').hidden) show('game');
      renderGame();
    }
  }

  function renderLobby() {
    var host = app.role === 'host';
    var guest = player(2);
    $('lobby-code').textContent = app.code;
    $('btn-share').hidden = !navigator.share;
    var rows = [
      playerRow(0, 'blue team'),
      guest ? playerRow(2, 'blue team') :
        '<li class="lp team-0 waiting"><span class="seat-chip"></span><span class="lp-name">Waiting for your friend…</span></li>',
      '<li class="lp team-1"><span class="seat-chip"></span><span class="lp-name">Bot A and Bot B</span><span class="lp-tag">red team · ' +
        LEVEL_NAMES[app.state.diff] + '</span></li>'
    ];
    $('lobby-players').innerHTML = rows.join('');
    $('lobby-host').hidden = !host;
    $('lobby-level').value = app.state.diff;
    $('btn-start').disabled = !guest;
    $('lobby-hint').hidden = !host;
    var msg;
    if (host) msg = guest ? 'Everyone is here. Start when you are ready.' : 'When your friend joins, their name appears here.';
    else msg = 'Waiting for ' + seatName(0) + ' to start the game.';
    $('lobby-msg').textContent = msg;
    var kick = $('lobby-players').querySelector('.lp-remove');
    if (kick) kick.addEventListener('click', freeGuestSeat, false);
  }

  function playerRow(seat, team) {
    var me = seat === mySeat();
    var tags = [team, seat === 0 ? 'host' : 'guest'];
    if (me) tags.push('you');
    var html = '<li class="lp team-0"><span class="seat-chip"></span><span class="lp-name">' + esc(seatName(seat)) +
      '</span><span class="lp-tag">' + tags.join(' · ') + '</span>' +
      '<span class="presence ' + (isOnline(seat) ? 'is-on' : 'is-off') + '" title="' +
      (isOnline(seat) ? 'online' : 'offline') + '"></span>';
    if (seat === 2 && app.role === 'host') html += '<button class="lp-remove btn-link" type="button">Remove</button>';
    return html + '</li>';
  }

  function freeGuestSeat() {
    if (!window.confirm('Free ' + seatName(2) + '\'s seat? They (or someone else) can then join again with the room code, and get the same cards back.')) return;
    Net.remove('rooms/' + app.code + '/players/guest').catch(function (err) { toast(errorText(err)); });
  }

  function esc(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderGame() {
    var guest = player(2);
    $('btn-free-seat').hidden = !(app.role === 'host' && guest && !isOnline(2));
    $('btn-free-seat').textContent = guest ? 'Has ' + guest.name + ' changed phone or browser? Free their seat' : '';
    renderSeats();
    renderScore();
    renderBoard();
    renderHand();
    renderTurn();
    renderActions();
    renderLog();
    renderOver();
  }

  function renderSeats() {
    var s = app.state;
    var html = '';
    for (var seat = 0; seat < E.SEATS; seat++) {
      var bot = !!BOT_NAMES[seat];
      var cls = 'seat team-' + E.teamOf(seat) + (s.turn === seat && s.status === 'playing' ? ' is-turn' : '') +
        (seat === mySeat() ? ' is-me' : '');
      var status = bot ? '<span class="seat-bot" title="bot">bot</span>' :
        '<span class="presence ' + (isOnline(seat) ? 'is-on' : 'is-off') + '" title="' +
        (isOnline(seat) ? 'online' : 'offline') + '"></span>';
      html += '<li class="' + cls + '"><span class="seat-chip"></span><span class="seat-name">' + esc(seatName(seat)) +
        (seat === mySeat() ? ' <small>(you)</small>' : '') + '</span>' + status + '</li>';
    }
    $('seats').innerHTML = html;
  }

  function renderScore() {
    var s = app.state;
    var html = '';
    for (var t = 0; t < 2; t++) {
      var n = E.countSeqs(s.seqs, t);
      var dots = '';
      for (var k = 0; k < E.SEQS_TO_WIN; k++) dots += '<span class="pip' + (k < n ? ' full' : '') + '"></span>';
      html += '<span class="team-score team-' + t + '"><b>' + TEAM_NAMES[t] + '</b> ' + dots +
        ' <span class="sr">' + n + ' of ' + E.SEQS_TO_WIN + ' sequences</span></span>';
    }
    $('score').innerHTML = html;
  }

  function renderBoard() {
    var s = app.state;
    var locked = E.lockedCells(s.seqs);
    var card = selectedCard();
    var team = E.teamOf(mySeat());
    var targets = {};
    if (card && s.status === 'playing' && !app.pending) {
      var list = E.targets(s.board, s.seqs, card, team);
      for (var k = 0; k < list.length; k++) targets[list[k]] = true;
    }
    var mine = isMyTurn();
    var pendingCell = app.pending && typeof app.pending.i === 'number' ? app.pending.i : -1;
    for (var i = 0; i < E.CELLS; i++) {
      var el = app.cells[i];
      var ch = s.board.charAt(i);
      var cls = 'cell';
      if (E.isCorner(i)) cls += ' free';
      else cls += E.isRed(E.LAYOUT[i]) ? ' red' : ' black';
      if (ch === '0' || ch === '1') cls += ' has-' + ch;
      if (locked[i]) cls += ' locked';
      if (s.last && s.last.i === i) cls += s.last.k === 'r' ? ' last last-removed' : ' last';
      if (targets[i]) cls += E.isOneEyed(card) ? ' target-remove' : ' target';
      if (targets[i] && !mine) cls += ' preview';
      if (i === pendingCell) cls += app.pending.t === 'r' ? ' pending-remove' : ' pending';
      if (el.className !== cls) el.className = cls;
      el.tabIndex = targets[i] && mine ? 0 : -1;
      el.setAttribute('aria-label', cellLabel(i, ch, locked[i]));
    }
  }

  function cellLabel(i, ch, locked) {
    var text = E.isCorner(i) ? 'Free corner' : E.cardName(E.LAYOUT[i]);
    if (ch === '0') text += ', blue chip';
    if (ch === '1') text += ', red chip';
    if (locked) text += ' in a sequence';
    return text + ', ' + E.cellName(i);
  }

  function renderHand() {
    var s = app.state;
    for (var slot = 0; slot < E.HAND_SIZE; slot++) {
      var el = app.cards[slot];
      var card = app.hand[slot];
      var tag = '';
      var cls = 'card';
      if (!card) {
        el.className = 'card empty';
        el.disabled = true;
        el.setAttribute('aria-label', 'Empty');
        el.querySelector('.c-rank').textContent = '';
        el.querySelector('.c-suit').textContent = '';
        el.querySelector('.c-big').textContent = '';
        el.querySelector('.c-tag').textContent = '';
        continue;
      }
      el.disabled = false;
      cls += E.isRed(card) ? ' red' : ' black';
      if (E.isTwoEyed(card)) { tag = 'wild'; cls += ' jack-wild'; }
      if (E.isOneEyed(card)) { tag = 'remove'; cls += ' jack-remove'; }
      if (E.isDead(s.board, card)) { tag = 'dead'; cls += ' dead'; }
      if (slot === app.selected) cls += ' selected';
      if (app.pending && app.pending.slot === String(slot)) cls += ' sending';
      el.className = cls;
      el.querySelector('.c-rank').textContent = E.rankLabel(card);
      el.querySelector('.c-suit').textContent = E.suitSymbol(card);
      el.querySelector('.c-big').textContent = E.isJack(card) ? 'J' : E.suitSymbol(card);
      el.querySelector('.c-tag').textContent = tag;
      el.setAttribute('aria-label', E.cardName(card) + (tag ? ', ' + tag : '') + (slot === app.selected ? ', selected' : ''));
      el.setAttribute('aria-pressed', slot === app.selected ? 'true' : 'false');
    }
  }

  function turnText() {
    var s = app.state;
    var turn = s.turn;
    if (s.status === 'over') {
      return s.win === 2 ? 'Game over: a draw. ' : 'Game over: ' + TEAM_NAMES[s.win] + ' wins. ';
    }
    if (!app.connected && app.everConnected) return 'You are offline. Reconnecting…';
    if (app.pending) {
      return app.role === 'guest' && !isOnline(0) ?
        'Your move is saved. It will be played when ' + seatName(0) + ' (host) is back online.' : 'Sending your move…';
    }
    if (turn === mySeat()) {
      var card = selectedCard();
      if (!card) return s.xc ? 'Your turn: now play a card.' : 'Your turn: pick a card, then a space.';
      if (E.isDead(s.board, card)) {
        return s.xc ? E.cardLabel(card) + ' is dead. You have already swapped one this turn.' :
          E.cardLabel(card) + ' is dead: both of its spaces are taken. Swap it for a new card.';
      }
      if (E.isOneEyed(card)) return 'Tap a red chip to remove it with ' + E.cardLabel(card) + '.';
      if (E.isTwoEyed(card)) return E.cardLabel(card) + ' is wild: tap any open space.';
      return 'Tap a glowing space to play ' + E.cardLabel(card) + '.';
    }
    var hostAway = app.role === 'guest' && !isOnline(0);
    if (BOT_NAMES[turn]) {
      if (hostAway) return seatName(0) + ' (host) is offline. The bots play on the host\'s device, so the game waits until they are back.';
      if (app.role === 'guest' && Date.now() - app.since > STALL_MS) {
        return seatName(turn) + ' is waiting for ' + seatName(0) + '\'s device, which plays the bots. Is it asleep?';
      }
      return seatName(turn) + ' is thinking…';
    }
    if (turn === 2 && !player(2)) return 'The guest seat is free. Send the room code so your friend can rejoin.';
    if (!isOnline(turn)) return seatName(turn) + ' is offline. The game waits until they are back.';
    if (app.role === 'guest' && hostAway) return seatName(0) + ' (host) is offline. The game waits until they are back.';
    return seatName(turn) + '\'s turn.';
  }

  function renderTurn() {
    var el = $('turn');
    var s = app.state;
    el.textContent = turnText();
    el.className = 'turn' + (isMyTurn() && !app.pending ? ' is-mine' : '') + (s.status === 'over' ? ' is-over' : '');
  }

  function hasAnyMove() {
    var s = app.state;
    return E.legalMoves(s.board, s.seqs, app.hand, E.teamOf(mySeat())).length > 0;
  }

  function renderActions() {
    var s = app.state;
    var card = selectedCard();
    var free = isMyTurn() && !app.pending;
    $('btn-swap').hidden = !(free && card && !s.xc && E.isDead(s.board, card));
    var deadInHand = false;
    for (var k = 0; k < app.hand.length; k++) if (app.hand[k] && E.isDead(s.board, app.hand[k])) deadInHand = true;
    $('btn-pass').hidden = !(free && !hasAnyMove() && (s.xc || !deadInHand));
    $('btn-result').hidden = !(s.status === 'over' && app.overHidden === s.game);
    var top = s.top ? '<span class="mini ' + (E.isRed(s.top) ? 'red' : 'black') + '">' + E.cardLabel(s.top) + '</span>' : '–';
    $('pile').innerHTML = 'Last card played ' + top + ' · ' + s.deck + ' cards left in the deck';
  }

  function logText(e) {
    var space = typeof e.i === 'number' && E.LAYOUT[e.i] ? E.cardLabel(E.LAYOUT[e.i]) : '';
    switch (e.k) {
      case 'start': return 'New game. ' + who(e.s) + (e.s === mySeat() ? ' go' : ' goes') + ' first.';
      case 'p': return who(e.s) + ' played ' + E.cardLabel(e.c) + (E.isTwoEyed(e.c) ? ' (wild) on ' + space : '') + '.';
      case 'r': return who(e.s) + ' used ' + E.cardLabel(e.c) + ' to remove a ' + (E.teamOf(e.s) === 0 ? 'red' : 'blue') + ' chip from ' + space + '.';
      case 'x': return who(e.s) + ' swapped a dead ' + E.cardLabel(e.c) + '.';
      case 'q': return who(e.s) + (e.s === mySeat() ? ' pass' : ' passes') + ': no card can be played.';
      case 'seq': return TEAM_NAMES[e.t] + ' made a sequence! (' + e.n + ' of ' + E.SEQS_TO_WIN + ')';
      case 'win': return TEAM_NAMES[e.t] + ' wins the game!';
      case 'draw': return 'Nobody can move. The game is a draw.';
      default: return '';
    }
  }

  function renderLog() {
    var log = app.state.log;
    var html = '';
    for (var k = log.length - 1; k >= 0 && k >= log.length - 8; k--) {
      var cls = log[k].k === 'seq' || log[k].k === 'win' ? ' class="big team-' + log[k].t + '"' : '';
      html += '<li' + cls + '>' + esc(logText(log[k])) + '</li>';
    }
    $('log').innerHTML = html;
  }

  function renderOver() {
    var s = app.state;
    var over = s.status === 'over';
    $('over').hidden = !over || app.overHidden === s.game;
    if (!over) return;
    var title, text;
    if (s.win === 2) {
      title = 'It\'s a draw';
      text = 'Nobody could make a move.';
    } else if (s.win === 0) {
      title = 'You win! 🎉';
      text = 'Blue made ' + E.countSeqs(s.seqs, 0) + ' sequences. Well played, ' + esc(seatName(0)) + ' and ' + esc(seatName(2)) + '.';
    } else {
      title = 'The bots win';
      text = 'Red made ' + E.countSeqs(s.seqs, 1) + ' sequences. Try again?';
    }
    $('over-title').innerHTML = title;
    $('over-text').innerHTML = text;
    $('over-host').hidden = app.role !== 'host';
    $('over-level').value = s.diff;
    $('over-wait').hidden = app.role === 'host';
    $('over-wait').textContent = 'Waiting for ' + seatName(0) + ' to start a new game.';
  }

  // ---- Sharing --------------------------------------------------------------

  function copyLink() {
    var link = inviteLink();
    var ok = function () { toast('Invite link copied. Send it to your friend.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(ok, function () { fallbackCopy(link) ? ok() : toast(link); });
    } else if (fallbackCopy(link)) {
      ok();
    } else {
      toast(link);
    }
  }

  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'absolute';
    area.style.left = '-9999px';
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  function shareLink() {
    if (!navigator.share) return copyLink();
    navigator.share({
      title: 'Sequence',
      text: 'Join my Sequence game. Room code: ' + app.code,
      url: inviteLink()
    }).catch(function () { /* closed the share sheet */ });
  }

  // ---- Buttons ----------------------------------------------------------------

  function on(id, fn) {
    $(id).addEventListener('click', function (e) { e.preventDefault(); fn(); }, false);
  }

  function bindUi() {
    on('btn-create', createRoom);
    $('join-form').addEventListener('submit', function (e) {
      e.preventDefault();
      joinRoom($('join-code').value);
    }, false);
    $('join-code').addEventListener('input', function () {
      var v = cleanCode(this.value);
      if (v !== this.value) this.value = v;
    }, false);
    on('btn-resume', function () {
      var code = load(ROOM_KEY);
      if (code) resume(code);
    });
    on('btn-copy', copyLink);
    on('btn-share', shareLink);
    on('room-chip', copyLink);
    on('btn-start', startGame);
    on('btn-again', startGame);
    $('lobby-level').addEventListener('change', function () { setLevel(this.value); }, false);
    $('over-level').addEventListener('change', function () { setLevel(this.value); }, false);
    on('btn-free-seat', freeGuestSeat);
    on('btn-leave-lobby', leaveRoom);
    on('btn-leave', leaveRoom);
    on('btn-swap', swapDead);
    on('btn-pass', pass);
    on('btn-over-board', function () {
      app.overHidden = app.state ? app.state.game : -1;
      render();
    });
    var showResult = function () {
      if (app.state && app.state.status === 'over') {
        app.overHidden = -1;
        render();
      }
    };
    on('turn', showResult);
    on('btn-result', showResult);
    // Refresh the turn line now and then, so a stalled bot turn is noticed.
    setInterval(function () { if (app.state && app.state.status === 'playing') renderTurn(); }, 2000);
    window.addEventListener('resize', sizeBoard, false);
    window.addEventListener('orientationchange', function () { setTimeout(sizeBoard, 300); }, false);
    window.addEventListener('hashchange', function () {
      var code = codeFromHash();
      if (app.uid && code && code !== app.code) resume(code);
    }, false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, false);
  } else {
    init();
  }
})();
