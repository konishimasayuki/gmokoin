import { K, redis } from "./redis.js";
import { businessDate } from "./util.js";

const BASE = "https://forex-api.coin.z.com/public";
const DAY = 24 * 3600 * 1000;

export const INTERVAL_MS = { "1min": 60000, "5min": 300000, "1hour": 3600000 };

async function get(path) {
  const r = await fetch(BASE + path, { headers: { accept: "application/json" } });
  let j = null;
  try {
    j = await r.json();
  } catch {
    j = null;
  }
  if (!r.ok || !j || j.status !== 0) {
    const msg = j?.messages ? JSON.stringify(j.messages) : `HTTP ${r.status}`;
    throw new Error(`GMOコインAPIエラー: ${msg}`);
  }
  return j.data;
}

export async function getTickers() {
  const d = await get("/v1/ticker");
  const map = {};
  for (const t of d) {
    map[t.symbol] = { ask: Number(t.ask), bid: Number(t.bid), ts: t.timestamp, status: t.status };
  }
  return map;
}

export async function getKlines(symbol, interval, date, priceType = "BID") {
  const q = `?symbol=${symbol}&priceType=${priceType}&interval=${interval}&date=${date}`;
  const d = await get(`/v1/klines${q}`);
  return d.map((k) => ({
    t: Number(k.openTime),
    o: Number(k.open),
    h: Number(k.high),
    l: Number(k.low),
    c: Number(k.close),
  }));
}

// 直近 days 営業日分をまとめて取得（データのない日付は無視）
export async function getRecentKlines(symbol, interval, now, days = 2) {
  const dates = [];
  for (let i = days - 1; i >= 0; i--) dates.push(businessDate(now - i * DAY));
  const uniq = [...new Set(dates)];
  const results = await Promise.all(
    uniq.map((d) => getKlines(symbol, interval, d).catch(() => [])),
  );
  const byT = new Map();
  for (const arr of results) for (const k of arr) byT.set(k.t, k);
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

// 確定足のみ
export function closedOnly(candles, interval, now) {
  const ms = INTERVAL_MS[interval] || 60000;
  return candles.filter((k) => k.t + ms <= now);
}

// 同じ関数インスタンス内のメモリキャッシュ（Redisの転送量とコマンド数を節約）
const mem = new Map();

// 短時間キャッシュ：メモリ → Redis → GMO の順に見る
export async function getCachedKlines(
  symbol,
  interval,
  now,
  { ttlMs = 15000, days = 2, keep = 600 } = {},
) {
  const key = K.klines(symbol, interval);
  const m = mem.get(key);
  if (m && now - m.at < ttlMs) return m.data;
  const cached = await redis.get(key);
  if (cached && now - cached.at < ttlMs && Array.isArray(cached.data)) {
    mem.set(key, cached);
    return cached.data;
  }
  const all = await getRecentKlines(symbol, interval, now, days);
  const data = all.slice(-keep);
  if (data.length) {
    const v = { at: now, data };
    mem.set(key, v);
    await redis.set(key, v, { ex: 300 });
  }
  return data;
}
