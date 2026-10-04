// The agent end of a review. Visitors connect two ways:
//   local  — a WebSocket from a page on this machine (default; works offline)
//   shared — WebRTC data channels via the signalling server (only once sharing
//            is switched on, by the agent or by a local visitor's Share button)
// Either way the hub relays presence between them, answers their API calls
// from the Store, and reports every comment/edit/status change via `onEvent`.
//
// Frame and API semantics are ported from the original commenter edge.js;
// only the transport changed.

import { RTCPeerConnection } from "werift";

const CHUNK = 16000;
const ICE_REFRESH_MS = 90 * 60 * 1000; // signalling mints 2 h credentials

function hashColor(s) {
  const COLORS = ["oklch(0.62 0.16 250)", "oklch(0.65 0.16 145)", "oklch(0.72 0.17 80)", "oklch(0.62 0.18 30)", "oklch(0.6 0.18 305)", "oklch(0.7 0.14 200)"];
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return COLORS[((h % COLORS.length) + COLORS.length) % COLORS.length];
}

// werift wants one url per entry and handles plain turn:/stun: best.
const iceConfig = (servers) =>
  (servers || [])
    .flatMap((s) => [].concat(s.urls).map((u) => ({ urls: u, username: s.username, credential: s.credential })))
    .filter((s) => (s.urls.startsWith("turn:") ? s.urls.includes("transport=udp") : !s.urls.startsWith("turns:")));

const newPeerId = () => Math.random().toString(36).slice(2, 12);

// Limits on what one peer can make the hub hold or chew on.
const MAX_CHUNKS = 1000; // pieces per message (16 MB at CHUNK size)
const MAX_BUFFERED = 8 << 20; // bytes of unfinished chunked messages per peer
const MAX_OPEN_CHUNKED = 16; // unfinished chunked messages per peer

// Peer-supplied values that end up in other people's browsers.
const COLOR_RE = /^(#[0-9a-f]{3,8}|(oklch|oklab|hsl|hsla|rgb|rgba)\([0-9.%\s,\/-]+\))$/i;
const PATH_RE = /^\/(?![\/\\])/; // same-origin path, not //host or /\host
const str = (v, n) => (typeof v === "string" && v ? v.slice(0, n) : null);
const pagePath = (v) => (typeof v === "string" && PATH_RE.test(v) ? v.slice(0, 500) : "/");

export class Hub {
  constructor({ store, agentName = "Agent", onEvent = () => {}, onStatus = () => {}, onShareRequest = async () => null }) {
    Object.assign(this, { store, onEvent, onStatus, onShareRequest });
    this.agent = { clientId: "agent", name: agentName, email: null, color: "oklch(0.55 0.02 260)" };
    this.peers = new Map(); // peerId → { kind: "local"|"rtc", sock | pc+dc, participant, chunks }
    this.sharing = null; // { signal, room, ownerKey } while shared
    this.iceServers = null;
    this.retry = 0;
  }

  /* ── local visitors ── */

  attachLocal(sock) {
    const peerId = newPeerId();
    const entry = { kind: "local", sock, participant: null, chunks: new Map(), buffered: 0 };
    this.peers.set(peerId, entry);
    sock.on("message", (raw) => this.onFrame(peerId, entry, String(raw)));
    sock.on("close", () => this.dropPeer(peerId));
    sock.on("error", () => this.dropPeer(peerId));
  }

  /* ── sharing: signalling + WebRTC ── */

  startSharing({ signal, room, ownerKey }) {
    this.stopSharing();
    this.sharing = { signal, room, ownerKey };
    this.retry = 0;
    this.connectSignal();
  }

  stopSharing() {
    const was = this.sharing;
    this.sharing = null;
    clearInterval(this.iceTimer);
    for (const [id, entry] of this.peers) if (entry.kind === "rtc") this.dropPeer(id);
    try {
      this.ws?.close();
    } catch {}
    this.ws = null;
    return !!was;
  }

  stop() {
    this.stopSharing();
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
  }

  connectSignal() {
    const { signal, room, ownerKey } = this.sharing;
    const ws = (this.ws = new WebSocket(`${signal.replace(/^http/, "ws")}/rooms/${room}?role=agent&key=${ownerKey}`));
    ws.onmessage = (ev) => this.onSignal(JSON.parse(ev.data));
    ws.onclose = (ev) => {
      if (this.ws !== ws || !this.sharing) return;
      clearInterval(this.iceTimer);
      if (ev.code === 4404 || ev.code === 4410 || ev.code === 4401) return this.onStatus({ type: "room-gone", code: ev.code });
      if (ev.code === 4000) return this.onStatus({ type: "replaced" });
      this.onStatus({ type: "reconnecting" });
      setTimeout(() => this.sharing && this.ws === ws && this.connectSignal(), Math.min(8000, 500 * 2 ** this.retry++));
    };
  }

  async onSignal(m) {
    if (m.type === "welcome") {
      this.retry = 0;
      this.iceServers = m.iceServers;
      clearInterval(this.iceTimer);
      this.iceTimer = setInterval(() => this.ws?.send(JSON.stringify({ type: "ice" })), ICE_REFRESH_MS);
      this.onStatus({ type: "shared-online" });
    } else if (m.type === "ice") {
      this.iceServers = m.iceServers;
    } else if (m.type === "peer-leave") {
      this.dropPeer(m.peer);
    } else if (m.type === "signal" && m.data?.sdp?.type === "offer" && typeof m.data.sdp.sdp === "string") {
      try {
        await this.answer(m.from, m.data.sdp);
      } catch {
        this.dropPeer(m.from); // malformed offer — ignore that peer, keep serving the rest
      }
    } else if (m.type === "signal" && m.data?.candidate) {
      const entry = this.peers.get(m.from);
      if (!entry) return;
      if (entry.answered) Promise.resolve().then(() => entry.pc.addIceCandidate(m.data.candidate)).catch(() => {});
      else if (entry.pendingCandidates.length < 64) entry.pendingCandidates.push(m.data.candidate);
    }
  }

  async answer(peerId, offer) {
    this.dropPeer(peerId);
    const pc = new RTCPeerConnection({ iceServers: iceConfig(this.iceServers) });
    const entry = { kind: "rtc", pc, dc: null, participant: null, chunks: new Map(), buffered: 0, pendingCandidates: [], answered: false };
    this.peers.set(peerId, entry);

    pc.onDataChannel.subscribe((dc) => {
      entry.dc = dc;
      dc.onMessage.subscribe((raw) => this.onFrame(peerId, entry, String(raw)));
      dc.stateChanged.subscribe((s) => s === "closed" && this.dropPeer(peerId));
    });
    pc.connectionStateChange.subscribe((s) => (s === "failed" || s === "closed") && this.dropPeer(peerId));

    // Trickle ICE both ways: answer at once, candidates follow as found.
    const signal = (data) => this.ws?.send(JSON.stringify({ type: "signal", to: peerId, data }));
    const outbox = [];
    pc.onIceCandidate.subscribe((c) => {
      if (!c || this.peers.get(peerId) !== entry) return;
      if (entry.answered) signal({ candidate: c.toJSON() });
      else outbox.push(c.toJSON());
    });
    await pc.setRemoteDescription(offer);
    await pc.setLocalDescription(await pc.createAnswer());
    if (this.peers.get(peerId) !== entry) return;
    signal({ sdp: pc.localDescription });
    entry.answered = true;
    for (const c of outbox.splice(0)) signal({ candidate: c });
    for (const c of entry.pendingCandidates.splice(0)) Promise.resolve().then(() => entry.pc.addIceCandidate(c)).catch(() => {});
  }

  dropPeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    this.peers.delete(peerId);
    try {
      if (entry.kind === "rtc") entry.pc.close();
      else entry.sock.close();
    } catch {}
    if (entry.participant) {
      this.onEvent({ type: "leave", name: entry.participant.name || "someone" });
      this.emitRoster();
    }
  }

  /* ── wire ── */

  send(entry, frame) {
    const open = entry.kind === "rtc" ? entry.dc?.readyState === "open" : entry.sock.readyState === 1;
    if (!open) return;
    const raw = (x) => (entry.kind === "rtc" ? entry.dc.send(x) : entry.sock.send(x));
    const s = JSON.stringify(frame);
    try {
      if (s.length <= CHUNK) return raw(s);
      const id = Math.random().toString(36).slice(2);
      const n = Math.ceil(s.length / CHUNK);
      for (let i = 0; i < n; i++) raw(JSON.stringify({ t: "chunk", id, i, n, d: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
    } catch {}
  }

  broadcast(frame, exceptPeerId = null) {
    for (const [id, entry] of this.peers) if (id !== exceptPeerId && entry.participant) this.send(entry, frame);
  }

  roster() {
    const out = [{ ...this.agent, page: null, scroll: { x: 0, y: 0 }, scrollFrac: null, scrollAnchor: null, viewport: { w: 0, h: 0 }, cursor: null, editing: null }];
    for (const { participant: p } of this.peers.values()) {
      if (!p) continue;
      out.push({
        clientId: p.clientId, name: p.name, email: p.email, color: p.color,
        page: p.page, scroll: p.scroll, scrollFrac: p.scrollFrac ?? null, scrollAnchor: p.scrollAnchor || null,
        viewport: p.viewport, cursor: p.cursor, editing: p.editing || null,
      });
    }
    return out;
  }

  emitRoster() {
    this.broadcast({ t: "roster", roster: this.roster() });
  }

  onFrame(peerId, entry, raw) {
    let f;
    try {
      f = JSON.parse(raw);
    } catch {
      return;
    }
    if (!f || typeof f !== "object") return;
    if (f.t === "chunk") {
      const ok = typeof f.id === "string" && Number.isInteger(f.n) && f.n >= 1 && f.n <= MAX_CHUNKS && Number.isInteger(f.i) && f.i >= 0 && f.i < f.n && typeof f.d === "string";
      if (!ok) return;
      let rec = entry.chunks.get(f.id);
      if (!rec) {
        if (entry.chunks.size >= MAX_OPEN_CHUNKED) return this.dropPeer(peerId);
        rec = { n: f.n, parts: new Array(f.n), got: 0 };
        entry.chunks.set(f.id, rec);
      }
      if (rec.n !== f.n || rec.parts[f.i] != null) return;
      rec.parts[f.i] = f.d;
      rec.got++;
      entry.buffered += f.d.length;
      if (entry.buffered > MAX_BUFFERED) return this.dropPeer(peerId);
      if (rec.got < rec.n) return;
      entry.chunks.delete(f.id);
      entry.buffered -= rec.parts.reduce((sum, d) => sum + d.length, 0);
      try {
        f = JSON.parse(rec.parts.join(""));
      } catch {
        return;
      }
      if (!f || typeof f !== "object") return;
    }

    if (f.t === "hello") {
      // "agent" is the hub's own identity — a visitor can't claim it.
      const asked = str(f.clientId, 80);
      const clientId = asked && asked !== "agent" ? asked : `peer-${peerId}`;
      entry.participant = {
        clientId, name: null, email: null, color: hashColor(clientId),
        page: "/", scroll: { x: 0, y: 0 }, viewport: { w: 0, h: 0 }, cursor: null, editing: null,
      };
      this.send(entry, { t: "welcome", clientId, color: entry.participant.color, roster: this.roster() });
      this.emitRoster();
      return;
    }
    const p = entry.participant;
    if (!p) return;

    if (f.t === "rpc") {
      return Promise.resolve()
        .then(() => this.rpc(f, p, entry))
        .catch((e) => ({ status: 500, body: { error: String(e.message || e) } }))
        .then((result) => this.send(entry, { t: "rpc_result", id: f.id, ...result }));
    }

    switch (f.t) {
      case "identify": {
        const wasNamed = !!p.name;
        if ("name" in f) p.name = str(f.name, 80);
        if ("email" in f) p.email = str(f.email, 200);
        if (typeof f.color === "string" && f.color.length <= 80 && COLOR_RE.test(f.color)) p.color = f.color;
        if (p.name && !wasNamed) this.onEvent({ type: "join", name: p.name, email: p.email });
        this.emitRoster();
        break;
      }
      case "presence": {
        if (f.page) p.page = pagePath(f.page);
        if (f.scroll) p.scroll = { x: +f.scroll.x || 0, y: +f.scroll.y || 0 };
        if (typeof f.scrollFrac === "number") p.scrollFrac = Math.max(0, Math.min(1, +f.scrollFrac || 0));
        if (f.viewport) p.viewport = { w: +f.viewport.w || 0, h: +f.viewport.h || 0 };
        if (f.cursor !== undefined) {
          p.cursor = f.cursor
            ? { sel: f.cursor.sel ? String(f.cursor.sel).slice(0, 600) : null, fx: +f.cursor.fx || 0, fy: +f.cursor.fy || 0, pageX: +f.cursor.pageX || 0, pageY: +f.cursor.pageY || 0 }
            : null;
        }
        if (f.scrollAnchor !== undefined) {
          p.scrollAnchor = f.scrollAnchor ? { sel: f.scrollAnchor.sel ? String(f.scrollAnchor.sel).slice(0, 600) : null, oy: +f.scrollAnchor.oy || 0 } : null;
        }
        const sig = JSON.stringify([p.page, p.scroll, p.scrollFrac, p.scrollAnchor, p.viewport, p.cursor]);
        if (sig === p.lastPresenceSig) break;
        p.lastPresenceSig = sig;
        this.broadcast(
          { t: "presence", clientId: p.clientId, page: p.page, scroll: p.scroll, scrollFrac: p.scrollFrac ?? null, scrollAnchor: p.scrollAnchor || null, viewport: p.viewport, cursor: p.cursor },
          peerId,
        );
        break;
      }
      case "edit_inflight":
        p.editing = f.anchor ? { anchor: f.anchor, currentText: String(f.currentText || "").slice(0, 10000) } : null;
        this.broadcast({ t: "edit_inflight", clientId: p.clientId, anchor: f.anchor || null, currentText: p.editing?.currentText || "" }, peerId);
        break;
      case "cursor_blur":
        p.editing = null;
        this.broadcast({ t: "edit_inflight", clientId: p.clientId, anchor: null, currentText: "" }, peerId);
        break;
      case "sync_roster":
        this.send(entry, { t: "roster", roster: this.roster() });
        break;
    }
  }

  /* ── API (the old /__c/api/*) ── */

  rpc({ method, path, body }, p, entry) {
    const url = new URL(path, "http://x");
    const route = url.pathname.replace(/^\/__c\/api/, "");
    const author = { clientId: p.clientId, name: str(body?.name, 80) ?? p.name, email: str(body?.email, 200) ?? p.email };
    const page = pagePath(body?.page);
    const S = this.store;

    if (method === "GET" && route === "/snapshot") return { status: 200, body: { comments: S.comments, edits: S.edits } };

    if (method === "GET" && route === "/edits/history") {
      const pg = pagePath(url.searchParams.get("page"));
      const anchor = url.searchParams.get("anchor");
      if (!anchor) return { status: 400, body: { error: "missing anchor" } };
      return { status: 200, body: { edits: S.edits.filter((e) => e.page_path === pg && e.anchor_json === anchor) } };
    }

    if (method !== "POST") return { status: 404, body: { error: "unknown" } };

    // Only someone on this machine can switch sharing on from the page.
    if (route === "/share") {
      if (entry.kind !== "local") return { status: 403, body: { error: "only local visitors can share" } };
      return this.onShareRequest(p, body?.url).then((r) => ({ status: 200, body: r }));
    }

    if (route === "/comments") {
      const { anchor, comment, ask } = body || {};
      if (!comment || !anchor) return { status: 400, body: { error: "missing fields" } };
      if (!anchor.offset || typeof anchor.offset.fx !== "number" || typeof anchor.offset.fy !== "number") return { status: 400, body: { error: "anchor missing offset" } };
      const anchorJson = JSON.stringify(anchor);
      // Commented and asked in one go → the agent gets a single [todo], not a [comment] too.
      const created = this.postComment({ page, anchorJson, body: comment, author }, { quiet: !!ask });
      const event = ask ? this.setAsk({ kind: "comment", page, anchorJson, state: "asked", author }) : undefined;
      return { status: 200, body: { comment: created, event } };
    }

    if (route === "/comments/ask" || route === "/edits/ask") {
      if (!body?.anchor) return { status: 400, body: { error: "missing fields" } };
      const kind = route.startsWith("/edits") ? "edit" : "comment";
      const event = this.setAsk({ kind, page, anchorJson: JSON.stringify(body.anchor), state: "asked", author });
      return { status: 200, body: { event } };
    }

    if (route === "/comments/delete") {
      const c = S.comments.find((x) => x.id === body?.commentId && !x.event);
      if (!c) return { status: 404, body: { error: "comment not found" } };
      if (c.author_client_id !== p.clientId) return { status: 403, body: { error: "only the author can delete a comment" } };
      S.deleteComment(c.id);
      this.broadcast({ t: "comment_deleted", anchor_json: c.anchor_json, page: c.page_path, commentId: c.id });
      this.onEvent({ type: "comment-deleted", id: c.id, by: author.name, byAgent: author.clientId === "agent" });
      return { status: 200, body: { commentId: c.id } };
    }

    if (route === "/comments/resolve" || route === "/comments/reopen") {
      if (!body?.anchor) return { status: 400, body: { error: "missing fields" } };
      const r = this.setThreadStatus({ page, anchorJson: JSON.stringify(body.anchor), resolve: route.endsWith("/resolve"), author });
      return { status: 200, body: r };
    }

    if (route === "/edits") {
      const { anchor, originalText, newText, ask } = body || {};
      if (!anchor || newText == null || originalText == null) return { status: 400, body: { error: "missing fields" } };
      const anchorJson = JSON.stringify(anchor);
      const created = S.addEdit({ page, anchorJson, originalText, newText, author });
      this.broadcast({ t: "edit_committed", edit: created });
      if (!ask) this.onEvent({ type: "edit", edit: created });
      const event = ask ? this.setAsk({ kind: "edit", page, anchorJson, state: "asked", author }) : undefined;
      return { status: 200, body: { edit: created, event } };
    }

    if (route === "/edits/resolve" || route === "/edits/reopen") {
      if (!body?.anchor) return { status: 400, body: { error: "missing fields" } };
      const anchorJson = JSON.stringify(body.anchor);
      const status = route.endsWith("/resolve") ? "resolved" : "open";
      S.setEditStatus(page, anchorJson, status);
      const event = S.addEdit({ page, anchorJson, author, event: status === "resolved" ? "resolved" : "reopened" });
      const affected = S.edits.filter((e) => e.page_path === page && e.anchor_json === anchorJson);
      this.broadcast({ t: "edit_thread_status", anchor_json: anchorJson, page, edits: affected, event });
      this.onEvent({ type: `edit-${event.event}`, page, anchorJson, by: author.name, byAgent: author.clientId === "agent" });
      return { status: 200, body: { affected, event } };
    }

    return { status: 404, body: { error: "unknown" } };
  }

  /* ── shared by visitors (rpc) and the agent (CLI control) ── */

  postComment({ page, anchorJson, body, author }, { quiet = false } = {}) {
    const created = this.store.addComment({ page, anchorJson, body, author });
    this.broadcast({ t: "comment_added", comment: created });
    if (!quiet) this.onEvent({ type: "comment", comment: created });
    return created;
  }

  // Hand a thread / an edited element to the agent, or move it along:
  // asked → working → done. Kept as event rows, like resolved/reopened.
  setAsk({ kind, page, anchorJson, state, author }) {
    const S = this.store;
    let event;
    if (kind === "edit") {
      event = S.addEdit({ page, anchorJson, author, event: state });
      this.broadcast({ t: "edit_thread_status", anchor_json: anchorJson, page, edits: [], event });
    } else {
      event = S.addComment({ page, anchorJson, author, event: state });
      this.broadcast({ t: "comment_added", comment: event });
    }
    this.onEvent({ type: state === "asked" ? "todo" : `ask-${state}`, kind, page, anchorJson, by: author.name, byAgent: author.clientId === "agent" });
    return event;
  }

  setThreadStatus({ page, anchorJson, resolve, author }) {
    const S = this.store;
    S.setThreadStatus(page, anchorJson, resolve ? "resolved" : "open");
    const affected = S.thread(page, anchorJson);
    const event = S.addComment({ page, anchorJson, author, event: resolve ? "resolved" : "reopened" });
    this.broadcast({ t: "thread_status", anchor_json: anchorJson, comments: affected, event });
    this.onEvent({ type: `thread-${event.event}`, page, anchorJson, by: author.name, byAgent: author.clientId === "agent" });
    return { affected, event };
  }
}
