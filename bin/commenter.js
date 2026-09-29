#!/usr/bin/env node
// commenter — the agent's end of p2p-commenter-harness.
//
//   commenter up [--url <page>] [--name <agent name>] [--json]   host the room; one line per event
//   commenter todo                                                what people asked the agent to do
//   commenter threads [--all]                                     open threads + edits (all with --all)
//   commenter start <id>                                          mark a todo as "agent working"
//   commenter done <id> [note…]                                   mark it done (note → reply in thread)
//   commenter reply <id> <text…>                                  reply in the thread of comment <id>
//   commenter resolve <id> | reopen <id>                          close / reopen that thread
//   commenter link [--url <page>]                                 script tag + share link
//
// <id> is a comment number (#3 or 3) or an edit (e4). Output lines:
//   [todo]  someone asked the agent to act — the thread or edit follows
//   [comment] / [edit]   for information; people may still be discussing
//
// State lives in ./.commenter/ (override with --dir):
//   comments.jsonl   the review — append-only, yours to keep
//   room.json        room id + owner key (secret, git-ignored)
//   hub.json         control port of the running `up` (git-ignored)

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Store } from "../lib/store.js";

const DEFAULT_SIGNAL = "https://signal.pa1nd.de";

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith("--") ? argv.shift() : "help";
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) {
    const k = argv[i].slice(2);
    flags[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  } else rest.push(argv[i]);
}

const DIR = path.resolve(flags.dir || ".commenter");
const FILES = {
  log: path.join(DIR, "comments.jsonl"),
  room: path.join(DIR, "room.json"),
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

function linkInfo({ room, signal }, url) {
  const tag = `<script src="${signal}/overlay.js" data-room="${room}" async></script>`;
  const lines = [`script:  ${tag}`];
  if (url) lines.push(`share:   ${url.replace(/#.*$/, "")}#cmt=${room}`);
  else lines.push(`share:   <page-url>#cmt=${room}   (the page must load the script, e.g. via the tag above)`);
  return lines.join("\n");
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
  const store = new Store(FILES.log);
  const agentName = flags.name || "Agent";
  const signal = String(flags.signal || readJson(FILES.room)?.signal || DEFAULT_SIGNAL).replace(/\/$/, "");
  let room = readJson(FILES.room);
  if (!room || room.signal !== signal) room = await createRoom(signal);

  const print = (s) => process.stdout.write(s + "\n");
  let hub;
  const onEvent = (e) => {
    // The agent's own actions come from its own commands — don't echo them back.
    if (e.comment?.author_client_id === "agent" || e.by === agentName) return;
    print(flags.json ? JSON.stringify(e) : formatEvent(e, store));
  };
  const onStatus = async (s) => {
    if (s.type === "online") print(`[status] online · room ${room.room} · ${store.comments.filter((c) => !c.event).length} comments on file`);
    else if (s.type === "reconnecting") print("[status] signalling dropped — reconnecting");
    else if (s.type === "replaced") {
      print("[status] another `commenter up` took over this room — exiting");
      process.exit(1);
    } else if (s.type === "room-gone") {
      room = await createRoom(signal);
      print(`[status] room expired — created a new one; old share links no longer work\n${linkInfo(room, flags.url)}`);
      hub = startHub();
    }
  };
  const startHub = () => {
    const h = new Hub({ signal, room: room.room, ownerKey: room.ownerKey, store, agentName, onEvent, onStatus });
    h.start();
    return h;
  };
  hub = startHub();

  // Control port for `commenter reply/resolve/reopen` while this process runs.
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const out = act(req.url, JSON.parse(body || "{}"), store, hub, agentName);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message }));
    }
  });
  server.listen(0, "127.0.0.1", () => {
    fs.writeFileSync(FILES.hub, JSON.stringify({ port: server.address().port, pid: process.pid }) + "\n");
  });

  print(linkInfo(room, flags.url));
  print(`log:     ${FILES.log}`);

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

async function control(route, body) {
  const running = readJson(FILES.hub);
  if (running) {
    try {
      const r = await fetch(`http://127.0.0.1:${running.port}${route}`, { method: "POST", body: JSON.stringify(body) });
      const out = await r.json();
      if (!r.ok) throw new Error(out.error);
      return { ...out, live: true };
    } catch (e) {
      if (e.cause?.code !== "ECONNREFUSED") throw e;
    }
  }
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
    const room = readJson(FILES.room);
    console.log(room ? linkInfo(room, flags.url) : "no room yet — run `commenter up`");
  },
  help() {
    const src = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1);
    const header = src.slice(0, src.findIndex((l) => !l.startsWith("//")));
    console.log(header.map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  },
};

Promise.resolve((commands[cmd] || commands.help)()).catch((e) => {
  console.error(`commenter: ${e.message}`);
  process.exit(1);
});
