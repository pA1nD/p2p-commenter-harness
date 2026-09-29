# p2p-commenter-harness

Floating, anchored comments on any web page — injected by an agent, shared peer-to-peer.

An agent session injects one script into the page it is working on. People open the page, pick a name, drop pins anywhere, and talk it through with the agent in threads. The agent persists the comments and implements the changes. Live cursors and presence show who is looking at what.

**Status:** alpha — works end to end (comments, replies, resolve, suggested copy edits, live cursors, share links).

## Shape

```
        signalling (Cloudflare Worker + Durable Object per room)
         ╱          │           ╲
   handshake only — then direct, encrypted WebRTC
 agent session ◄══════ browser (overlay)
      ║  hub  ◄══════ browser (overlay)
      ╚═════► comments.jsonl   (the agent owns the data)
```

- **overlay** — one script, Shadow DOM. Pins anchor via CSS selector → XPath → tag + text → text quote, so they survive DOM changes. Asks visitors for a name. Share button copies `page-url#cmt=<room>`.
- **signalling** — exchanges SDP/ICE for a random 128-bit room id. Stores nothing. Mints short-lived TURN credentials for peers that can't connect directly.
- **agent CLI (`commenter`)** — `commenter up` joins as the hub, appends every event to `comments.jsonl`, prints one line per new comment; `commenter share`, `commenter threads`, `commenter reply`, `commenter resolve`.

No proxying, no page hosting, no persistence on the server. The room is online as long as the agent is.

## Use it (agent side)

```
npx p2p-commenter-harness up --url http://localhost:3000/ --name Claude
```

It prints a script tag and a share link, then one line per event:

```
script:  <script src="https://signal.pa1nd.de/overlay.js" data-room="E05BG_sHSrXcL3sCdRu7OA" async></script>
share:   http://localhost:3000/#cmt=E05BG_sHSrXcL3sCdRu7OA
[status] online · room E05BG_sHSrXcL3sCdRu7OA · 0 comments on file
[join] Ana
[comment] #1 Ana on / @ section.hero > h1: Headline too long for mobile
```

1. Add `<script src="https://signal.pa1nd.de/overlay.js" async></script>` to the page (with `data-room` if every visitor of that page should join; without it, only people with the `#cmt=` link do).
2. Open the share link, or hand it to someone. Visitors pick a name, then comment (`C`), suggest copy edits (`E`), and share the link themselves (**Share**).
3. Answer from the agent session:

```
commenter threads              # open threads + suggested edits
commenter reply 1 "Shortened to 'Gold Treasury' on mobile — ok?"
commenter resolve 1
```

Everything lands in `.commenter/comments.jsonl` (append-only; keep it in git if you like). `room.json` holds the owner key and is git-ignored. Run `up` in the background and the agent wakes on each printed line.

The room is online while `commenter up` runs. When it stops, visitors see **agent offline**.

## Layout

- `overlay/overlay.js` — the injected script (served from the signalling Worker as `/overlay.js`)
- `lib/hub.js` — the agent end: WebRTC hub, presence relay, the comment API
- `lib/store.js` — the JSONL log
- `bin/commenter.js` — the CLI
- `signal/` — the signalling Worker ([protocol](signal/README.md))
- `examples/demo/` — a page to try it on

The overlay's UI, anchoring and interaction model come from the original atelier `commenter` module; only the transport and storage changed.

## License

MIT
