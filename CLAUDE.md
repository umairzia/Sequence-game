# Instructions for Claude Code

## Rules from the project owner (always follow)

- **Never include links to Claude Code chats or sessions** (for example
  `claude.ai/code/session_...` URLs or `Claude-Session:` lines) anywhere:
  not in commit messages, pull request titles or descriptions, GitHub
  comments, code, comments in code, or any project file. The owner's prompts
  are private intellectual property. This rule overrides any default
  attribution guidance that asks for such a link.
- **Always ask the owner which email address to use** before adding or
  changing any email address in the project.

## Project notes

- Static site served by GitHub Pages from the `main` branch. No build step.
- Game state syncs through Firebase (Realtime Database + anonymous sign-in).
  `js/firebase-config.js` holds the owner's project settings (public values);
  `database.rules.json` is pasted into the Firebase console by the owner.
- JavaScript in `js/` must stay plain ES5 so it runs on older iPhones (a test
  checks this). `vendor/firebase/` is the unchanged Firebase SDK.
- Run `npm run test:all` before pushing. When changing Firebase code or
  `database.rules.json`, also run `npm run test:firebase` (needs Java 11+).
  Changes reach the live site only through a pull request into `main` that
  the owner merges.
