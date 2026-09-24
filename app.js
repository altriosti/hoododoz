(() => {
  "use strict";
  const cfg = window.HOODZ_CONFIG, E = window.ethers, C = window.HoodzCore;
  const $ = (id) => document.getElementById(id);
  const SUPPLY = 4444, EPOCH = 404;
  const MINER_ABI = [
    "function miningState() view returns (bool,bool,uint256,uint256,uint256,uint256,bytes32,uint256,address,uint256,uint256)",
    "function targetFor(address) view returns (uint256)",
    "function mint(uint256,uint256) payable returns (uint256)",
    "function tokensOfOwner(address,uint256,uint256) view returns (uint256[])",
    "function hoodInfo(uint256[]) view returns (uint256[],uint256[],uint256[],uint256[],uint256[],uint256[])",
    "function ownerOf(uint256) view returns (address)",
    "function totalWeight() view returns (uint256)",
    "function burned() view returns (uint256)",
    "function lastMintBlock() view returns (uint256)",
    "function stake(uint256[],uint256)", "function unstake(uint256[])", "function claim(uint256[]) returns (uint256)", "function burn(uint256)",
    "event Mined(address indexed miner,uint256 indexed tokenId,uint256 artIndex,uint256 price,bytes32 work)",
    "error WeakHash()", "error BadBlock()", "error Underpaid()", "error SoldOut()", "error NotStarted()", "error MintPaused()",
    "error OneMintPerBlock()", "error IsStaked()", "error StillLocked()", "error BurnNotOpen()", "error TooYoung()", "error NotOwner()",
    "error AlreadyStarted()", "error BadTerm()", "error NotStaked()", "error TransferFailed()", "error ZeroAddress()", "error ReentrancyGuardReentrantCall()"
  ];
  const TOKEN_ABI = ["function totalSupply() view returns (uint256)", "function balanceOf(address) view returns (uint256)"];
  const BB_ABI = ["function totalBurned() view returns (uint256)", "function run() returns (uint256)"];
  const HOOK_ABI = ["function currentFee() view returns (uint24)"];

  const ready = !!(cfg.miner && E.isAddress(cfg.miner));
  const rp = window.makeCatProvider(cfg);
  const miner = ready ? new E.Contract(cfg.miner, MINER_ABI, rp) : null;
  const token = cfg.token && E.isAddress(cfg.token) ? new E.Contract(cfg.token, TOKEN_ABI, rp) : null;
  const bb = cfg.buyback && E.isAddress(cfg.buyback) ? new E.Contract(cfg.buyback, BB_ABI, rp) : null;
  const hook = cfg.hook && E.isAddress(cfg.hook) ? new E.Contract(cfg.hook, HOOK_ABI, rp) : null;

  const BLOCK_PROBE = "0x4360019003804060205260005260406000f3";
  async function chainBlock() {
    const raw = await rp.call({ data: BLOCK_PROBE });
    const [bn, hash] = E.AbiCoder.defaultAbiCoder().decode(["uint256", "bytes32"], raw);
    return { n: Number(bn) + 1, bn: Number(bn), hash };
  }
  const eth = (w, d = 4) => Number(E.formatEther(w)).toFixed(d);
  const fmtH = (n) => { const u = ["", "K", "M", "G", "T"]; let i = 0; while (n >= 1000 && i < 4) { n /= 1000; i++; } return (n < 10 ? n.toFixed(2) : n.toFixed(0)) + " " + u[i]; };
  const expectedHashes = (t) => Number((1n << 256n) / (BigInt(t) + 1n));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function log(msg, cls) {
    const d = document.createElement("div");
    d.innerHTML = `<span class="d">${new Date().toLocaleTimeString([], { hour12: false })}</span> ` + (cls ? `<span class="${cls}">${esc(msg)}</span>` : esc(msg));
    $("log").appendChild(d);
    while ($("log").children.length > 150) $("log").firstChild.remove();
    $("log").scrollTop = 1e9;
  }
  function errMsg(e) { return (e && (e.shortMessage || e.reason || e.message)) || "failed"; }

  const sc = $("showcase");
  [0, 1, 2, 3, 4, 5].forEach(() => { const c = document.createElement("canvas"); c.width = 24; c.height = 24; sc.appendChild(c); });
  function shuffleShowcase() { [...sc.children].forEach((c) => C.draw(c, Math.floor(Math.random() * SUPPLY))); }
  shuffleShowcase();
  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) setInterval(shuffleShowcase, 2500);

  function epochRows(cur) {
    let h = "";
    for (let e = 0; e <= 10; e++) {
      const a = e * EPOCH + 1, b = Math.min(SUPPLY, (e + 1) * EPOCH);
      h += `<tr class="${e === cur ? "now" : ""}"><td>${e + 1}${e === 0 ? " · ends at #404, trading opens" : ""}</td><td>#${a}–${b}</td><td>${(0.002 * (e + 1)).toFixed(3)} ETH</td></tr>`;
    }
    $("epochs").innerHTML = h;
  }
  epochRows(0);

  let state = null;
  async function refresh() {
    if (!ready) return;
    try {
      const s = await miner.miningState();
      const changed = !state || state[6] !== s[6];
      state = s;
      const minted = Number(s[2]);
      $("progBar").style.width = (minted / SUPPLY * 100).toFixed(2) + "%";
      $("progTxt").textContent = `${minted.toLocaleString()} / 4,444 mined`;
      $("sMinted").textContent = minted.toLocaleString();
      $("sEpoch").textContent = `${Number(s[3]) + 1} / 11`;
      $("sPrice").textContent = minted >= SUPPLY ? "sold out" : eth(s[4], 3) + " ETH";
      $("stepPrice").textContent = eth(s[4], 3);
      $("sDiff").textContent = fmtH(expectedHashes(s[5])) + "H";
      epochRows(Number(s[3]));
      if (!s[0]) $("mineBtn").textContent = "Mining opens soon";
      else if (s[1]) $("mineBtn").textContent = "Mining paused";
      else if (!mining) $("mineBtn").textContent = "Start mining";
      if (changed) loadRace(minted);
      if (mining && changed && !sending) startJob();
      refreshToken();
    } catch (e) { console.warn(e); }
  }
  async function refreshToken() {
    try {
      const [sup, bbb, hb, w] = await Promise.all([
        token ? token.totalSupply() : 0n, bb ? bb.totalBurned() : 0n, miner.burned(), miner.totalWeight()]);
      $("tSupply").textContent = Math.round(Number(E.formatEther(sup))).toLocaleString();
      $("tBurned").textContent = Math.round(Number(E.formatEther(bbb))).toLocaleString();
      $("tHoods").textContent = Number(hb).toLocaleString();
      $("kWeight").textContent = Number(w).toLocaleString();
      if (cfg.buyback) $("tQueue").textContent = eth(await rp.getBalance(cfg.buyback), 4) + " ETH";
      if (hook && state && state[10] > 0n) $("tFee").textContent = (Number(await hook.currentFee()) / 10000).toFixed(1) + "%";
      else $("tFee").textContent = "opens at #404";
      if (account && token) $("tMine").textContent = Math.round(Number(E.formatEther(await token.balanceOf(account)))).toLocaleString();
    } catch (e) { console.warn(e); }
  }
  async function loadRace(minted) {
    if (!minted) return;
    const ids = [];
    for (let i = minted; i > 0 && ids.length < 9; i--) ids.push(i);
    try {
      const info = await miner.hoodInfo(ids);
      const box = $("race"); box.innerHTML = "";
      ids.forEach((id, k) => {
        const art = Number(info[4][k]);
        const t = document.createElement("div");
        t.className = "tile t" + C.look(art).tier;
        t.innerHTML = `<canvas width="24" height="24"></canvas>#${id} · ${C.tierName(art)}`;
        C.draw(t.querySelector("canvas"), art);
        box.appendChild(t);
      });
    } catch (e) { console.warn(e); }
  }

  let signer = null, account = null, minerW = null, wp = null;
  const wallets = new Map();
  window.addEventListener("eip6963:announceProvider", (e) => { if (e.detail && e.detail.info) { wallets.set(e.detail.info.uuid, e.detail); renderWallets(); } });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const modal = $("walletModal");
  let pick = null;
  function walletItems() {
    const list = [...wallets.values()];
    if (!list.length && window.ethereum) list.push({ info: { uuid: "injected", name: "Browser wallet", icon: "", rdns: "injected" }, provider: window.ethereum });
    return list;
  }
  function renderWallets() {
    const box = $("wmList"); box.innerHTML = "";
    const list = walletItems();
    if (!list.length) box.innerHTML = '<p class="wm-note">No browser wallet found on this device.</p>';
    list.forEach((w) => {
      const b = document.createElement("button");
      b.className = "wm-item";
      b.innerHTML = (w.info.icon ? `<img alt="" src="${w.info.icon}">` : '<span class="ic">👛</span>') + `<span>${esc(w.info.name)}</span>`;
      b.onclick = () => { modal.close(); if (pick) pick(w); };
      box.appendChild(b);
    });
    const here = location.href, host = location.host + location.pathname;
    const links = [
      ["MetaMask", "https://metamask.app.link/dapp/" + host],
      ["Coinbase Wallet", "https://go.cb-w.com/dapp?cb_url=" + encodeURIComponent(here)],
      ["Trust Wallet", "https://link.trustwallet.com/open_url?coin_id=60&url=" + encodeURIComponent(here)],
      ["OKX Wallet", "https://www.okx.com/download?deeplink=" + encodeURIComponent("okx://wallet/dapp/url?dappUrl=" + encodeURIComponent(here))],
    ];
    $("wmMobile").innerHTML = links.map(([n, u]) => `<a class="wm-item" href="${u}" rel="noopener"><span class="ic">📱</span><span>${n}</span></a>`).join("");
  }
  $("wmClose").onclick = () => { modal.close(); if (pick) pick(null); };
  function chooseWallet() {
    return new Promise((res) => { pick = (w) => { pick = null; res(w); }; renderWallets(); modal.showModal(); });
  }
  async function useWallet(w, silent) {
    wp = w.provider;
    const accs = await wp.request({ method: silent ? "eth_accounts" : "eth_requestAccounts" });
    if (!accs || !accs.length) return false;
    const hex = "0x" + cfg.chainId.toString(16);
    const cur = await wp.request({ method: "eth_chainId" });
    if (cur.toLowerCase() !== hex) {
      if (silent) return false;
      try { await wp.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
      catch (e) {
        if (e.code !== 4902) throw e;
        await wp.request({ method: "wallet_addEthereumChain", params: [{ chainId: hex, chainName: cfg.chainName,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [cfg.rpc], blockExplorerUrls: [cfg.explorer] }] });
      }
    }
    signer = await new E.BrowserProvider(wp).getSigner();
    account = await signer.getAddress();
    minerW = ready ? new E.Contract(cfg.miner, MINER_ABI, signer) : null;
    $("connectBtn").textContent = account.slice(0, 6) + "…" + account.slice(-4);
    $("mineBtn").disabled = !ready;
    try { localStorage.setItem("hoodz-wallet", w.info.rdns); } catch {}
    if (wp.on) { wp.on("accountsChanged", () => location.reload()); wp.on("chainChanged", () => location.reload()); }
    log("Wallet connected: " + w.info.name + ".", "g");
    loadMine(); refreshToken();
    return true;
  }
  async function connect() {
    const w = await chooseWallet();
    if (!w) return false;
    return useWallet(w, false);
  }
  setTimeout(() => {
    let last = null; try { last = localStorage.getItem("hoodz-wallet"); } catch {}
    const w = last && walletItems().find((x) => x.info.rdns === last);
    if (w) useWallet(w, true).catch(() => {});
  }, 600);

  const cores = navigator.hardwareConcurrency || 4;
  const gpuOk = !!(window.CatGpuMiner && window.CatGpuMiner.supported());
  let useGpu = gpuOk;
  if (!gpuOk) { $("useGpu").disabled = true; $("useGpu").classList.remove("on"); $("useCpu").classList.add("on"); $("gpuNote").textContent = "GPU mining is not available in this browser. Chrome or Edge on a computer can use it."; }
  $("useGpu").onclick = () => { if (!gpuOk) return; useGpu = true; $("useGpu").classList.add("on"); $("useCpu").classList.remove("on"); if (mining) restartEngines(); };
  $("useCpu").onclick = () => { useGpu = false; $("useCpu").classList.add("on"); $("useGpu").classList.remove("on"); if (mining) restartEngines(); };
  $("usage").oninput = () => { $("usageVal").textContent = $("usage").value + "%"; if (mining) restartEngines(); };
  const usage = () => Number($("usage").value) / 100;

  let mining = false, sending = false, job = null, jobId = 0, workers = [], gpu = null, rates = [];
  async function ensureGpu() {
    if (gpu || !gpuOk) return;
    try { const g = new window.CatGpuMiner(); await g.init(); g.onRate = (h) => rates.push({ t: performance.now(), h }); g.onFound = (f) => found(f, "GPU"); gpu = g; }
    catch (e) { log("GPU could not start: " + e.message + ". Using CPU.", "r"); useGpu = false; }
  }
  function stopEngines() { workers.forEach((w) => w.terminate()); workers = []; if (gpu) gpu.stop(); }
  async function restartEngines() {
    stopEngines();
    if (useGpu) { await ensureGpu(); if (gpu) gpu.usage = usage(); }
    const threads = useGpu && gpu ? 1 : Math.max(1, Math.round(cores * usage()) - (usage() === 1 ? 0 : 0));
    for (let i = 0; i < (useGpu && gpu ? 0 : threads); i++) { const w = new Worker("miner.js"); w.onmessage = onCpu; workers.push(w); }
    if (job) postJob();
  }
  function postJob() {
    workers.forEach((w) => w.postMessage({ type: "start", jobId: job.id, miner: account, lastWork: job.lastWork, blockHash: job.blockHash, bn: job.bn, target: job.targetHex }));
    if (gpu && useGpu) gpu.start({ id: job.id, miner: account, lastWork: job.lastWork, blockHash: job.blockHash, bn: job.bn, target: job.targetHex });
  }
  async function startJob() {
    try {
      const s = await miner.miningState(); state = s;
      if (!s[0]) { log("Mining has not opened yet.", "a"); return stopMining(); }
      if (s[1]) { log("Mining is paused.", "a"); return stopMining(); }
      if (Number(s[2]) >= SUPPLY) { log("All 4,444 hoods are mined.", "a"); return stopMining(); }
      const t = await miner.targetFor(account);
      const cb = await chainBlock();
      jobId++;
      job = { id: jobId, lastWork: s[6], blockHash: cb.hash, bn: cb.bn, target: t, targetHex: "0x" + BigInt(t).toString(16).padStart(64, "0"), madeAt: cb.n };
      const st = s[8].toLowerCase() === account.toLowerCase() ? Number(s[9]) : 0;
      $("streak").textContent = st ? `${st} (×${2 ** Math.min(st, 6)} harder)` : "0";
      postJob();
      log(`Searching for hood #${Number(s[2]) + 1}.`, "d");
    } catch (e) { log("Could not read the chain: " + errMsg(e), "r"); }
  }
  function onCpu(e) { const m = e.data; if (!job || m.jobId !== job.id) return; if (m.type === "rate") rates.push({ t: performance.now(), h: m.hashes }); if (m.type === "found") found(m, "CPU"); }
  async function found(f, who) {
    if (sending || !job || f.jobId !== job.id) return;
    sending = true; const j = job;
    workers.forEach((w) => w.postMessage({ type: "stop" })); if (gpu) gpu.stop();
    try {
      const s = await miner.miningState();
      if (s[6] !== j.lastWork) { log("Someone mined this hood first. Next round.", "a"); return; }
      const hash = E.solidityPackedKeccak256(["address", "uint256", "bytes32", "bytes32"], [account, BigInt(f.nonce), j.lastWork, j.blockHash]);
      const t = await miner.targetFor(account);
      if (BigInt(hash) > t) { log("Find no longer valid. Next round.", "a"); return; }
      for (let w = 0; w < 20; w++) {
        const [cb, lmb] = await Promise.all([chainBlock(), miner.lastMintBlock()]);
        if (cb.n > Number(lmb)) break;
        if (w === 0) log("One hood per block: waiting for the next block…", "d");
        await new Promise((r) => setTimeout(r, 2000));
        const again = await miner.miningState();
        if (again[6] !== j.lastWork) { log("Someone mined this hood first. Next round.", "a"); return; }
      }
      log(`${who} found a hood! Confirm in your wallet.`, "g");
      const value = s[4];
      const est = await minerW.mint.estimateGas(BigInt(f.nonce), f.bn, { value });
      const tx = await minerW.mint(BigInt(f.nonce), f.bn, { value, gasLimit: est + 1800000n });
      log("Sent " + tx.hash.slice(0, 18) + "…", "d");
      const rc = await tx.wait();
      const ev = rc.logs.map((l) => { try { return minerW.interface.parseLog(l); } catch { return null; } }).find((x) => x && x.name === "Mined");
      if (ev) log(`You mined HOODZ #${ev.args.tokenId} · ${C.tierName(Number(ev.args.artIndex))}!`, "g");
      loadMine();
      if (!$("keepMining").checked) stopMining();
    } catch (e) { log("Mint failed: " + errMsg(e), "r"); }
    finally { sending = false; if (mining) { const before = state ? state[6] : null; await refresh(); if (mining && (!state || state[6] === before)) startJob(); } }
  }
  async function startMining() {
    if (!account && !(await connect())) return;
    mining = true; $("mineBtn").disabled = true; $("stopBtn").disabled = false; $("rigState").textContent = "mining";
    await restartEngines(); await startJob();
  }
  function stopMining() {
    mining = false; stopEngines(); job = null; rates = [];
    $("mineBtn").disabled = !account; $("stopBtn").disabled = true; $("rigState").textContent = "idle";
  }
  setInterval(async () => {
    if (!mining || sending || !job) return;
    const cb = await chainBlock().catch(() => null);
    if (cb && cb.n - job.madeAt > 60) startJob();
  }, 10000);
  setInterval(() => {
    const now = performance.now(); rates = rates.filter((r) => now - r.t < 4000);
    const r = mining ? rates.reduce((a, x) => a + x.h, 0) / 4 : 0;
    $("rate").textContent = fmtH(r) + "H/s";
    if (r && job) { const secs = expectedHashes(job.target) / r; $("expected").textContent = secs < 90 ? secs.toFixed(0) + " s" : (secs / 60).toFixed(1) + " min"; }
    else $("expected").textContent = "—";
  }, 1000);

  let mine = [], selected = new Set();
  async function loadMine() {
    if (!account || !ready) return;
    const box = $("myGrid");
    try {
      const minted = Number((await miner.miningState())[2]);
      let ids = [];
      for (let from = 1; from <= minted; from += 2000) ids = ids.concat((await miner.tokensOfOwner(account, from, Math.min(minted, from + 1999))).map(Number));
      if (!ids.length) { box.innerHTML = '<div class="empty">No hoods yet. Start the rig above.</div>'; mine = []; updateSel(); return; }
      const info = await miner.hoodInfo(ids);
      mine = ids.map((id, k) => ({ id, rent: info[0][k], weight: Number(info[1][k]), until: Number(info[2][k]), reward: info[3][k], art: Number(info[4][k]), minted: Number(info[5][k]) }));
      box.innerHTML = "";
      mine.forEach((h) => {
        const t = document.createElement("button");
        t.className = "tile t" + C.look(h.art).tier + (selected.has(h.id) ? " sel" : "");
        const staked = h.weight ? `<div class="st">staked ${h.weight}× · ${h.until * 1000 > Date.now() ? "until " + new Date(h.until * 1000).toLocaleDateString() : "unlocked"}</div>` : "";
        t.innerHTML = `<canvas width="24" height="24"></canvas>#${h.id} · ${C.tierName(h.art)}${staked}`;
        C.draw(t.querySelector("canvas"), h.art);
        t.onclick = () => { selected.has(h.id) ? selected.delete(h.id) : selected.add(h.id); t.classList.toggle("sel"); updateSel(); };
        box.appendChild(t);
      });
      updateSel();
    } catch (e) { console.warn(e); box.innerHTML = '<div class="empty">Could not load your hoods. Refresh to try again.</div>'; }
  }
  function updateSel() {
    const sel = mine.filter((h) => selected.has(h.id));
    const rent = mine.reduce((a, h) => a + h.rent, 0n);
    $("kRent").textContent = eth(rent, 5) + " ETH";
    $("kStaked").textContent = mine.filter((h) => h.weight).length.toString();
    $("selInfo").textContent = sel.length ? `${sel.length} selected: ` + sel.map((h) => "#" + h.id).join(", ") : "Nothing selected";
  }
  const selIds = () => [...selected];
  async function send(p, label) {
    try { if (!account && !(await connect())) return; const tx = await p(); log(label + "…", "d"); await tx.wait(); log(label + " done.", "g"); selected.clear(); loadMine(); refresh(); }
    catch (e) { log(label + " failed: " + errMsg(e), "r"); }
  }
  document.querySelectorAll("[data-term]").forEach((b) => b.onclick = () => {
    const ids = selIds(); if (!ids.length) return log("Select hoods first.", "a");
    send(() => minerW.stake(ids, Number(b.dataset.term)), "Staking");
  });
  $("unstakeBtn").onclick = () => { const ids = selIds(); if (!ids.length) return log("Select staked hoods first.", "a"); send(() => minerW.unstake(ids), "Unstaking"); };
  $("claimBtn").onclick = () => { const ids = mine.filter((h) => h.rent > 0n).map((h) => h.id); if (!ids.length) return log("No rent to claim yet.", "a"); send(() => minerW.claim(ids), "Claiming rent"); };
  $("burnBtn").onclick = () => {
    const ids = selIds(); if (ids.length !== 1) return log("Select exactly one hood to burn.", "a");
    const h = mine.find((x) => x.id === ids[0]);
    if (!confirm(`Burn HOODZ #${h.id} for ${Math.round(Number(E.formatEther(h.reward)))} $HOODZ? It is gone forever.`)) return;
    send(() => minerW.burn(h.id), "Burning");
  };
  $("runBuyback").onclick = () => send(() => new E.Contract(cfg.buyback, BB_ABI, signer).run(), "Buyback");

  $("connectBtn").onclick = () => connect().catch((e) => log(errMsg(e), "r"));
  $("mineBtn").onclick = () => startMining().catch((e) => log(errMsg(e), "r"));
  $("stopBtn").onclick = stopMining;
  if (cfg.token) $("tradeLink").href = `https://app.uniswap.org/swap?chain=robinhood&inputCurrency=NATIVE&outputCurrency=${cfg.token}`;
  $("links").innerHTML = ready ? [["HOODZ", cfg.miner], ["$HOODZ", cfg.token], ["Buyback", cfg.buyback], ["Locker", cfg.locker]]
    .filter((x) => x[1]).map(([n, a]) => `<a href="${cfg.explorer}/address/${a}" target="_blank" rel="noopener">${n}</a>`).join(" · ") : "";
  log(gpuOk ? "Rig ready. GPU available." : "Rig ready. CPU mining.", "a");
  if (ready) { refresh(); setInterval(refresh, 5000); } else log("Contracts are not set yet.", "r");
})();
