(function () {
  "use strict";
  const A = window.HOODZ_ART;
  const LI = {};
  A.layers.forEach((L, i) => { LI[L.name] = i; });
  const blob = A.dna.blob;
  function look(i) {
    const v = BigInt("0x" + blob.substr(i * 10, 10));
    const tier = Number((v >> 37n) & 7n), cw = Number((v >> 35n) & 3n), glow = Number((v >> 32n) & 7n);
    const traits = new Array(A.layers.length).fill(0);
    let shift = 32n;
    A.dna.order.forEach((L, k) => {
      const b = BigInt(A.dna.bits[k]);
      shift -= b;
      traits[LI[L]] = Number((v >> shift) & ((1n << b) - 1n));
    });
    return { tier, cw, glow, traits };
  }
  function grid(i) {
    const k = look(i);
    const c = A.tiers[A.dna.tiers[k.tier]][k.cw], g = A.glows[k.glow];
    const fm = { 250: c[1], 251: c[2], 252: c[3], 253: c[4], 254: g[1] };
    const cells = new Array(576).fill(null);
    A.layers.forEach((L, li) => {
      const d = L.traits[k.traits[li]].data;
      for (let p = 0; p < d.length; p += 6) {
        const v = parseInt(d.substr(p, 4), 16), col = parseInt(d.substr(p + 4, 2), 16);
        const x = v >> 10, y = (v >> 5) & 31, n = (v & 31) + 1;
        const hex = col >= 250 ? fm[col] : A.palette[col];
        for (let q = 0; q < n && x + q < 24; q++) cells[y * 24 + x + q] = hex;
      }
    });
    return cells;
  }
  function draw(canvas, i) {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    grid(i).forEach((hex, n) => { if (hex) { ctx.fillStyle = "#" + hex; ctx.fillRect(n % 24, Math.floor(n / 24), 1, 1); } });
  }
  function traits(i) {
    const k = look(i);
    const out = [{ type: "Rarity", value: A.dna.tiers[k.tier] }, { type: "Hood Color", value: A.tiers[A.dna.tiers[k.tier]][k.cw][0] }, { type: "Glow", value: A.glows[k.glow][0] }];
    A.layers.forEach((L, li) => { if (L.name !== "Hood") out.push({ type: L.name, value: L.traits[k.traits[li]].name }); });
    return out;
  }
  window.HoodzCore = { look, grid, draw, traits, tierName: (i) => A.dna.tiers[look(i).tier] };
})();
