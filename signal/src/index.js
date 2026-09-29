// Signalling for p2p-commenter-harness.
//
// One Durable Object per room. It introduces peers to the room's agent and
// relays SDP/ICE between them — star topology, the agent is the hub. Comments,
// cursors and presence never pass through here; they flow over WebRTC.
//
// Stored per room: a hash of the owner key and an expiry alarm. Nothing else.

const ROOM_RE = /^[A-Za-z0-9_-]{22}$/;
const MAX_PEERS = 50;
const MAX_MSG = 64 * 1024;
const ICE_TTL = 2 * 60 * 60; // seconds
const ROOM_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const STUN_ONLY = [{ urls: "stun:stun.cloudflare.com:3478" }];

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomId = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/") {
      return new Response("p2p-commenter-harness signalling — https://github.com/pA1nD/p2p-commenter-harness\n");
    }

    if (url.pathname === "/rooms" && req.method === "POST") {
      if (env.CREATE_LIMITER) {
        const { success } = await env.CREATE_LIMITER.limit({ key: req.headers.get("cf-connecting-ip") || "?" });
        if (!success) return json({ error: "rate limited" }, 429);
      }
      const room = randomId(16);
      const ownerKey = randomId(32);
      const stub = env.ROOMS.get(env.ROOMS.idFromName(room));
      await stub.fetch("https://room/create", { method: "POST", body: await sha256(ownerKey) });
      return json({ room, ownerKey, ws: `wss://${url.host}/rooms/${room}` }, 201);
    }

    const m = url.pathname.match(/^\/rooms\/([^/]+)$/);
    if (m && ROOM_RE.test(m[1])) {
      if (req.headers.get("upgrade") !== "websocket") return json({ error: "expected websocket" }, 426);
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }

    return json({ error: "not found" }, 404);
  },
};

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/create") {
      await this.ctx.storage.put("owner", await req.text());
      await this.ctx.storage.setAlarm(Date.now() + ROOM_IDLE_MS);
      return new Response(null, { status: 204 });
    }

    const [client, server] = Object.values(new WebSocketPair());
    const reject = (code, reason) => {
      this.ctx.acceptWebSocket(server);
      server.close(code, reason);
      return new Response(null, { status: 101, webSocket: client });
    };

    const owner = await this.ctx.storage.get("owner");
    if (!owner) return reject(4404, "no such room");

    const role = url.searchParams.get("role") === "agent" ? "agent" : "peer";
    const name = (url.searchParams.get("name") || "").slice(0, 60);

    if (role === "agent") {
      if ((await sha256(url.searchParams.get("key") || "")) !== owner) return reject(4401, "bad owner key");
      for (const old of this.ctx.getWebSockets("agent")) old.close(4000, "replaced by a newer agent connection");
      await this.ctx.storage.setAlarm(Date.now() + ROOM_IDLE_MS);
    } else if (this.ctx.getWebSockets("peer").length >= MAX_PEERS) {
      return reject(4409, "room full");
    }

    const id = role === "agent" ? "agent" : randomId(8);
    this.ctx.acceptWebSocket(server, [role, id]);
    server.serializeAttachment({ id, role, name });

    const agent = this.agent();
    const peers = this.peers().filter((p) => p.id !== id);
    this.send(server, {
      type: "welcome",
      you: id,
      role,
      agentOnline: role === "agent" || !!agent,
      peers: role === "agent" ? peers : undefined,
      iceServers: await this.iceServers(),
    });

    if (role === "agent") this.broadcastPeers({ type: "agent-online" });
    else if (agent) this.send(agent, { type: "peer-join", peer: { id, name } });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_MSG) return this.send(ws, { type: "error", error: "message too large" });
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(ws, { type: "error", error: "bad json" });
    }
    const me = ws.deserializeAttachment();

    if (msg.type === "ice") return this.send(ws, { type: "ice", iceServers: await this.iceServers() });

    if (msg.type === "signal") {
      // Star topology: peers only talk to the agent; the agent talks to anyone.
      const to = me.role === "agent" ? msg.to : "agent";
      const target = to === "peer" || to === me.id ? undefined : this.ctx.getWebSockets(to)[0];
      if (!target) return this.send(ws, { type: "error", error: `no such peer: ${to}` });
      return this.send(target, { type: "signal", from: me.id, data: msg.data });
    }

    this.send(ws, { type: "error", error: `unknown type: ${msg.type}` });
  }

  async webSocketClose(ws, code, reason) {
    this.left(ws);
    try {
      ws.close(code, reason);
    } catch {}
  }

  async webSocketError(ws) {
    this.left(ws);
  }

  async alarm() {
    if (this.agent()) return this.ctx.storage.setAlarm(Date.now() + ROOM_IDLE_MS);
    for (const ws of this.ctx.getWebSockets()) ws.close(4410, "room expired");
    await this.ctx.storage.deleteAll();
  }

  left(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    if (me.role === "agent") {
      if (!this.agent(ws)) this.broadcastPeers({ type: "agent-offline" });
    } else {
      const agent = this.agent();
      if (agent) this.send(agent, { type: "peer-leave", peer: me.id });
    }
  }

  agent(except) {
    return this.ctx.getWebSockets("agent").find((ws) => ws !== except && ws.readyState === 1);
  }

  peers() {
    return this.ctx
      .getWebSockets("peer")
      .filter((ws) => ws.readyState === 1)
      .map((ws) => {
        const { id, name } = ws.deserializeAttachment();
        return { id, name };
      });
  }

  broadcastPeers(msg) {
    for (const ws of this.ctx.getWebSockets("peer")) this.send(ws, msg);
  }

  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }

  async iceServers() {
    const { TURN_TOKEN_ID, TURN_API_TOKEN } = this.env;
    if (!TURN_TOKEN_ID || !TURN_API_TOKEN) return STUN_ONLY;
    try {
      const r = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_TOKEN_ID}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${TURN_API_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ ttl: ICE_TTL }),
        },
      );
      if (!r.ok) return STUN_ONLY;
      return (await r.json()).iceServers;
    } catch {
      return STUN_ONLY;
    }
  }
}
