// End-to-end check against a deployed signalling Worker.
// usage: node test/signal.mjs [https://signal.pa1nd.de]
const BASE = process.argv[2] || "https://signal.pa1nd.de";
const WS = BASE.replace(/^http/, "ws");
let failed = 0;
const ok = (cond, what) => { console.log(`${cond ? "✓" : "✗"} ${what}`); if (!cond) failed++; };

function connect(url) {
  const ws = new WebSocket(url);
  const queue = [], waiters = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); const w = waiters.shift(); w ? w(m) : queue.push(m); };
  ws.closed = new Promise((r) => (ws.onclose = (e) => r({ code: e.code, reason: e.reason })));
  ws.next = () => queue.length ? Promise.resolve(queue.shift())
    : Promise.race([new Promise((r) => waiters.push(r)), new Promise((_, j) => setTimeout(() => j(new Error("timeout")), 8000))]);
  ws.put = (m) => ws.send(JSON.stringify(m));
  return new Promise((r, j) => { ws.onopen = () => r(ws); ws.onerror = j; });
}

const res = await fetch(`${BASE}/rooms`, { method: "POST" });
const { room, ownerKey } = await res.json();
ok(res.status === 201 && room.length === 22, `room created (${room.slice(0, 6)}…)`);

const bad = await connect(`${WS}/rooms/${room}?role=agent&key=wrong`);
ok((await bad.closed).code === 4401, "wrong owner key rejected");
const none = await connect(`${WS}/rooms/${"x".repeat(22)}?role=peer`);
ok((await none.closed).code === 4404, "unknown room rejected");

const early = await connect(`${WS}/rooms/${room}?role=peer&name=Early`);
const ew = await early.next();
ok(ew.type === "welcome" && ew.agentOnline === false, "peer before agent sees agent offline");

const agent = await connect(`${WS}/rooms/${room}?role=agent&key=${ownerKey}`);
const aw = await agent.next();
ok(aw.type === "welcome" && aw.peers.length === 1 && aw.peers[0].name === "Early", "agent welcome lists waiting peer");
ok(aw.iceServers.some((s) => [].concat(s.urls).some((u) => u.startsWith("turn:")) && s.username), "agent gets TURN credentials");
ok((await early.next()).type === "agent-online", "waiting peer told agent is online");

const ana = await connect(`${WS}/rooms/${room}?role=peer&name=Ana`);
const nw = await ana.next();
ok(nw.iceServers.some((s) => s.credential), "peer gets TURN credentials");
const join = await agent.next();
ok(join.type === "peer-join" && join.peer.name === "Ana", "agent told Ana joined");

ana.put({ type: "signal", to: early.id, data: { sdp: "offer" } }); // `to` must be ignored for peers
const s1 = await agent.next();
ok(s1.type === "signal" && s1.from === nw.you && s1.data.sdp === "offer", "peer → agent signal (peers can't address other peers)");
agent.put({ type: "signal", to: nw.you, data: { sdp: "answer" } });
const s2 = await ana.next();
ok(s2.type === "signal" && s2.from === "agent" && s2.data.sdp === "answer", "agent → peer signal");

ana.close();
const leave = await agent.next();
ok(leave.type === "peer-leave" && leave.peer === nw.you, "agent told Ana left");
agent.close();
ok((await early.next()).type === "agent-offline", "peer told agent went offline");
early.close();

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
