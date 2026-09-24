// CatASIC miner worker.
// Finds nonce so that keccak256(miner, nonce, lastWork, blockhash) <= target.
importScripts("vendor/sha3.min.js?v=20260922c");

let job = null;
let running = false;

function hexToBytes(hex, len) {
  hex = hex.replace(/^0x/, "").padStart(len * 2, "0");
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function lessOrEqual(hash, target) {
  for (let i = 0; i < 32; i++) {
    if (hash[i] < target[i]) return true;
    if (hash[i] > target[i]) return false;
  }
  return true;
}

function toHex(bytes) {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

function loop() {
  if (!running || !job) return;
  const { buf, target } = job;
  let best = job.best;
  const BATCH = 4000;
  const t0 = performance.now();
  for (let n = 0; n < BATCH; n++) {
    // increment nonce (bytes 20..51, big-endian), low bytes first
    for (let i = 51; i >= 20; i--) {
      buf[i] = (buf[i] + 1) & 255;
      if (buf[i] !== 0) break;
    }
    const h = keccak256.array(buf);
    if (!best || lessOrEqual(h, best)) best = h;
    if (lessOrEqual(h, target)) {
      running = false;
      postMessage({ type: "found", nonce: toHex(buf.slice(20, 52)), bn: job.bn, jobId: job.id, hash: toHex(h) });
      return;
    }
  }
  const dt = performance.now() - t0;
  job.best = best;
  const last = keccak256.array(buf); // the hash of the latest nonce, for the live stream
  postMessage({ type: "rate", hashes: BATCH, ms: dt, jobId: job.id, best: toHex(best), last: toHex(last) });
  setTimeout(loop, 0);
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === "start") {
    const buf = new Uint8Array(116);
    buf.set(hexToBytes(m.miner, 20), 0);
    // random starting nonce so workers never overlap
    const rnd = new Uint8Array(32);
    crypto.getRandomValues(rnd.subarray(8));
    buf.set(rnd, 20);
    buf.set(hexToBytes(m.lastWork, 32), 52);
    buf.set(hexToBytes(m.blockHash, 32), 84);
    job = { id: m.jobId, bn: m.bn, buf, target: hexToBytes(m.target, 32), best: null };
    if (!running) {
      running = true;
      loop();
    }
  } else if (m.type === "stop") {
    running = false;
    job = null;
  }
};
