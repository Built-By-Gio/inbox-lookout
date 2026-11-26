# Inbox Lookout

Inbox Lookout is a Chrome extension (Manifest V3) that keeps an eye on Gmail's unread mail so you don't have to open your inbox. Every 5 minutes it reads the newest unread emails and sorts them into Needs you, FYI and Trash, with a short reason for each. It uses Chrome's on-device language model when one is available and falls back to built-in rules when it is not. It learns from your clicks ("Got it", "Not needed", "This matters") and never changes anything in Gmail.

Built by Gio ([Built-By-Gio](https://github.com/Built-By-Gio)).

## Status (2026-11-25)

- The logic tests pass: `node --test` runs 20 tests, 20 pass, 0 fail. They cover feed parsing, the fallback rules, the learning scores, and the background worker running against a stand-in for Chrome's extension API.
- A dry run of the sorting logic was done.
- It has been loaded as an unpacked extension in Chrome and works.
- Not built yet: a control to forget what it has learned, and a privacy policy.

## What data it touches and where it stays

This is what the code does:

- **Permissions** (`manifest.json`): `alarms` (the 5-minute check), `storage`, `notifications`, `offscreen` (a hidden page, because Chrome only offers its on-device model to pages, not to the background worker) and `background` (lets Chrome keep running in the background so checks continue). Host permission: `https://mail.google.com/*` only.
- **What it reads:** Gmail's Atom feeds at `https://mail.google.com/mail/u/0/feed/atom` (the inbox plus the Primary, Important, Receipts, Social and Promotions views), using the Gmail sign-in already in your browser. Only the first signed-in account (`u/0`) is read. Each feed lists only the newest unread mail. The requests only read; nothing is marked, moved or deleted.
- **What it stores:** in `chrome.storage.local` (not synced): for each unread email, the sender name and address, subject, the short preview Gmail includes in the feed, the Gmail link, the time and which feeds it was in; plus the call and reason it gave. It also stores what it learned: a score per sender address and per subject word, and up to 8 of your recent corrections. Emails are dropped once they are no longer in the unread feeds and are older than 30 days (3 days for Trash). Learned scores stay until the extension is removed.
- **Where email text goes:** the sender, subject, preview and Gmail category are passed to Chrome's built-in Prompt API (`LanguageModel`) in the hidden page. Apart from the Gmail feed requests above, the extension's code makes no network requests: no analytics and no remote scripts (anime.js is loaded from the local `vendor` folder). Opening an email opens a Gmail tab, and links that do not point to Gmail are replaced with Gmail's home page.

## What you need

- Google Chrome on a desktop, signed in to Gmail in the same browser profile.
- For model-based sorting: Chrome's built-in on-device model (the Prompt API) available on your machine. Without it the extension still works using its fallback rules, and the popup footer shows "AI on this PC: off".
- To run the tests: Node.js with the built-in test runner (tested with Node 26). There are no dependencies and no build step.
- The popup's fonts (Franklin Gothic Medium, Bahnschrift, Candara) ship with Windows; other systems fall back to a default font.

Still to add: the minimum Chrome version that works.

## How to load it

1. Download or clone this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the `inbox-lookout` folder (the one that contains `manifest.json`).
5. Pin Inbox Lookout to the toolbar and click it. The first check starts right away; after that it checks every 5 minutes. The badge shows how many emails need you.

To run the tests, open a terminal in the folder and run:

```
node --test
```

## Repo layout

```
manifest.json        extension manifest (permissions, background worker, popup)
background.js        background worker: 5-minute check, sorting, badge, notifications, learning from clicks
feed.js              reads and parses Gmail's Atom feeds
judge.js             fallback rules and the on-device model prompt
learn.js             per-sender and per-word scores learned from clicks
offscreen.html/.js   hidden page that calls the on-device model
popup.html/.css/.js  the toolbar popup
icons/               extension icons and their SVG sources
vendor/anime.min.js  anime.js, used for the popup's animations
test/                Node tests (node --test)
```

## Roadmap

- A "forget what it learned" control.
- A privacy policy before any Chrome Web Store listing.

## Credits and license

- [anime.js](https://animejs.com) v3.2.2 by Julian Garnier, MIT license. The copy in `vendor/` keeps its license header.
- Inbox Lookout is released under the MIT License. See `LICENSE`.
