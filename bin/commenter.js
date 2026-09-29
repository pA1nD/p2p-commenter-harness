#!/usr/bin/env node
// commenter — the agent's end of p2p-commenter-harness.
//
//   commenter up [--url <page>] [--name <agent name>] [--json]   host the room; one line per event
//   commenter threads [--all]                                     open threads (all with --all)
//   commenter reply <id> <text…>                                  reply in the thread of comment <id>
//   commenter resolve <id> | reopen <id>                          close / reopen that thread
//   commenter link [--url <page>]                                 script tag + share link
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
  return [...map.values()];
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
      return `[edit] #${x.id} ${x.author_name || "someone"} on ${x.page_path} @ ${selectorOf(x.anchor_json)}: "${oneLine(x.original_text, 80)}" → "${oneLine(x.new_text, 80)}"`;
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

// reply / resolve / reopen — run inside the live hub, or straight on the file.
function act(route, { id, text }, store, hub, agentName) {
  const c = store.comments.find((x) => x.id === Number(id) && !x.event);
  if (!c) throw new Error(`no comment #${id}`);
  const author = { clientId: "agent", name: agentName, email: null };
  if (route === "/reply") {
    if (!text) throw new Error("empty reply");
    const args = { page: c.page_path, anchorJson: c.anchor_json, body: text, author };
    const created = hub ? hub.postComment(args) : store.addComment(args);
    return { ok: true, id: created.id };
  }
  if (route === "/resolve" || route === "/reopen") {
    const args = { page: c.page_path, anchorJson: c.anchor_json, resolve: route === "/resolve", author };
    if (hub) hub.setThreadStatus(args);
    else {
      store.setThreadStatus(args.page, args.anchorJson, args.resolve ? "resolved" : "open");
      store.addComment({ page: args.page, anchorJson: args.anchorJson, author, event: args.resolve ? "resolved" : "reopened" });
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
  for (const t of list) {
    console.log(`#${t.id} [${t.status}] ${t.page} @ ${selectorOf(t.anchorJson)}`);
    for (const c of t.comments) console.log(`   #${c.id} ${c.author_name || "someone"}: ${oneLine(c.body)}`);
  }
  const edits = store.edits.filter((e) => !e.event && !e.superseded_at && (flags.all || e.status !== "resolved"));
  for (const e of edits) console.log(`edit #${e.id} [${e.status}] ${e.page_path} @ ${selectorOf(e.anchor_json)} by ${e.author_name || "someone"}: "${oneLine(e.original_text, 60)}" → "${oneLine(e.new_text, 60)}"`);
  if (!list.length && !edits.length) console.log(flags.all ? "nothing on file" : "nothing open");
}

const saved = (out) => (out.live ? "" : " (hub not running — saved to file only)");
const commands = {
  up,
  threads,
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
    const src = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n");
    console.log(src.slice(1, 14).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  },
};

Promise.resolve((commands[cmd] || commands.help)()).catch((e) => {
  console.error(`commenter: ${e.message}`);
  process.exit(1);
});
