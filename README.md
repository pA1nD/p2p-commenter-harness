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
npx p2p-commenter-harness up --name Claude
```

```
script:  <script src="http://127.0.0.1:51850/overlay.js" onerror="…falls back to https://signal.pa1nd.de/overlay.js…" async></script>
mode:    local — this machine only, no internet needed · `commenter share` or the page's Share button lets others in
[status] ready on 127.0.0.1:51850 · 0 comments on file
[join] Ana
[comment] #1 Ana on / @ section.hero > h1: Headline too long for mobile
[todo] #1 on / @ section.hero > h1 (asked by Ana): Ana: Headline too long for mobile | Claude: Shorten to 'Gold Treasury' on mobile? | Ana: Yes, do it
[todo] e1 on / @ section.hero > p (asked by Ana): change "…held in your name…" → "…yours…"
```

1. Put the printed `<script>` tag in the page. The port is fixed per project (`.commenter/local.json`), so the tag keeps working.
2. Open the page. Pick a name, then comment (`C`) or edit copy in place (`E`).
3. Answer from the agent session (commands below).

### Local first

By default nothing leaves the machine: the page talks to `commenter up` over `127.0.0.1`, and every comment lands in `.commenter/comments.jsonl` as you type it. Works on a plane — the agent picks up the `[todo]`s (`commenter todo`) whenever it can think again.

Only pages on this machine can connect (`localhost`, `127.0.0.1`, `*.localhost`, `file://`); allow others with `--allow-origin https://preview.example.com`.

### Sharing

Sharing is off until someone turns it on:

- the agent: `commenter share --url https://preview.example.com/` (or `up --shared`); `commenter unshare` turns it off
- you, in the page: **Share** — switches sharing on and copies `page-url#cmt=<room>`

Then the hub also joins a room on the signalling server, and visitors elsewhere connect over WebRTC — the same tag loads the hosted overlay for them. The page itself has to be reachable for them (a public preview, not `localhost`). The room is online while `commenter up` runs; when it stops, visitors see **agent offline**.

### Comment vs. ask

Commenting is a conversation — people can discuss a thread before anyone wants action. **Ask agent** hands it over:

- in the composer or a reply (**✦ Ask agent**, or `⇧⌘↵`) — comment and ask in one go
- on an existing thread (**Ask agent** in its header) — after the discussion settled
- on a copy edit: `⌘↵` instead of `↵` saves and asks; or **Ask agent** in the edit's popover

Copy edits change the text live for everyone, but for the agent they are just requests: *where*, *from what*, *to what*.

The agent's lines say which is which — `[todo]` means act, `[comment]` / `[edit]` are for information (it may still reply). Everyone sees the state live: **Asked agent → Agent working → Agent done**.

```
commenter todo                   # what's been asked of the agent
commenter start 1                # "Agent working" on thread #1
commenter done 1 "Shortened to 'Gold Treasury' below 600px"   # note lands in the thread
commenter done e1                # edit applied
commenter threads                # everything open, with state
commenter reply 1 "Which breakpoint?"
commenter resolve 1
```

Everything lands in `.commenter/comments.jsonl` (append-only; keep it in git if you like). `room.json` holds the sharing owner key and is git-ignored. Run `up` in the background and the agent wakes on each printed line.

## Layout

- `overlay/overlay.js` — the injected script (served from the signalling Worker as `/overlay.js`)
- `lib/hub.js` — the agent end: local WebSocket + (when shared) WebRTC hub, presence relay, the comment API
- `lib/store.js` — the JSONL log
- `bin/commenter.js` — the CLI
- `signal/` — the signalling Worker ([protocol](signal/README.md))
- `examples/demo/` — a page to try it on

The overlay's UI, anchoring and interaction model come from the original atelier `commenter` module; only the transport and storage changed.

## License

MIT
