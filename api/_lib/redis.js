import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
});

export const K = {
  config: "fxbot:config",
  regime: "fxbot:regime",
  position: "fxbot:position",
  stats: "fxbot:stats",
  tradeIds: "fxbot:trade_ids",
  trade: (id) => `fxbot:trade:${id}`,
  daily: (d) => `fxbot:daily:${d}`,
  dailyKeys: "fxbot:daily_keys",
  logs: "fxbot:logs",
  tickLock: "fxbot:lock:tick",
  regimeLock: "fxbot:lock:regime",
  cooldown: "fxbot:cooldown",
  lastSignal: "fxbot:last_signal",
  klines: (symbol, interval) => `fxbot:kl:${symbol}:${interval}`,
  streak: "fxbot:streak",
  pauseUntil: "fxbot:pause_until",
  levels: (symbol) => `fxbot:levels:${symbol}`,
  brief: (symbol, bd) => `fxbot:brief:${symbol}:${bd}`,
  briefLock: "fxbot:lock:brief",
  report: (kind, key) => `fxbot:report:${kind}:${key}`,
  reportIds: "fxbot:report_ids",
  reportLock: "fxbot:lock:report",
  backtestLast: "fxbot:backtest:last",
  btDay: (symbol, bd) => `fxbot:bt2:${symbol}:${bd}`,
  optimizeLast: "fxbot:optimize:last",
  optSymbol: (symbol) => `fxbot:opt:sym:${symbol}`,
  posOf: (symbol) => `fxbot:pos:${symbol}`,
  brainRegime: (id) => `fxbot:brain:regime:${id}`,
  brainLog: (id) => `fxbot:brain:log:${id}`,
  brainLock: (id) => `fxbot:lock:brain:${id}`,
  shadow: (id) => `fxbot:shadow:${id}`,
  brainStats: (id) => `fxbot:brain:stats:${id}`,
  openSet: "fxbot:open_symbols",
  cooldownOf: (symbol) => `fxbot:cooldown:${symbol}`,
  lastSignalOf: (symbol) => `fxbot:last_signal:${symbol}`,
  optimizeLock: "fxbot:lock:optimize",
};

export async function addLog(msg, level = "info") {
  const entry = { t: Date.now(), level, msg };
  await redis.pipeline().lpush(K.logs, entry).ltrim(K.logs, 0, 99).exec();
}

export async function getLogs(n = 30) {
  const rows = await redis.lrange(K.logs, 0, n - 1);
  return rows.map((r) => (typeof r === "string" ? safeJson(r) : r)).filter(Boolean);
}

// 一覧取得は MGET でまとめて取る
export async function getTrades(n = 30) {
  const ids = await redis.lrange(K.tradeIds, 0, n - 1);
  if (!ids.length) return [];
  const rows = await redis.mget(...ids.map((id) => K.trade(id)));
  return rows.filter(Boolean);
}

export async function acquireLock(key, seconds, retries = 0, waitMs = 300) {
  for (let i = 0; i <= retries; i++) {
    const ok = await redis.set(key, Date.now(), { nx: true, ex: seconds });
    if (ok) return true;
    if (i < retries) await new Promise((r) => setTimeout(r, waitMs));
  }
  return false;
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
