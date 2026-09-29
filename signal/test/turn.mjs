// Real WebRTC through the deployed signalling, relay-only (forces TURN).
// usage: node test/turn.mjs [https://signal.pa1nd.de] [relay|all]
import { RTCPeerConnection } from "werift";
const BASE = process.argv[2] || "https://signal.pa1nd.de";
const POLICY = process.argv[3] || "relay";
const WS = BASE.replace(/^http/, "ws");

function connect(url, onmsg) {
  const ws = new WebSocket(url);
  ws.onmessage = (e) => onmsg(JSON.parse(e.data));
  ws.put = (m) => ws.send(JSON.stringify(m));
  return new Promise((r) => (ws.onopen = () => r(ws)));
}
const iceConfig = (servers) => servers.flatMap((s) => [].concat(s.urls).map((u) => ({ urls: u, username: s.username, credential: s.credential })))
  .filter((s) => s.urls.startsWith("turn:") ? s.urls.includes("transport=udp") : !s.urls.startsWith("turns:"));

const { room, ownerKey } = await (await fetch(`${BASE}/rooms`, { method: "POST" })).json();
const t0 = Date.now();
const done = new Promise((resolve, reject) => {
  setTimeout(() => reject(new Error("no data channel within 20s")), 20000);

  let agentPc;
  const agent = connect(`${WS}/rooms/${room}?role=agent&key=${ownerKey}`, async (m) => {
    if (m.type === "welcome") agent.ice = m.iceServers;
    if (m.type === "signal" && m.data.sdp) {
      agentPc = new RTCPeerConnection({ iceServers: iceConfig(agent.ice), iceTransportPolicy: POLICY });
      agentPc.onDataChannel.subscribe((dc) => dc.onMessage.subscribe((d) => dc.send(`echo:${d}`)));
      await agentPc.setRemoteDescription(m.data.sdp);
      await agentPc.setLocalDescription(await agentPc.createAnswer());
      await new Promise((r) => (agentPc.iceGatheringState === "complete" ? r() : agentPc.iceGatheringStateChange.subscribe((s) => s === "complete" && r())));
      (await agent).put({ type: "signal", to: m.from, data: { sdp: agentPc.localDescription } });
    }
  });

  agent.then(() => connect(`${WS}/rooms/${room}?role=peer&name=Test`, async (m) => {
    if (m.type === "welcome") {
      const pc = new RTCPeerConnection({ iceServers: iceConfig(m.iceServers), iceTransportPolicy: POLICY });
      peer.pc = pc;
      const dc = pc.createDataChannel("comments");
      dc.onMessage.subscribe((d) => {
        const pair = pc.iceTransports?.[0]?.connection?.nominated;
        resolve({ reply: String(d), ms: Date.now() - t0, local: pair?.localCandidate?.type, remote: pair?.remoteCandidate?.type });
      });
      dc.stateChanged.subscribe((s) => s === "open" && dc.send("hello"));
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => (pc.iceGatheringState === "complete" ? r() : pc.iceGatheringStateChange.subscribe((s) => s === "complete" && r())));
      (await peer.ws).put({ type: "signal", to: "agent", data: { sdp: pc.localDescription } });
    }
    if (m.type === "signal" && m.data.sdp) await peer.pc.setRemoteDescription(m.data.sdp);
  })).then((ws) => (peer.ws = ws));
  const peer = {};
  peer.ws = new Promise(() => {});
});

try {
  const r = await done;
  console.log(`✓ data channel (${POLICY}): "${r.reply}" in ${r.ms} ms · candidates local=${r.local} remote=${r.remote}`);
  process.exit(r.reply === "echo:hello" ? 0 : 1);
} catch (e) { console.log(`✗ ${e.message}`); process.exit(1); }
