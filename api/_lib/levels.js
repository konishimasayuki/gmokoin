// 週足・日足から水平線（サポート・レジスタンス）をプログラムで計算する
import { getKlines, getTickers } from "./gmo.js";
import { atr, ema } from "./indicators.js";
import { K, addLog, redis } from "./redis.js";
import { jstParts, pipSize, priceDigits, round } from "./util.js";

const DAY = 24 * 3600 * 1000;
export const LEVELS_TTL_MS = DAY;

async function yearly(symbol, interval, years) {
  const res = await Promise.all(
    years.map((y) => getKlines(symbol, interval, String(y)).catch(() => [])),
  );
  const map = new Map();
  for (const arr of res) for (const k of arr) map.set(k.t, k);
  return [...map.values()].sort((a, b) => a.t - b.t);
}

function pivots(candles, k) {
  const out = [];
  for (let i = k; i < candles.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
    }
    if (isHigh) out.push({ price: candles[i].h, t: candles[i].t, type: "high" });
    if (isLow) out.push({ price: candles[i].l, t: candles[i].t, type: "low" });
  }
  return out;
}

function cluster(points, tol) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const groups = [];
  for (const p of sorted) {
    const g = groups[groups.length - 1];
    if (g && p.price - g.items[g.items.length - 1].price <= tol) g.items.push(p);
    else groups.push({ items: [p] });
  }
  return groups.map((g) => ({
    price: g.items.reduce((s, x) => s + x.price, 0) / g.items.length,
    touches: g.items.length,
    lastTouch: Math.max(...g.items.map((x) => x.t)),
  }));
}

function pickAround(levels, price, n) {
  const above = levels
    .filter((l) => l.price > price)
    .sort((a, b) => a.price - b.price)
    .slice(0, n);
  const below = levels
    .filter((l) => l.price <= price)
    .sort((a, b) => b.price - a.price)
    .slice(0, n);
  return { above, below };
}

function zoneLabel(pct) {
  if (pct < 20) return "長期レンジの下限付近";
  if (pct < 40) return "長期レンジの下側";
  if (pct < 60) return "長期レンジの中央";
  if (pct < 80) return "長期レンジの上側";
  return "長期レンジの上限付近";
}

export async function buildLevels(symbol, now = Date.now()) {
  const y = jstParts(now).y;
  const pip = pipSize(symbol);
  const d = priceDigits(symbol);
  const [tickers, daily, weekly] = await Promise.all([
    getTickers(),
    yearly(symbol, "1day", [y - 1, y]),
    yearly(symbol, "1week", [y - 2, y - 1, y]),
  ]);
  const t = tickers[symbol];
  if (!t) throw new Error(`${symbol}のレートを取得できません`);
  const price = (t.bid + t.ask) / 2;
  if (daily.length < 30) throw new Error("日足データが不足しています");

  // 日足：直近3か月（約66本）の水平線
  const d3m = daily.slice(-66);
  const dAtr = atr(daily, 14).at(-1) || d3m.at(-1).h - d3m.at(-1).l;
  const dLevels = cluster(pivots(d3m, 3), dAtr * 0.35).map((l) => ({
    price: round(l.price, d),
    touches: l.touches,
    lastTouch: l.lastTouch,
    frame: "日足",
  }));

  // 週足：過去2年の長期目線
  const w2y = weekly.slice(-104);
  const wAtr = atr(weekly, 14).at(-1) || dAtr * 2;
  const wLevels = cluster(pivots(w2y, 2), wAtr * 0.3).map((l) => ({
    price: round(l.price, d),
    touches: l.touches,
    lastTouch: l.lastTouch,
    frame: "週足",
  }));
  const wc = weekly.map((c) => c.c);
  const e13 = ema(wc, 13).at(-1);
  const e26 = ema(wc, 26).at(-1);
  const e13p = ema(wc, 13).at(-5);
  let trend = "横ばい";
  if (e13 && e26 && e13p) {
    if (e13 > e26 && e13 > e13p) trend = "上昇";
    else if (e13 < e26 && e13 < e13p) trend = "下降";
  }
  const rangeHigh = w2y.length ? Math.max(...w2y.map((c) => c.h)) : null;
  const rangeLow = w2y.length ? Math.min(...w2y.map((c) => c.l)) : null;
  const positionPct =
    rangeHigh && rangeLow && rangeHigh > rangeLow
      ? round(((price - rangeLow) / (rangeHigh - rangeLow)) * 100, 0)
      : null;

  const dPick = pickAround(dLevels, price, 3);
  const wPick = pickAround(wLevels, price, 2);
  const all = [...dLevels, ...wLevels];

  return {
    symbol,
    at: now,
    price: round(price, d),
    weekly: {
      trend,
      ema13: e13 ? round(e13, d) : null,
      ema26: e26 ? round(e26, d) : null,
      rangeHigh: rangeHigh ? round(rangeHigh, d) : null,
      rangeLow: rangeLow ? round(rangeLow, d) : null,
      positionPct,
      zone: positionPct === null ? "不明" : zoneLabel(positionPct),
      atrPips: round(wAtr / pip, 0),
      above: wPick.above,
      below: wPick.below,
    },
    daily: {
      atrPips: round(dAtr / pip, 0),
      above: dPick.above,
      below: dPick.below,
    },
    // エントリー判定で使う全水平線（反発回数付き）
    all: all.map((l) => ({ price: l.price, touches: l.touches, frame: l.frame })),
  };
}

export async function ensureLevels(symbol, { force = false } = {}) {
  const now = Date.now();
  const cur = await redis.get(K.levels(symbol));
  if (!force && cur && now - cur.at < LEVELS_TTL_MS) return cur;
  const lv = await buildLevels(symbol, now);
  await redis.set(K.levels(symbol), lv, { ex: 60 * 60 * 24 * 8 });
  await addLog(`水平線マップを更新（週足${lv.weekly.trend}・${lv.weekly.zone}）`, "regime");
  return lv;
}

export function levelsSummaryText(lv) {
  if (!lv) return "（水平線マップなし）";
  const f = (arr) => arr.map((l) => `${l.price}（反発${l.touches}回）`).join("、") || "なし";
  return `週足トレンド: ${lv.weekly.trend}／過去2年レンジ ${lv.weekly.rangeLow}〜${lv.weekly.rangeHigh} の${lv.weekly.positionPct}%地点（${lv.weekly.zone}）
週足の主要ライン 上: ${f(lv.weekly.above)} ／ 下: ${f(lv.weekly.below)}
日足（過去3か月）の主要ライン 上: ${f(lv.daily.above)} ／ 下: ${f(lv.daily.below)}
日足ATR: ${lv.daily.atrPips} pips`;
}
