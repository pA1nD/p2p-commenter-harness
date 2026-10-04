// Regression tests for the local hub: each one replays an attack or failure
// from the v0.3.0 review against a real `commenter up` in a temp directory.
// Run: npm test

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { Hub } from "../lib/hub.js";
import { Store } from "../lib/store.js";

const CLI = new URL("../bin/commenter.js", import.meta.url).pathname;
const ORIGIN = "http://localhost:3000";
const ANCHOR = { cssSelector: "h1", xpath: "/html/body/h1", tag: "h1", offset: { fx: 0.5, fy: 0.5 } };

let dir, hub, port, out = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "commenter-test-"));
  hub = spawn(process.execPath, [CLI, "up", "--dir", dir, "--name", "Claude"], { stdio: ["ignore", "pipe", "pipe"] });
  hub.stdout.on("data", (d) => (out += d));
  hub.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 100 && !/ready on 127\.0\.0\.1:(\d+)/.test(out); i++) await sleep(50);
  port = Number(out.match(/ready on 127\.0\.0\.1:(\d+)/)?.[1]);
  assert.ok(port, `hub did not start:\n${out}`);
});

after(() => {
  hub?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});


// A visitor: connects, says hello, and can make RPC calls.
async function visitor({ origin = ORIGIN, clientId, name } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", () => reject(new Error("rejected")));
  });
  const frames = [];
  const waiters = new Map();
  let seq = 0;
  ws.on("message", (raw) => {
    const f = JSON.parse(String(raw));
    if (f.t === "rpc_result") waiters.get(f.id)?.(f);
    else frames.push(f);
  });
  const send = (f) => ws.send(typeof f === "string" ? f : JSON.stringify(f));
  send({ t: "hello", clientId });
  if (name) send({ t: "identify", name });
  const rpc = (method, p, body) =>
    new Promise((resolve) => {
      const id = ++seq;
      waiters.set(id, resolve);
      send({ t: "rpc", id, method, path: p, body });
    });
  await sleep(50);
  return { ws, frames, send, rpc };
}

const rejected = (origin) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin === undefined ? {} : { origin });
    ws.once("open", () => (ws.close(), resolve(false)));
    ws.once("error", () => resolve(true));
  });

test("only loopback pages can connect — not Origin: null, missing, or foreign", async () => {
  assert.equal(await rejected("null"), true);
  assert.equal(await rejected(undefined), true);
  assert.equal(await rejected("https://evil.example"), true);
  assert.equal(await rejected(ORIGIN), false);
});

test("control API refuses requests without the token", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/reply`, { method: "POST", body: JSON.stringify({ id: 1, text: "x" }) });
  assert.equal(r.status, 404);
});

test("a bare JSON null (and other non-objects) don't crash the hub", async () => {
  const v = await visitor();
  for (const raw of ["null", "42", '"x"', "[]", "{"]) v.send(raw);
  await sleep(100);
  const r = await v.rpc("GET", "/__c/api/snapshot");
  assert.equal(r.status, 200);
  v.ws.close();
});

test("a chunk with a huge index is ignored without stalling the hub", async () => {
  const v = await visitor();
  const t0 = Date.now();
  v.send({ t: "chunk", id: "a", i: 400_000_000, n: 400_000_001, d: "x" });
  const r = await v.rpc("GET", "/__c/api/snapshot");
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
  v.ws.close();
});

test("a peer hoarding unfinished chunks gets dropped", async () => {
  const v = await visitor();
  const closed = new Promise((r) => v.ws.once("close", r));
  const piece = "x".repeat(15000);
  for (let id = 0; id < 20; id++) for (let i = 0; i < 40; i++) v.send({ t: "chunk", id: String(id), i, n: 1000, d: piece });
  await Promise.race([closed, sleep(2000).then(() => assert.fail("peer was not dropped"))]);
});

test("visitors can't take the agent's identity", async () => {
  const v = await visitor({ clientId: "agent", name: "Mallory" });
  const r = await v.rpc("POST", "/__c/api/comments", { page: "/", anchor: ANCHOR, comment: "posing as the agent" });
  assert.notEqual(r.body.comment.author_client_id, "agent");
  await sleep(100);
  assert.match(out, /\[comment\] #\d+ Mallory .*posing as the agent/);
  v.ws.close();
});

test("a visitor who picks the agent's display name is still heard", async () => {
  const v = await visitor({ clientId: "claude-fan", name: "Claude" });
  await v.rpc("POST", "/__c/api/comments", { page: "/", anchor: ANCHOR, comment: "same name as the agent" });
  await sleep(100);
  assert.match(out, /same name as the agent/);
  v.ws.close();
});

test("only the author can delete a comment", async () => {
  const ana = await visitor({ clientId: "ana", name: "Ana" });
  const ben = await visitor({ clientId: "ben", name: "Ben" });
  const { body } = await ana.rpc("POST", "/__c/api/comments", { page: "/", anchor: ANCHOR, comment: "mine" });
  const byBen = await ben.rpc("POST", "/__c/api/comments/delete", { commentId: body.comment.id });
  assert.equal(byBen.status, 403);
  const byAna = await ana.rpc("POST", "/__c/api/comments/delete", { commentId: body.comment.id });
  assert.equal(byAna.status, 200);
  ana.ws.close();
  ben.ws.close();
});

test("colours and page paths from peers are sanitised", async () => {
  const evil = await visitor({ clientId: "evil" });
  const watcher = await visitor({ clientId: "watcher" });
  evil.send({ t: "identify", name: "Evil", color: '#"/><img src=x onerror=alert(1)>' });
  evil.send({ t: "presence", page: "javascript:alert(1)" });
  await sleep(100);
  const roster = watcher.frames.filter((f) => f.t === "roster").pop().roster;
  const me = roster.find((u) => u.name === "Evil");
  assert.ok(!me.color.includes("<"), me.color);
  assert.equal(me.page, "/");
  const r = await evil.rpc("POST", "/__c/api/comments", { page: "javascript:alert(1)", anchor: ANCHOR, comment: "x", name: { a: 1 } });
  assert.equal(r.body.comment.page_path, "/");
  assert.notEqual(typeof r.body.comment.author_name, "object");
  evil.ws.close();
  watcher.ws.close();
});

test("reply text starting with -- is kept", async () => {
  const v = await visitor({ clientId: "dana", name: "Dana" });
  const { body } = await v.rpc("POST", "/__c/api/comments", { page: "/", anchor: ANCHOR, comment: "flag question" });
  v.ws.close();
  const reply = await run(["reply", String(body.comment.id), "--no-verify was needed", "--strict", "too"]);
  assert.match(reply, /replied as #\d+/);
  const threads = await run(["threads"]);
  assert.match(threads, /--no-verify was needed --strict too/);
});

test("a corrupted log line is skipped, not fatal", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "commenter-store-"));
  const log = path.join(tmp, "comments.jsonl");
  fs.writeFileSync(log, JSON.stringify({ op: "comment", id: 1, page_path: "/", anchor_json: "{}", body: "ok" }) + "\n{\"op\":\"comm");
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    assert.equal(new Store(log).comments.length, 1);
  } finally {
    process.stderr.write = write;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("comment ids are never reused after a delete", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "commenter-store-"));
  const store = new Store(path.join(tmp, "comments.jsonl"));
  const author = { clientId: "a", name: "A" };
  store.addComment({ page: "/", anchorJson: "{}", body: "one", author });
  const two = store.addComment({ page: "/", anchorJson: "{}", body: "two", author });
  store.deleteComment(two.id);
  assert.equal(store.addComment({ page: "/", anchorJson: "{}", body: "three", author }).id, two.id + 1);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("malformed WebRTC offers from a room peer don't crash the hub", async () => {
  const hubObj = new Hub({ store: new Store(path.join(dir, "rtc.jsonl")) });
  hubObj.ws = { send() {} };
  const offers = [{ type: "offer" }, { type: "offer", sdp: 1 }, { type: "offer", sdp: {} }, { type: "offer", sdp: "v=0\r\n" }];
  for (const sdp of offers) await hubObj.onSignal({ type: "signal", from: "p1", data: { sdp } });
  await hubObj.onSignal({ type: "signal", from: "p1", data: { candidate: { candidate: "garbage" } } });
  await sleep(100);
  hubObj.stop();
});

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args, "--dir", dir]);
    let s = "";
    p.stdout.on("data", (d) => (s += d));
    p.stderr.on("data", (d) => (s += d));
    p.on("close", () => resolve(s));
  });
}
