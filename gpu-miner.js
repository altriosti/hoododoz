// CatASIC GPU miner (WebGPU compute shader, keccak256).
// Finds a nonce so that keccak256(miner, nonce, lastWork, blockhash) <= target.
// Message layout (116 bytes): miner[0..20) nonce[20..52) lastWork[52..84) blockhash[84..116)
// The GPU writes the low 8 bytes of the nonce: bytes 44..47 = batch, bytes 48..51 = thread id.
(function () {
  "use strict";

  // ---------- shader generation ----------
  function roundConstants() {
    // standard Keccak round constants via the LFSR
    const out = [];
    let r = 1;
    const lfsr = () => {
      const bit = r & 1;
      r = ((r << 1) ^ ((r & 0x80) ? 0x71 : 0)) & 0xff;
      return bit;
    };
    for (let round = 0; round < 24; round++) {
      let lo = 0, hi = 0;
      for (let j = 0; j < 7; j++) {
        const pos = (1 << j) - 1;
        if (lfsr()) {
          if (pos < 32) lo = (lo | (1 << pos)) >>> 0;
          else hi = (hi | (1 << (pos - 32))) >>> 0;
        }
      }
      out.push(lo >>> 0, hi >>> 0);
    }
    return out;
  }

  const ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14],
  ];

  // returns [loExpr, hiExpr] for rotl64(lo, hi, n)
  function rotl(lo, hi, n) {
    if (n === 0) return [lo, hi];
    if (n === 32) return [hi, lo];
    if (n < 32) {
      return [`((${lo} << ${n}u) | (${hi} >> ${32 - n}u))`, `((${hi} << ${n}u) | (${lo} >> ${32 - n}u))`];
    }
    const m = n - 32;
    return [`((${hi} << ${m}u) | (${lo} >> ${32 - m}u))`, `((${lo} << ${m}u) | (${hi} >> ${32 - m}u))`];
  }

  function buildShader() {
    const rc = roundConstants();
    const L = [];
    L.push(`@group(0) @binding(0) var<storage, read> params: array<u32, 44>;`);
    L.push(`@group(0) @binding(1) var<storage, read_write> result: array<atomic<u32>, 4>;`);
    L.push(`var<private> RC: array<u32, 48> = array<u32, 48>(${rc.map((v) => v + "u").join(", ")});`);
    L.push(`fn bswap(x: u32) -> u32 { return ((x & 0xffu) << 24u) | ((x & 0xff00u) << 8u) | ((x >> 8u) & 0xff00u) | (x >> 24u); }`);
    L.push(`@compute @workgroup_size(256)`);
    L.push(`fn main(@builtin(global_invocation_id) g: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {`);
    L.push(`  let gid = g.x + g.y * nw.x * 256u;`);
    // state words a0..a49 (lane i = a{2i} lo, a{2i+1} hi)
    for (let w = 0; w < 50; w++) {
      if (w < 34) L.push(`  var a${w}: u32 = params[${w}];`);
      else L.push(`  var a${w}: u32 = 0u;`);
    }
    L.push(`  a11 = bswap(params[42]);`);
    L.push(`  a12 = bswap(gid);`);
    L.push(`  for (var r: u32 = 0u; r < 24u; r = r + 1u) {`);
    // theta
    for (let x = 0; x < 5; x++) {
      const lo = [0, 1, 2, 3, 4].map((y) => `a${2 * (x + 5 * y)}`).join(" ^ ");
      const hi = [0, 1, 2, 3, 4].map((y) => `a${2 * (x + 5 * y) + 1}`).join(" ^ ");
      L.push(`    let c${x}l = ${lo}; let c${x}h = ${hi};`);
    }
    for (let x = 0; x < 5; x++) {
      const p = (x + 4) % 5, n = (x + 1) % 5;
      const [rl, rh] = rotl(`c${n}l`, `c${n}h`, 1);
      L.push(`    let d${x}l = c${p}l ^ ${rl}; let d${x}h = c${p}h ^ ${rh};`);
    }
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y;
        L.push(`    a${2 * i} = a${2 * i} ^ d${x}l; a${2 * i + 1} = a${2 * i + 1} ^ d${x}h;`);
      }
    }
    // rho + pi: B[y, 2x+3y] = rotl(A[x,y], ROT[x][y])
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        const j = y + 5 * ((2 * x + 3 * y) % 5);
        const [rl, rh] = rotl(`a${2 * i}`, `a${2 * i + 1}`, ROT[x][y]);
        L.push(`    let b${j}l = ${rl}; let b${j}h = ${rh};`);
      }
    }
    // chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        const i = x + 5 * y, i1 = ((x + 1) % 5) + 5 * y, i2 = ((x + 2) % 5) + 5 * y;
        L.push(`    a${2 * i} = b${i}l ^ ((~b${i1}l) & b${i2}l); a${2 * i + 1} = b${i}h ^ ((~b${i1}h) & b${i2}h);`);
      }
    }
    // iota
    L.push(`    a0 = a0 ^ RC[2u * r]; a1 = a1 ^ RC[2u * r + 1u];`);
    L.push(`  }`);
    // compare hash (bytes 0..31) as a big-endian number with target words params[34..41]
    L.push(`  var h = array<u32, 8>(bswap(a0), bswap(a1), bswap(a2), bswap(a3), bswap(a4), bswap(a5), bswap(a6), bswap(a7));`);
    L.push(`  var ok = true;`);
    L.push(`  for (var k: u32 = 0u; k < 8u; k = k + 1u) {`);
    L.push(`    let t = params[34u + k];`);
    L.push(`    if (h[k] < t) { break; }`);
    L.push(`    if (h[k] > t) { ok = false; break; }`);
    L.push(`  }`);
    L.push(`  if (ok) {`);
    L.push(`    let prev = atomicAdd(&result[0], 1u);`);
    L.push(`    if (prev == 0u) { atomicStore(&result[1], gid); atomicStore(&result[2], params[42]); }`);
    L.push(`  }`);
    L.push(`}`);
    return L.join("\n");
  }

  // ---------- helpers ----------
  function hexToBytes(hex, len) {
    hex = hex.replace(/^0x/, "").padStart(len * 2, "0");
    const out = new Uint8Array(len);
    for (let i = 0; i < len; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function toHex(bytes) {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
  }

  class CatGpuMiner {
    constructor() {
      this.device = null;
      this.running = false;
      this.job = null;
      this.onFound = null; // ({nonce, bn, jobId})
      this.onRate = null; // (hashes, ms)
      this.threads = 256 * 4096; // tuned automatically
      this.adapterName = "";
      this.usage = 1;
    }

    static supported() {
      return typeof navigator !== "undefined" && !!navigator.gpu;
    }

    async init() {
      if (!CatGpuMiner.supported()) throw new Error("WebGPU is not available in this browser");
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!adapter) throw new Error("No GPU adapter found");
      this.adapterName = (adapter.info && (adapter.info.description || adapter.info.vendor)) || "GPU";
      this.device = await adapter.requestDevice();
      const module = this.device.createShaderModule({ code: buildShader() });
      if (module.getCompilationInfo) {
        const info = await module.getCompilationInfo();
        const errs = info.messages.filter((m) => m.type === "error");
        if (errs.length) throw new Error("Shader error: " + errs[0].message);
      }
      this.pipeline = await this.device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" },
      });
      this.paramBuf = this.device.createBuffer({ size: 44 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.resBuf = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      this.readBuf = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      this.bind = this.device.createBindGroup({
        layout: this.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.paramBuf } },
          { binding: 1, resource: { buffer: this.resBuf } },
        ],
      });
      return this.adapterName;
    }

    // job: {id, miner, lastWork, blockHash, bn, target}
    setJob(job) {
      const msg = new Uint8Array(136);
      msg.set(hexToBytes(job.miner, 20), 0);
      const rnd = new Uint8Array(24);
      crypto.getRandomValues(rnd);
      msg.set(rnd, 20); // nonce bytes 20..43 random, 44..51 filled by GPU
      msg.set(hexToBytes(job.lastWork, 32), 52);
      msg.set(hexToBytes(job.blockHash, 32), 84);
      msg[116] ^= 0x01; // keccak padding
      msg[135] ^= 0x80;
      const params = new Uint32Array(44);
      const dv = new DataView(msg.buffer);
      for (let w = 0; w < 34; w++) params[w] = dv.getUint32(w * 4, true);
      const t = hexToBytes(job.target, 32);
      const tv = new DataView(t.buffer);
      for (let k = 0; k < 8; k++) params[34 + k] = tv.getUint32(k * 4, false);
      this.job = { ...job, msg, params, batch: 0 };
    }

    start(job) {
      this.setJob(job);
      this.running = true;
      if (!this._active) this._loop(); // never run two loops at once
    }

    stop() {
      this.running = false;
      this.job = null;
    }

    async _loop() {
      this._active = true;
      try {
        await this._run();
      } finally {
        this._active = false;
      }
    }

    async _run() {
      while (this.running && this.job) {
        const job = this.job;
        const params = job.params;
        params[42] = job.batch >>> 0;
        this.device.queue.writeBuffer(this.paramBuf, 0, params);
        this.device.queue.writeBuffer(this.resBuf, 0, new Uint32Array(4));
        const groups = Math.max(1, Math.floor(this.threads / 256));
        const gx = Math.min(groups, 65535), gy = Math.ceil(groups / gx);
        const enc = this.device.createCommandEncoder();
        const pass = enc.beginComputePass();
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bind);
        pass.dispatchWorkgroups(gx, gy);
        pass.end();
        enc.copyBufferToBuffer(this.resBuf, 0, this.readBuf, 0, 16);
        const t0 = performance.now();
        this.device.queue.submit([enc.finish()]);
        await this.readBuf.mapAsync(GPUMapMode.READ);
        const r = new Uint32Array(this.readBuf.getMappedRange().slice(0));
        this.readBuf.unmap();
        const ms = performance.now() - t0;
        const hashes = gx * gy * 256;
        if (this.onRate) this.onRate(hashes, ms);
        // aim for ~120 ms per dispatch so the page stays smooth
        if (ms < 60 && this.threads < 256 * 65535 * 4) this.threads *= 2;
        else if (ms > 250 && this.threads > 256 * 64) this.threads = Math.floor(this.threads / 2);
        if (job !== this.job) continue; // job changed while running
        if (r[0] > 0) {
          const nonce = job.msg.slice(20, 52);
          const dv = new DataView(nonce.buffer);
          dv.setUint32(24, r[2], false); // bytes 44..47 of message
          dv.setUint32(28, r[1], false); // bytes 48..51 of message
          this.running = false;
          this.job = null;
          if (this.onFound) setTimeout(() => this.onFound({ nonce: toHex(nonce), bn: job.bn, jobId: job.id }), 0);
          return;
        }
        job.batch = (job.batch + 1) >>> 0;
        if (this.usage < 1) await new Promise((r) => setTimeout(r, (ms * (1 - this.usage)) / Math.max(0.1, this.usage)));
      }
      this.running = false;
    }
  }

  CatGpuMiner.buildShader = buildShader;
  globalThis.CatGpuMiner = CatGpuMiner;
})();
