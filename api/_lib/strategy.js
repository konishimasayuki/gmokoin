// ライブ運用とバックテストで共通に使う売買ロジック（副作用なし）
import { ema } from "./indicators.js";
import { MIN_UNITS, clamp, jstParts, round } from "./util.js";

const MIN = 60000;

export const SESSIONS = {
  tokyo: { label: "東京", from: 9 * 60, to: 15 * 60 },
  london: { label: "ロンドン", from: 16 * 60, to: 21 * 60 },
  ny: { label: "NY", from: 21 * 60, to: 26 * 60 },
};

// 時刻(ms)がどの時間帯か。どこにも入らなければ null（早朝・昼休みなど）
export function sessionOf(ts) {
  const p = jstParts(ts);
  const m = p.hh * 60 + p.mm;
  for (const [key, s] of Object.entries(SESSIONS)) {
    if (m >= s.from && m < s.to) return key;
    if (s.to > 1440 && m + 1440 >= s.from && m + 1440 < s.to) return key;
  }
  return null;
}

export function sessionAllowed(ts, cfg) {
  const s = sessionOf(ts);
  return { key: s, ok: Boolean(s && cfg.sessions?.[s]) };
}

export function aggregate(candles, minutes) {
  const ms = minutes * MIN;
  const out = [];
  let cur = null;
  for (const c of candles) {
    const t = Math.floor(c.t / ms) * ms;
    if (!cur || cur.t !== t) {
      cur = { t, o: c.o, h: c.h, l: c.l, c: c.c };
      out.push(cur);
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
    }
  }
  return out;
}

// 上位足（5分足EMA20）の向き。確定済みの5分足だけを使う
export function buildHtf(candles1m) {
  const m5 = aggregate(candles1m, 5);
  return {
    m5,
    e20: ema(
      m5.map((c) => c.c),
      20,
    ),
  };
}

export function htfDirAt(htf, endTs) {
  const { m5, e20 } = htf;
  let lo = 0;
  let hi = m5.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (m5[mid].t + 5 * MIN <= endTs) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (idx < 22 || e20[idx] === null || e20[idx - 2] === null) return 0;
  if (m5[idx].c > e20[idx] && e20[idx] > e20[idx - 2]) return 1;
  if (m5[idx].c < e20[idx] && e20[idx] < e20[idx - 2]) return -1;
  return 0;
}

// シグナル判定（L=確定済み1分足の位置、confirm=現在値の確認用価格(bid)）
export function signalAt({ mode, allow, candles, ind, L, confirm, cfg, htfDir }) {
  const c = candles[L];
  const a = ind.atr14[L];
  const e9 = ind.ema9[L];
  const e21 = ind.ema21[L];
  const e9prev = ind.ema9[L - 3];
  const r = ind.rsi7[L];
  const bb = ind.bb[L];
  if ([a, e9, e21, e9prev, r].some((v) => v === null || v === undefined)) return null;
  const allowLong = allow === "LONG" || allow === "BOTH";
  const allowShort = allow === "SHORT" || allow === "BOTH";
  const htf = cfg.htfFilter;

  if (mode === "TREND_UP" && allowLong && (!htf || htfDir === 1)) {
    if (
      e9 > e21 &&
      e9 > e9prev &&
      c.l <= e9 + 0.2 * a &&
      c.c > e9 &&
      r >= 45 &&
      r <= 72 &&
      confirm > c.c
    )
      return { side: "BUY", setup: "押し目買い" };
  } else if (mode === "TREND_DOWN" && allowShort && (!htf || htfDir === -1)) {
    if (
      e9 < e21 &&
      e9 < e9prev &&
      c.h >= e9 - 0.2 * a &&
      c.c < e9 &&
      r >= 28 &&
      r <= 55 &&
      confirm < c.c
    )
      return { side: "SELL", setup: "戻り売り" };
  } else if (mode === "RANGE" && bb) {
    if (allowLong && (!htf || htfDir !== -1) && c.l <= bb.lo && r < 30 && c.c > c.o)
      return { side: "BUY", setup: "レンジ下限の反発" };
    if (allowShort && (!htf || htfDir !== 1) && c.h >= bb.up && r > 70 && c.c < c.o)
      return { side: "SELL", setup: "レンジ上限の反落" };
  }
  return null;
}

export function slTp({ entry, side, atr, cfg, pip, digits }) {
  const slDist = clamp(atr * cfg.slAtrMult, cfg.slMinPips * pip, cfg.slMaxPips * pip);
  const buy = side === "BUY";
  return {
    slDist,
    sl: round(buy ? entry - slDist : entry + slDist, digits),
    tp: round(buy ? entry + slDist * cfg.rr : entry - slDist * cfg.rr, digits),
  };
}

// 利確までの間に強い水平線（反発2回以上）があれば返す
export function levelInPath(levels, side, entry, tp) {
  if (!levels?.length) return null;
  const lo = Math.min(entry, tp);
  const hi = Math.max(entry, tp);
  const hits = levels.filter((lv) => lv.touches >= 2 && lv.price > lo && lv.price < hi);
  if (!hits.length) return null;
  hits.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));
  return { ...hits[0], side };
}

// 数量：固定 or 資金に対するリスク%
export function sizeUnits({ cfg, equity, slDist, conv }) {
  if (cfg.sizingMode !== "risk") return { units: cfg.units };
  const riskYen = (equity * cfg.riskPct) / 100;
  const perUnit = slDist * conv;
  if (!(perUnit > 0)) return { units: 0, why: "数量を計算できません" };
  const raw = Math.floor(riskYen / perUnit / 1000) * 1000;
  const units = Math.min(raw, cfg.maxUnits);
  if (units < MIN_UNITS) return { units: 0, why: "資金に対して損切り幅が大きすぎます" };
  return { units, riskYen: round(riskYen, 0) };
}

// 1本の足で決済判定。SLとTPが同じ足に入ったら損切り優先（保守的）
export function stepCandle(pos, c, spread) {
  const buy = pos.side === "BUY";
  const timeStopTs = pos.openedAt + (pos.timeStopMin || 15) * MIN;
  if (c.t >= timeStopTs) {
    return { hit: { exit: buy ? c.o : c.o + spread, reason: "時間切れ" } };
  }
  const slReason = pos.beMoved ? "建値決済" : "損切り";
  if (buy) {
    if (c.l <= pos.sl) return { hit: { exit: pos.sl, reason: slReason } };
    if (c.h >= pos.tp) return { hit: { exit: pos.tp, reason: "利確" } };
  } else {
    if (c.h + spread >= pos.sl) return { hit: { exit: pos.sl, reason: slReason } };
    if (c.l + spread <= pos.tp) return { hit: { exit: pos.tp, reason: "利確" } };
  }
  const moved = maybeBreakEven(pos, buy ? c.h : c.l + spread);
  return { hit: null, moved };
}

// 含み益が一定以上なら損切りを建値+0.1pipsへ（posを書き換える）
export function maybeBreakEven(pos, favorablePrice) {
  if (!pos.beOn || pos.beMoved || !pos.beTrigger) return false;
  const buy = pos.side === "BUY";
  const fav = buy ? favorablePrice - pos.entry : pos.entry - favorablePrice;
  if (fav < pos.beTrigger) return false;
  pos.sl = round(buy ? pos.entry + pos.pip * 0.1 : pos.entry - pos.pip * 0.1, pos.digits);
  pos.beMoved = true;
  return true;
}

// バックテスト用：1時間足EMA20/50による機械的な相場判定（Claudeの代用）
export function buildMechanicalRegime(candles1m) {
  const h1 = aggregate(candles1m, 60);
  const closes = h1.map((c) => c.c);
  return { h1, e20: ema(closes, 20), e50: ema(closes, 50) };
}

export function mechanicalRegimeAt(mr, endTs) {
  const { h1, e20, e50 } = mr;
  let idx = -1;
  for (let i = h1.length - 1; i >= 0; i--) {
    if (h1[i].t + 60 * MIN <= endTs) {
      idx = i;
      break;
    }
  }
  if (idx < 0 || e50[idx] === null) return { mode: "NO_TRADE", allow: "NONE" };
  const c = h1[idx].c;
  if (e20[idx] > e50[idx] && c > e20[idx]) return { mode: "TREND_UP", allow: "LONG" };
  if (e20[idx] < e50[idx] && c < e20[idx]) return { mode: "TREND_DOWN", allow: "SHORT" };
  return { mode: "RANGE", allow: "BOTH" };
}
