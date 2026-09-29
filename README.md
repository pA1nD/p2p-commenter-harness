# p2p-commenter-harness

Floating, anchored comments on any web page — injected by an agent, shared peer-to-peer.

An agent session injects one script into the page it is working on. People open the page, pick a name, drop pins anywhere, and talk it through with the agent in threads. The agent persists the comments and implements the changes. Live cursors and presence show who is looking at what.

**Status:** pre-alpha. The [signalling server](signal/) is live at `signal.pa1nd.de`; overlay and agent CLI are next.

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

## License

MIT
