# Sequence-game

A simple browser based 2 v 2 Sequence board game simulator, with two AI
agents competing against two human players.

Two people on different phones or computers are the **blue** team; two bots
are the **red** team. There are no accounts and nothing to install: one player
creates a room, sends the 4-letter code (or link) to the other, and you play.

It is static files only (GitHub Pages, no build step). The game state is
shared through a free [Firebase Realtime Database](https://firebase.google.com/docs/database).
Once it is published (below), the game is at
<https://umairzia.github.io/Sequence-game/>.

## How to play

- Turns go round the table: **host, Bot A, guest, Bot B**.
- Pick a card from your hand, then tap a space showing that card. Every card
  (except jacks) is on the board twice. If you tap a space first, the
  matching card in your hand is picked; tap the space again to play it.
- The four **corners** are free spaces: they count as a chip for everyone.
- **Jack of ♦ or ♣** (two eyes) is wild: put a chip on any open space.
- **Jack of ♠ or ♥** (one eye) removes one red chip, but not a chip that is
  part of a finished sequence.
- Five in a row (across, down or diagonal) is a **sequence**. The first team
  to make **two** sequences wins. The second one may share one chip with the
  first.
- A card is **dead** when both of its spaces are taken. Once per turn you can
  swap it for a new card before you play (tap it, then **Swap dead card**).
- If no card can be played at all, a **Pass** button appears.

These are the official rules for two teams of two: 6 cards each, two
sequences to win. Two small additions cover cases the official rules leave
open: when the draw pile runs out, the played cards are shuffled into a new
one, and if all four players pass in a row the game is a draw.

**The bots** look one move ahead. They take a winning move whenever there is
one. Otherwise they score every possible move: how much it builds their own
lines of five, how much it spoils yours (blocking four in a row matters most),
whether it sets up a line they can finish with a card they hold, and they
avoid spending jacks on small gains. The host picks how well they play:
**Easy** (often careless), **Normal** or **Hard**. In bot-against-bot games,
Hard beats Normal about 60% of the time and Normal beats Easy about 73% of the
time. Cards bring a lot of luck, so even Easy wins sometimes.

**On screen:** the dot in the top-right corner shows your connection
(green Online, amber Connecting, red Offline). Below the top bar are the four
seats in turn order: the player whose turn it is has a gold border, and the
two people have a green (online) or grey (offline) dot. The bar above the
board turns yellow when it is your turn; the pips show each team's sequences
(two needed).

## Put it online (GitHub Pages)

In this repository on GitHub: **Settings › Pages**. Under **Build and
deployment**, choose **Deploy from a branch**, pick **main** and **/ (root)**,
and **Save**. A minute or two later the game is at
<https://umairzia.github.io/Sequence-game/>, and every change merged into
`main` is published the same way. Pages is free for public repositories.

## Set up Firebase (once, about 10 minutes)

This project is already connected to the Firebase project
`sequencegame-prototype1` (see [`js/firebase-config.js`](js/firebase-config.js)).
These steps are for setting up a new one.

You need a Google account. Everything here fits in Firebase's free **Spark**
plan; no credit card is needed.

1. **Create a project.** Open <https://console.firebase.google.com>, click
   **Create a project** (or **Add project**), give it a name such as
   `sequence-game` and click through. Google Analytics is not needed, so you
   can turn it off.

2. **Turn on anonymous sign-in.** In the left menu open **Security ›
   Authentication** (called **Build › Authentication** in older versions of
   the console) and click **Get started**. On the **Sign-in method** tab,
   choose **Anonymous**, switch it on and **Save**. (Players never see this.
   Each browser gets an anonymous ID, which is how the game knows who is in
   which seat after a refresh.)

3. **Create the database.** Open **Databases & Storage › Realtime Database**
   (older consoles: **Build › Realtime Database**) and click **Create
   Database**. Pick the location nearest to you and your friend, choose
   **Start in locked mode**, and click **Enable**. If Firebase says "An error
   occurred while creating your database", pick another location; Belgium
   (europe-west1) has worked when the United States failed. The database's
   address is shown at the top of the **Data** tab, for example
   `https://sequence-game-default-rtdb.europe-west1.firebasedatabase.app`.

4. **Publish the security rules.** Still in Realtime Database, open the
   **Rules** tab, delete what is there, paste the whole of
   [`database.rules.json`](database.rules.json) and click **Publish**.
   Without this step, rooms can't be created ("the database refused it").

5. **Get your config.** Open **Settings › General** in the left menu (older
   consoles: the gear icon next to **Project Overview** › **Project
   settings**) and scroll down to **Your apps**. Click the web icon **`</>`**
   (or **Add app**, then Web), type a nickname (for example `Sequence`), leave Firebase Hosting
   unticked and click **Register app**. Firebase shows code like this:

   ```js
   const firebaseConfig = {
     apiKey: "AIzaSy...",
     authDomain: "sequence-game.firebaseapp.com",
     databaseURL: "https://sequence-game-default-rtdb.europe-west1.firebasedatabase.app",
     projectId: "sequence-game",
     storageBucket: "sequence-game.firebasestorage.app",
     messagingSenderId: "1234567890",
     appId: "1:1234567890:web:abc123def456"
   };
   ```

   You can find it again later under **Settings › General › Your apps › SDK
   setup and configuration › Config**. If `databaseURL` is missing, copy
   the database address from step 3.

6. **Put the config in the game.** Open
   [`js/firebase-config.js`](js/firebase-config.js) (on GitHub: open the file,
   click the pencil icon) and copy in the values, keeping the quotes:

   ```js
   window.SEQUENCE_FIREBASE_CONFIG = {
     apiKey: 'AIzaSy...',
     authDomain: 'sequence-game.firebaseapp.com',
     databaseURL: 'https://sequence-game-default-rtdb.europe-west1.firebasedatabase.app',
     projectId: 'sequence-game',
     appId: '1:1234567890:web:abc123def456'
   };
   ```

   `storageBucket` and `messagingSenderId` are not needed. Commit the change.
   A minute or two after it reaches `main`, the game shows the start page with
   **Online** in the top-right corner instead of "Almost ready".

7. **Recommended: let only your site use the key.** Open
   <https://console.cloud.google.com/apis/credentials>, choose the same
   project, and click the key called **Browser key (auto created by
   Firebase)**. Under **Application restrictions** choose **Websites**, add
   `https://umairzia.github.io/*` (and `http://localhost:8080/*` if you test
   on your computer), and save.

**Is it safe to put the config on GitHub?** Yes. These values are not
passwords: every visitor's browser has to receive them anyway, and they only
say which Firebase project to talk to. What protects the game is step 4 (the
rules) together with anonymous sign-in, and step 7 stops other websites from
using your key.

**Free plan limits:** 100 people connected at once, 1 GB stored and 10 GB
downloaded per month. A whole game is well under 1 MB of downloads, and a room
takes a few kilobytes, so friends playing will not come near these limits.
When the host taps **Leave room**, the room is deleted. Rooms that are simply
abandoned stay in the database; you can delete them on the **Data** tab
whenever you like.

## How it works

- **Rooms.** The host taps **Create a room** and gets a 4-letter code
  (letters only, no I or O so they can't be mistaken for 1 and 0). The friend
  joins with the code or the invite link (`.../Sequence-game/#ABCD`).
- **One game state.** Each room has one game-state object
  (`rooms/CODE/state`): board, sequences, whose turn, the last move, a short
  log and a version number. Both browsers listen to it and redraw whenever it
  changes.
- **The host is in charge.** Only the host's browser writes the game state.
  It deals the cards, plays the bots' turns and applies its own moves. The
  guest's browser writes just one thing: a request for its own move
  (`rooms/CODE/req`), which the host checks and applies. So there is only one
  writer and the two screens can't disagree. Every update must carry the next
  version number (the rules refuse anything else), so even two open tabs of
  the host can't play the same bot move twice.
- **Hands stay private.** Each hand is stored under its own key
  (`hands/CODE/host`, `hands/CODE/guest`) and the rules let only its owner
  read it. The draw pile, the discard pile and the bots' hands
  (`secret/CODE`) can be read only by the host's browser. The deck is never
  sent to the guest. The host deals the guest's new card into the empty slot
  without reading the guest's hand: the rules themselves check that a card the
  guest plays is really in that slot.
- **Refresh and reconnect.** The browser remembers its anonymous account.
  Opening the room again (refresh, the same link, **Continue room** on the
  start page, or typing the code in Join) puts the player back in the same
  seat with the same cards. If someone changes phone or browser, the host
  sees **Free their seat**; after that the player joins again with the code
  and gets the same cards back.
- **Presence.** Each player's browser marks itself online in
  `rooms/CODE/presence`, and Firebase marks it offline by itself when the
  connection drops.

### What the database rules allow

- Only signed-in (anonymous) players can read or write anything.
- A room code can be created once; whoever creates it is the host.
- The guest seat can be taken only while it is empty. From then on, only the
  host and that guest can read the room or write to it. Others can see the
  names of the players in a room (so a joiner can tell if it is full), nothing
  else. Nobody can list the rooms.
- Only the host writes the game state, the hands, the deck and the bots'
  hands, and each game-state update must be exactly one version newer.
- The guest can write only its own move request, only on its turn, only for
  the current version, and only with a card that is in its hand. It can set
  its own presence and leave its seat.
- Only the host can close (delete) a room.

These rules are tested against Google's official database emulator
(`tests/sequence-rules.test.js`).

### Limits

- There is no server of our own, so the host's browser is the dealer: the
  order of the deck is in the host's browser. The rules keep it from the guest
  and from everyone else, but a host who digs into the browser's developer
  tools could peek at it. You are on the same team, so this only matters if
  you want to cheat yourselves.
- The bots play on the host's device. If the host goes offline or the phone
  falls asleep, the game waits; the guest is told why.
- A seat belongs to the browser it was taken in. Private (incognito) windows
  forget it when they are closed.
- Online play needs iOS 11.3 or later, or a current Chrome, Edge, Firefox or
  Safari. The game's own code is plain ES5 (a test checks this), so the
  Firebase SDK sets the minimum.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| "Almost ready" page | `js/firebase-config.js` is still empty; see step 6. |
| "Could not connect … Anonymous sign-in" | Turn on Anonymous sign-in (step 2). |
| "The database refused it" when creating a room | Publish the rules (step 4). |
| "Cannot reach Firebase" | Check the internet connection, then `databaseURL` in the config. |
| "Room … already has two players" | The seat is taken. If it is your seat on a new phone, ask the host to tap **Free their seat**. |
| The bots don't move | The host's phone is offline or asleep. Wake it up and open the game. |

## Files

```
index.html            the page
css/sequence.css      card-table look; phones and wide screens
js/engine.js          rules: board, cards, moves, sequences, turns
js/ai.js              the bots
js/host.js            the host's authority: dealing, applying moves
js/net.js             Firebase: sign-in, listeners, writes, presence
js/game.js            rooms, lobby, drawing the board, the host's loop
js/firebase-config.js your Firebase project's settings
database.rules.json   database security rules (paste into Firebase)
firebase.json         for the Firebase CLI, if you use it
vendor/firebase/      Firebase JS SDK 11.10.0 compat builds (Apache-2.0)
tests/                unit, browser and Firebase tests, small static server
```

If you use the [Firebase CLI](https://firebase.google.com/docs/cli), you can
publish the rules from this folder with
`firebase deploy --only database --project <your-project-id>` instead of
pasting them.

## Development

```bash
npm install            # only needed for the tests
npm start              # serves the game at http://localhost:8080
npm test               # unit tests: rules of the game, bots, host logic
npm run test:e2e       # browser tests: two players in two browsers, with a fake Firebase
npm run test:all       # both
npm run test:firebase  # database rules and the real Firebase SDK against the
                       # official emulator (needs Java 11+; downloads it once)
```

## License

Game code: MIT (see [`LICENSE`](LICENSE)). Firebase JS SDK: Apache-2.0 (see
[`vendor/firebase/LICENSE`](vendor/firebase/LICENSE)).
