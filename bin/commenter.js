#!/usr/bin/env node
// commenter — the agent's end of p2p-commenter-harness.
//
//   commenter up [--name <agent>] [--shared] [--json]           host the review; one line per event
//   commenter share [--url <page>] | unshare                      let others join (needs internet) / stop
//   commenter todo                                                what people asked the agent to do
//   commenter threads [--all]                                     open threads + edits (all with --all)
//   commenter start <id>                                          mark a todo as "agent working"
//   commenter done <id> [note…]                                   mark it done (note → reply in thread)
//   commenter reply <id> <text…>                                  reply in the thread of comment <id>
//   commenter resolve <id> | reopen <id>                          close / reopen that thread
//   commenter link [--url <page>]                                 script tag (+ share link when shared)
//
// Local by default: the page talks to `up` on 127.0.0.1 — no internet needed.
// Sharing (signalling + WebRTC) starts only via `share`, `up --shared`, or the
// page's Share button (only a page on this machine can press it).
//
// <id> is a comment number (#3 or 3) or an edit (e4). Output lines:
//   [todo]  someone asked the agent to act — the thread or edit follows
//   [comment] / [edit]   for information; people may still be discussing
//
// State lives in ./.commenter/ (override with --dir):
//   comments.jsonl   the review — append-only, yours to keep
//   local.json       the local port (stable, so the script tag keeps working)
//   room.json        room id + owner key for sharing (secret, git-ignored)
//   hub.json         pid + control token of the running `up` (git-ignored)

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Store } from "../lib/store.js";

const DEFAULT_SIGNAL = "https://signal.pa1nd.de";
const FIRST_PORT = 51850;
const OVERLAY = new URL("../overlay/overlay.js", import.meta.url);

// Only known flags are flags, so a reply like "--no-verify was needed" stays text.
// A bare "--" ends the options: everything after it is positional.
const VALUE_FLAGS = new Set(["dir", "name", "url", "signal", "allow-origin"]);
const BOOL_FLAGS = new Set(["shared", "json", "all"]);
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("--") ? argv.shift() : "help";
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--") {
    rest.push(...argv.slice(i + 1));
    break;
  }
  const k = a.startsWith("--") ? a.slice(2) : null;
  if (k && VALUE_FLAGS.has(k) && i + 1 < argv.length) flags[k] = argv[++i];
  else if (k && BOOL_FLAGS.has(k)) flags[k] = true;
  else rest.push(a);
}

const DIR = path.resolve(flags.dir || ".commenter");
const FILES = {
  log: path.join(DIR, "comments.jsonl"),
  room: path.join(DIR, "room.json"),
  local: path.join(DIR, "local.json"),
  hub: path.join(DIR, "hub.json"),
};
const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null);

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
  const ignore = path.join(DIR, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "room.json\nhub.json\n");
}

async function createRoom(signal) {
  const r = await fetch(`${signal}/rooms`, { method: "POST" });
  if (!r.ok) throw new Error(`signalling refused to create a room: HTTP ${r.status}`);
  const { room, ownerKey } = await r.json();
  const saved = { room, ownerKey, signal, created_at: new Date().toISOString() };
  fs.writeFileSync(FILES.room, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600 });
  return saved;
}

// One tag for both modes: the local hub if it's running on this machine,
// otherwise the hosted overlay (which joins a shared room via #cmt=).
function scriptTag(port, signal = DEFAULT_SIGNAL) {
  const fallback = `this.remove();var s=document.createElement('script');s.src='${signal}/overlay.js';document.head.appendChild(s)`;
  return `<script src="http://127.0.0.1:${port}/overlay.js" onerror="${fallback}" async></script>`;
}
const shareUrl = (room, url) => (url ? `${url.replace(/#.*$/, "")}#cmt=${room}` : `<page-url>#cmt=${room}`);

// Loopback pages only, unless the agent allows more with --allow-origin.
function originAllowed(origin) {
  // No "null" (sandboxed iframes, file://) and no missing Origin: browsers
  // always send a real one from a page, and "null" is what any site can fake.
  if (!origin || origin === "null") return false;
  const extra = String(flags["allow-origin"] || "").split(",").filter(Boolean);
  if (extra.includes(origin)) return true;
  try {
    const h = new URL(origin).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(port);
    });
  });
}

const selectorOf = (anchorJson) => {
  try {
    const a = JSON.parse(anchorJson);
    return (a.cssSelector || a.xpath || a.tag || "?").slice(0, 70);
  } catch {
    return "?";
  }
};
const oneLine = (s, n = 200) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

const ASK = ["asked", "working", "done"];
const askOf = (rows) => rows.filter((r) => ASK.includes(r.event)).sort((a, b) => a.created_at - b.created_at).pop()?.event || null;

// Edited elements, one entry per (page, anchor): first original → latest text.
function editGroupsOf(store) {
  const map = new Map();
  for (const e of store.edits) {
    const k = e.page_path + "\u0000" + e.anchor_json;
    if (!map.has(k)) map.set(k, { page: e.page_path, anchorJson: e.anchor_json, rows: [] });
    map.get(k).rows.push(e);
  }
  const out = [];
  for (const g of map.values()) {
    const real = g.rows.filter((r) => !r.event).sort((a, b) => a.created_at - b.created_at);
    if (!real.length) continue;
    const last = real[real.length - 1];
    out.push({ ...g, id: last.id, from: real[0].original_text, to: last.new_text, by: last.author_name, status: last.status, ask: askOf(g.rows) });
  }
  return out;
}

function transcript(t, n = 600) {
  return oneLine(t.comments.map((c) => `${c.author_name || "someone"}: ${c.body}`).join(" | "), n);
}

function todoLine(item, by) {
  const who = by ? ` (asked by ${by})` : "";
  if (item.from !== undefined) return `[todo] e${item.id} on ${item.page} @ ${selectorOf(item.anchorJson)}${who}: change "${oneLine(item.from, 120)}" → "${oneLine(item.to, 120)}"`;
  return `[todo] #${item.id} on ${item.page} @ ${selectorOf(item.anchorJson)}${who}: ${transcript(item)}`;
}

function threadsOf(store) {
  const map = new Map();
  for (const c of store.comments) {
    if (c.event) continue;
    const k = c.page_path + "\u0000" + c.anchor_json;
    if (!map.has(k)) map.set(k, { id: c.id, page: c.page_path, anchorJson: c.anchor_json, status: c.status, comments: [] });
    const t = map.get(k);
    t.comments.push(c);
    t.status = c.status;
  }
  for (const t of map.values()) t.ask = askOf(store.comments.filter((c) => c.page_path === t.page && c.anchor_json === t.anchorJson));
  return [...map.values()];
}

// "e4" → the edit group containing edit 4; "3" / "#3" → the thread of comment 3.
function findItem(store, id) {
  const raw = String(id || "").replace(/^#/, "");
  if (/^e\d+$/i.test(raw)) {
    const eid = Number(raw.slice(1));
    const g = editGroupsOf(store).find((x) => x.rows.some((r) => r.id === eid));
    if (!g) throw new Error(`no edit e${eid}`);
    return { kind: "edit", ...g };
  }
  const t = threadsOf(store).find((x) => x.comments.some((c) => c.id === Number(raw)));
  if (!t) throw new Error(`no comment #${raw}`);
  return { kind: "comment", ...t };
}

function formatEvent(e, store) {
  switch (e.type) {
    case "comment": {
      const c = e.comment;
      const first = threadsOf(store).find((t) => t.page === c.page_path && t.anchorJson === c.anchor_json);
      const reply = first && first.id !== c.id ? ` (reply in #${first.id})` : "";
      return `[comment] #${c.id} ${c.author_name || "someone"} on ${c.page_path} @ ${selectorOf(c.anchor_json)}${reply}: ${oneLine(c.body)}`;
    }
    case "edit": {
      const x = e.edit;
      return `[edit] e${x.id} ${x.author_name || "someone"} on ${x.page_path} @ ${selectorOf(x.anchor_json)}: "${oneLine(x.original_text, 80)}" → "${oneLine(x.new_text, 80)}"`;
    }
    case "todo": {
      const pool = e.kind === "edit" ? editGroupsOf(store) : threadsOf(store);
      const item = pool.find((x) => x.page === e.page && x.anchorJson === e.anchorJson);
      return item ? todoLine(item, e.by) : `[todo] ${e.page} @ ${selectorOf(e.anchorJson)} (asked by ${e.by})`;
    }
    case "thread-resolved":
    case "thread-reopened":
    case "edit-resolved":
    case "edit-reopened":
      return `[${e.type}] ${e.page} @ ${selectorOf(e.anchorJson)} by ${e.by || "someone"}`;
    case "comment-deleted":
      return `[deleted] comment #${e.id} by ${e.by || "someone"}`;
    case "join":
      return `[join] ${e.name}${e.email ? ` <${e.email}>` : ""}`;
    case "leave":
      return `[leave] ${e.name}`;
    default:
      return `[${e.type}] ${JSON.stringify(e)}`;
  }
}

/* ── commands ── */

async function up() {
  ensureDir();
  const { Hub } = await import("../lib/hub.js");
  const { WebSocketServer } = await import("ws");
  const store = new Store(FILES.log);
  const agentName = flags.name || "Agent";
  const signal = String(flags.signal || readJson(FILES.room)?.signal || DEFAULT_SIGNAL).replace(/\/$/, "");
  const token = randomBytes(16).toString("hex");
  const print = (s) => process.stdout.write(s + "\n");

  const onEvent = (e) => {
    // The agent's own actions come from its own commands — don't echo them back.
    if (e.comment?.author_client_id === "agent" || e.byAgent) return;
    print(flags.json ? JSON.stringify(e) : formatEvent(e, store));
  };

  let sharing = null;
  let creating = null; // one room creation at a time, however many Share clicks
  async function share(by, pageUrl) {
    let room = readJson(FILES.room);
    if (!room || room.signal !== signal) {
      creating ||= createRoom(signal).finally(() => (creating = null));
      room = await creating;
    }
    if (sharing !== room.room) {
      hub.startSharing({ signal, room: room.room, ownerKey: room.ownerKey });
      sharing = room.room;
      print(`[status] sharing on${by ? ` (from the page, by ${by})` : ""} · ${shareUrl(room.room, pageUrl || flags.url)}`);
    }
    return { room: room.room };
  }
  function unshare() {
    if (hub.stopSharing()) print("[status] sharing off — local only");
    sharing = null;
    return { ok: true };
  }

  const onStatus = async (st) => {
    if (st.type === "shared-online") return;
    if (st.type === "reconnecting") print("[status] signalling dropped — reconnecting");
    else if (st.type === "replaced") {
      print("[status] another `commenter up` took over the shared room — sharing off here");
      unshare();
    } else if (st.type === "room-gone") {
      fs.rmSync(FILES.room, { force: true });
      sharing = null;
      print("[status] shared room expired — making a new one; old share links no longer work");
      for (let attempt = 0; sharing === null; attempt++) {
        try {
          await share();
        } catch (e) {
          print(`[status] could not create a new room (${e.message}) — retrying`);
          await new Promise((r) => setTimeout(r, Math.min(60000, 2000 * 2 ** attempt)));
        }
      }
    }
  };

  const hub = new Hub({ store, agentName, onEvent, onStatus, onShareRequest: (p, url) => share(p.name || "someone", typeof url === "string" ? url.slice(0, 500) : null) });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/overlay.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "access-control-allow-origin": "*" });
      return res.end(fs.readFileSync(OVERLAY));
    }
    // Control API for the CLI. The token header also means no web page can
    // call it (a custom header forces a CORS preflight we never answer).
    if (req.method === "POST" && req.headers["x-commenter-token"] === token) {
      let body = "";
      for await (const chunk of req) body += chunk;
      try {
        const r = url.pathname;
        const out = r === "/share" ? await share(null, JSON.parse(body || "{}").url) : r === "/unshare" ? unshare() : act(r, JSON.parse(body || "{}"), store, hub, agentName);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message }));
      }
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin;
    if (new URL(req.url, "http://127.0.0.1").pathname !== "/ws") return socket.destroy();
    if (!originAllowed(origin)) {
      print(`[status] refused a page from ${origin} — rerun with --allow-origin ${origin} to let it connect`);
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => hub.attachLocal(ws));
  });

  // A stable port per project, so the script tag in the page keeps working.
  const running = readJson(FILES.hub);
  if (running && alive(running.pid)) throw new Error(`\`commenter up\` is already running for this project (pid ${running.pid})`);
  const saved = readJson(FILES.local)?.port;
  let port = saved;
  const scan = async (from) => {
    for (let p = from; p < from + 100; p++) {
      try {
        return await listen(server, p);
      } catch (e) {
        if (e.code !== "EADDRINUSE") throw e;
      }
    }
    throw new Error(`no free port in ${from}–${from + 99}`);
  };
  if (saved) {
    try {
      await listen(server, saved);
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
      port = await scan(FIRST_PORT);
      print(`[status] port ${saved} is taken by something else — moved to ${port}; update the script tag in the page`);
    }
  } else port = await scan(FIRST_PORT);
  if (port !== saved) fs.writeFileSync(FILES.local, JSON.stringify({ port }) + "\n");
  fs.writeFileSync(FILES.hub, JSON.stringify({ port, pid: process.pid, token }) + "\n", { mode: 0o600 });

  print(`script:  ${scriptTag(port, signal)}`);
  print(`mode:    local — this machine only, no internet needed · \`commenter share\` or the page's Share button lets others in`);
  print(`log:     ${FILES.log}`);
  print(`[status] ready on 127.0.0.1:${port} · ${store.comments.filter((c) => !c.event).length} comments on file`);
  if (flags.shared) await share();

  const bye = () => {
    try {
      if (readJson(FILES.hub)?.pid === process.pid) fs.unlinkSync(FILES.hub);
    } catch {}
    hub.stop();
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

// reply / resolve / reopen / start / done — run inside the live hub, or straight on the file.
function act(route, { id, text }, store, hub, agentName) {
  const item = findItem(store, id);
  const author = { clientId: "agent", name: agentName, email: null };
  const at = { page: item.page, anchorJson: item.anchorJson };
  const comment = (body) => (hub ? hub.postComment({ ...at, body, author }) : store.addComment({ ...at, body, author }));
  const setAsk = (state) => {
    if (hub) return hub.setAsk({ kind: item.kind, ...at, state, author });
    return item.kind === "edit" ? store.addEdit({ ...at, author, event: state }) : store.addComment({ ...at, author, event: state });
  };

  if (route === "/start" || route === "/done") {
    if (route === "/done" && text) {
      if (item.kind === "edit") throw new Error("edits have no thread — run `done` without a note, or comment on the element");
      comment(text);
    }
    setAsk(route === "/start" ? "working" : "done");
    return { ok: true };
  }
  if (item.kind === "edit") throw new Error(`${route.slice(1)} works on comment threads, not edits`);
  if (route === "/reply") {
    if (!text) throw new Error("empty reply");
    return { ok: true, id: comment(text).id };
  }
  if (route === "/resolve" || route === "/reopen") {
    const resolve = route === "/resolve";
    if (hub) hub.setThreadStatus({ ...at, resolve, author });
    else {
      store.setThreadStatus(at.page, at.anchorJson, resolve ? "resolved" : "open");
      store.addComment({ ...at, author, event: resolve ? "resolved" : "reopened" });
    }
    return { ok: true };
  }
  throw new Error("unknown action");
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function control(route, body) {
  const running = readJson(FILES.hub);
  if (running && alive(running.pid)) {
    const r = await fetch(`http://127.0.0.1:${running.port}${route}`, { method: "POST", headers: { "x-commenter-token": running.token }, body: JSON.stringify(body) });
    const out = await r.json().catch(() => ({ error: `unexpected reply from port ${running.port}` }));
    if (!r.ok) throw new Error(out.error);
    return { ...out, live: true };
  }
  if (running) fs.rmSync(FILES.hub, { force: true }); // left behind by a hub that died
  return { ...act(route, body, new Store(FILES.log), null, flags.name || "Agent"), live: false };
}

function threads() {
  const store = new Store(FILES.log);
  const list = threadsOf(store).filter((t) => flags.all || t.status !== "resolved");
  const tag = (x) => `[${x.status}${x.ask ? ` · ${x.ask}` : ""}]`;
  for (const t of list) {
    console.log(`#${t.id} ${tag(t)} ${t.page} @ ${selectorOf(t.anchorJson)}`);
    for (const c of t.comments) console.log(`   #${c.id} ${c.author_name || "someone"}: ${oneLine(c.body)}`);
  }
  const edits = editGroupsOf(store).filter((g) => flags.all || g.status !== "resolved");
  for (const g of edits) console.log(`e${g.id} ${tag(g)} ${g.page} @ ${selectorOf(g.anchorJson)} by ${g.by || "someone"}: "${oneLine(g.from, 60)}" → "${oneLine(g.to, 60)}"`);
  if (!list.length && !edits.length) console.log(flags.all ? "nothing on file" : "nothing open");
}

function todo() {
  const store = new Store(FILES.log);
  const open = [...threadsOf(store), ...editGroupsOf(store)].filter((x) => x.ask === "asked" || x.ask === "working");
  for (const x of open) console.log(todoLine(x).replace("[todo]", x.ask === "working" ? "[working]" : "[todo]"));
  if (!open.length) console.log("nothing asked of the agent");
}

const saved = (out) => (out.live ? "" : " (hub not running — saved to file only)");
const commands = {
  up,
  threads,
  todo,
  async start() {
    console.log(`working on ${rest[0]}${saved(await control("/start", { id: rest[0] }))}`);
  },
  async done() {
    const [id, ...words] = rest;
    console.log(`done: ${id}${saved(await control("/done", { id, text: words.join(" ") }))}`);
  },
  async reply() {
    const [id, ...words] = rest;
    const out = await control("/reply", { id, text: words.join(" ") });
    console.log(`replied as #${out.id}${saved(out)}`);
  },
  async resolve() {
    console.log(`resolved thread of #${rest[0]}${saved(await control("/resolve", { id: rest[0] }))}`);
  },
  async reopen() {
    console.log(`reopened thread of #${rest[0]}${saved(await control("/reopen", { id: rest[0] }))}`);
  },
  link() {
    const local = readJson(FILES.local);
    if (!local) return console.log("not set up yet — run `commenter up`");
    console.log(`script:  ${scriptTag(local.port, readJson(FILES.room)?.signal)}`);
    const room = readJson(FILES.room);
    if (room) console.log(`share:   ${shareUrl(room.room, flags.url)}   (works while \`commenter up\` is sharing)`);
  },
  async share() {
    if (!alive(readJson(FILES.hub)?.pid)) throw new Error("`commenter up` isn't running — start it (or use `commenter up --shared`)");
    const out = await control("/share", { url: flags.url });
    console.log(`sharing on · ${shareUrl(out.room, flags.url)}`);
  },
  async unshare() {
    if (!alive(readJson(FILES.hub)?.pid)) throw new Error("`commenter up` isn't running");
    await control("/unshare", {});
    console.log("sharing off — local only");
  },
  help() {
    const src = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
    const header = src.slice(0, src.findIndex((l) => !l.startsWith("//")));
    console.log(header.map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  },
};

Promise.resolve()
  .then(() => (commands[cmd] || commands.help)())
  .catch((e) => {
    console.error(`commenter: ${e.message}`);
    process.exit(1);
  });
