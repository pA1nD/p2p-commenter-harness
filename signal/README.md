# signal

The signalling Worker. One Durable Object per room introduces peers to the room's agent and relays SDP/ICE between them (star topology — the agent is the hub). Comments, cursors and presence never pass through it.

Live instance: `https://signal.pa1nd.de`

## Protocol

`POST /rooms` → `201 {room, ownerKey, ws}` — room is 128-bit random, ownerKey proves the agent.

WebSocket `/rooms/<room>?role=agent&key=<ownerKey>` or `/rooms/<room>?role=peer&name=<name>`

| Server → client | |
|---|---|
| `welcome {you, role, agentOnline, peers?, iceServers}` | on connect; `peers` for the agent only; `iceServers` carry short-lived TURN credentials (2 h) |
| `peer-join {peer:{id,name}}` / `peer-leave {peer}` | to the agent |
| `agent-online` / `agent-offline` | to peers |
| `signal {from, data}` | relayed SDP/ICE |
| `ice {iceServers}` | reply to `{type:"ice"}` — fresh credentials |

Client → server: `{type:"signal", to, data}` (peers can only reach `agent`) and `{type:"ice"}`.

Close codes: `4401` bad owner key · `4404` no such room · `4409` room full (50 peers) · `4000` agent replaced · `4410` room expired (30 days without the agent).

## Deploy your own

```
npm i
npx wrangler deploy                       # edit account_id + route in wrangler.toml first
npx wrangler secret put TURN_TOKEN_ID     # Cloudflare Realtime → TURN Server → Create
npx wrangler secret put TURN_API_TOKEN
```

Without the TURN secrets, peers get STUN only (direct connections, no relay fallback).

## Test

```
node test/signal.mjs https://signal.example.com          # protocol end-to-end
node test/turn.mjs   https://signal.example.com relay    # real WebRTC data channel, forced through TURN
```
