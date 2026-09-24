// CatASIC RPC helper: spreads visitors across several endpoints and
// switches to the next one automatically when an endpoint fails or is slow.
(function () {
  "use strict";
  window.makeCatProvider = function (cfg) {
    const E = window.ethers;
    const list = (cfg.rpcs && cfg.rpcs.length ? cfg.rpcs : [cfg.rpc]).filter(Boolean);
    const publicRpc = cfg.rpc && !list.includes(cfg.rpc) ? [cfg.rpc] : [];
    // shuffle so each visitor starts on a different key (spreads rate limits)
    const keys = list.slice();
    for (let i = keys.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [keys[i], keys[j]] = [keys[j], keys[i]];
    }
    const urls = keys.concat(publicRpc); // public RPC is the last resort
    if (urls.length === 1) return new E.JsonRpcProvider(urls[0], cfg.chainId, { staticNetwork: true });
    const net = E.Network.from(cfg.chainId);
    const configs = urls.map((u, i) => ({
      provider: new E.JsonRpcProvider(u, net, { staticNetwork: net, batchMaxCount: 1 }),
      priority: i + 1,
      weight: 1,
      stallTimeout: 2500,
    }));
    return new E.FallbackProvider(configs, net, { quorum: 1 });
  };
})();
