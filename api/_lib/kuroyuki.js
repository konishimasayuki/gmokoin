// クロユキ式 WW手法（ルール案 v1 の B章）
// 上位足のトレンドに順張りで、執行足のWトップ（売り）／Wボトム（買い）の早仕掛けを狙う。
// 買いは価格を上下反転した「鏡のチャート」でWトップとして判定し、実際の約定だけ買いで計算する。
import { atr, sma } from "./indicators.js";
import { SESSION_LABEL, aggregate, sessionOf, sizeUnits } from "./strategy.js";
import { feeOf, isCrypto, pnlYen, round } from "./util.js";

const MIN = 60000;
export const METHOD_JP = {
  ww: "WW",
  oshi: "押し戻り",
  flag: "フラッグW",
  sat: "サテライト",
  gotobi: "仲値",
  trend: "トレンドフォロー",
};
// base＝読み込む足（その足をそのまま執行足にする）
export const WW_COMBOS = {
  "1h5m": { base: 5, iv: "5min", upper: 60, mid: 15, exec: 5, label: "1時間足×5分足" },
  "4h15m": { base: 15, iv: "15min", upper: 240, mid: 60, exec: 15, label: "4時間足×15分足" },
};

// ---------- 時間帯（A-7） ----------
function lastSundayUtc(y, m) {
  const d = new Date(Date.UTC(y, m + 1, 0));
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.getTime();
}
function nthSundayUtc(y, m, n) {
  const d = new Date(Date.UTC(y, m, 1));
  const first = (7 - d.getUTCDay()) % 7;
  return Date.UTC(y, m, 1 + first + 7 * (n - 1));
}
export function ukSummer(ts) {
  const y = new Date(ts).getUTCFullYear();
  return ts >= lastSundayUtc(y, 2) + 3600000 && ts < lastSundayUtc(y, 9) + 3600000;
}
export function usSummer(ts) {
  const y = new Date(ts).getUTCFullYear();
  return ts >= nthSundayUtc(y, 2, 2) + 7 * 3600000 && ts < nthSundayUtc(y, 10, 1) + 6 * 3600000;
}
const GOTOBI = new Set([5, 10, 15, 20, 25, 30]);
function jst(ts) {
  const d = new Date(ts + 9 * 3600000);
  return {
    y: d.getUTCFullYear(),
    mo: d.getUTCMonth(),
    day: d.getUTCDate(),
    wd: d.getUTCDay(),
    m: d.getUTCHours() * 60 + d.getUTCMinutes(),
  };
}
function isGotobi(p) {
  if (p.wd === 0 || p.wd === 6) return false;
  if (GOTOBI.has(p.day)) return true;
  if (p.wd === 5) {
    // 土日が5・10日なら金曜が前倒し
    const last = new Date(Date.UTC(p.y, p.mo + 1, 0)).getUTCDate();
    return [1, 2].some((k) => p.day + k <= last && GOTOBI.has(p.day + k));
  }
  return false;
}
function near(m, target, before, after) {
  const d = (((m - target) % 1440) + 1440) % 1440;
  return d <= after || 1440 - d <= before;
}
// 入ってはいけない時間なら理由を返す
export function timeBlock(ts, symbol, side) {
  if (isCrypto(symbol)) return null;
  const p = jst(ts);
  if (p.m >= 300 && p.m < 480) return "早朝";
  const uk = ukSummer(ts);
  if (near(p.m, uk ? 16 * 60 : 17 * 60, 15, 15)) return "ロンドン開場前後";
  if (near(p.m, uk ? 0 : 60, 15, 15)) return "ロンドンフィックス前後";
  // 米雇用統計（第1金曜）
  if (p.wd === 5 && p.day <= 7 && near(p.m, usSummer(ts) ? 21 * 60 + 30 : 22 * 60 + 30, 30, 15))
    return "雇用統計前後";
  if (symbol === "USD_JPY" && side === "SELL" && isGotobi(p) && p.m >= 480 && p.m < 595)
    return "ゴトー日の仲値前";
  return null;
}

// ---------- 共通部品 ----------
// 山と谷（前後n本）。confirm＝確定する足（右側n本がそろった足）
function swings(bars, n) {
  const highs = [];
  const lows = [];
  for (let i = n; i < bars.length - n; i++) {
    let hi = true;
    let lo = true;
    for (let k = 1; k <= n; k++) {
      if (bars[i - k].h > bars[i].h || bars[i + k].h >= bars[i].h) hi = false;
      if (bars[i - k].l < bars[i].l || bars[i + k].l <= bars[i].l) lo = false;
      if (!hi && !lo) break;
    }
    if (hi) highs.push({ i, p: bars[i].h, confirm: i + n });
    if (lo) lows.push({ i, p: bars[i].l, confirm: i + n });
  }
  return { highs, lows };
}

// ダウ理論のトレンド（A-3）：足ごとに 1=上昇 / -1=下降 / 0=不明、押し安値・戻り高値
function dowStates(bars, n) {
  const { highs, lows } = swings(bars, n);
  const out = new Array(bars.length);
  let hi = 0;
  let lo = 0;
  let trend = 0;
  let keyLow = null;
  let keyHigh = null;
  let keyLowI = -1;
  let keyHighI = -1;
  let lastH = null;
  let lastL = null;
  const seenH = [];
  const seenL = [];
  for (let k = 0; k < bars.length; k++) {
    while (hi < highs.length && highs[hi].confirm === k) {
      const h = highs[hi++];
      if (lastH && h.p > lastH.p) {
        const before = seenL.filter((x) => x.i < h.i).at(-1);
        if (before) {
          keyLow = before.p;
          keyLowI = before.i;
        }
        trend = 1;
      }
      lastH = h;
      seenH.push(h);
    }
    while (lo < lows.length && lows[lo].confirm === k) {
      const l = lows[lo++];
      if (lastL && l.p < lastL.p) {
        const before = seenH.filter((x) => x.i < l.i).at(-1);
        if (before) {
          keyHigh = before.p;
          keyHighI = before.i;
        }
        trend = -1;
      }
      lastL = l;
      seenL.push(l);
    }
    const c = bars[k].c;
    if (trend === 1 && keyLow !== null && c < keyLow) {
      trend = -1;
      if (lastH) {
        keyHigh = lastH.p;
        keyHighI = lastH.i;
      }
    } else if (trend === -1 && keyHigh !== null && c > keyHigh) {
      trend = 1;
      if (lastL) {
        keyLow = lastL.p;
        keyLowI = lastL.i;
      }
    }
    out[k] = { trend, keyLow, keyHigh, keyLowI, keyHighI };
  }
  return out;
}

// 目立つ高値・安値のゾーン（A-4）：反応2回以上、または上位足の押し安値・戻り高値
// 右山（Wトップの頂上）が当たるべき抵抗帯（本の「戻り売りは戻り高値と目立つ安値に線を引く」）
//  - 上位足の戻り高値
//  - 割り込まれた過去の安値（ラス押し・レジサポ転換で抵抗に変わった線）
//  - 2回以上反応している過去の高値
//  - 上位足の200SMA
// 買い（Wボトム）は鏡のチャートで同じ判定になる
function zonesAt(tfs, t) {
  const out = [];
  for (const f of tfs) {
    const iNow = f.idxAt(t);
    if (iNow < 0) continue;
    const a = f.atr[iNow] || 0;
    const st = f.dow?.[iNow];
    if (st?.keyHigh) out.push(st.keyHigh);
    if (f.dow && f.sma200?.[iNow]) out.push(f.sma200[iNow]);
    const lows = f.sw.lows.filter((s) => s.confirm <= iNow && iNow - s.i < 300).slice(-20);
    for (const l of lows) {
      let broken = false;
      for (let k = l.confirm + 1; k <= iNow; k++) {
        if (f.bars[k].c < l.p) {
          broken = true;
          break;
        }
      }
      if (broken) out.push(l.p);
    }
    const highs = f.sw.highs.filter((s) => s.confirm <= iNow && iNow - s.i < 300).slice(-20);
    for (const h of highs) {
      if (highs.filter((x) => x !== h && Math.abs(x.p - h.p) <= a * 0.3).length >= 1) out.push(h.p);
    }
  }
  return out;
}

// 3点以上反応する上昇トレンドライン（A-5）。points は古い順の安値（1点目＝ネックライン）
function trendline(points, bars, fromI, toI, tol) {
  if (points.length < 3) return null;
  const p0 = points[0];
  let best = null;
  for (let j = 2; j < points.length; j++) {
    const pj = points[j];
    if (pj.i - p0.i < 6) continue;
    const slope = (pj.p - p0.p) / (pj.i - p0.i);
    if (!(slope > 0)) continue;
    const at = (i) => p0.p + slope * (i - p0.i);
    let touches = 0;
    let lastTouch = -1;
    for (const q of points) {
      if (Math.abs(q.p - at(q.i)) <= tol && q.i - lastTouch >= 3) {
        touches++;
        lastTouch = q.i;
      }
    }
    if (touches < 3) continue;
    let broken = false;
    for (let i = fromI; i <= toI; i++) {
      if (Math.min(bars[i].o, bars[i].c) < at(i) - tol) {
        broken = true;
        break;
      }
    }
    if (broken) continue;
    if (!best || touches > best.touches || (touches === best.touches && pj.i > best.lastI))
      best = { at, touches, lastI: pj.i };
  }
  return best;
}

// ---------- 準備（銘柄ごとに1回） ----------
function mirror(bars) {
  return bars.map((b) => ({ t: b.t, o: -b.o, h: -b.l, l: -b.h, c: -b.c }));
}
function tfPack(bars, minutes, n, withDow) {
  const t = bars.map((b) => b.t);
  let ptr = 0;
  const idxAt = (ts) => {
    // ts時点で確定している最後の足
    const target = ts - minutes * MIN;
    if (ptr >= t.length || t[ptr] > target) ptr = 0;
    while (ptr + 1 < t.length && t[ptr + 1] <= target) ptr++;
    return t[ptr] <= target ? ptr : -1;
  };
  return {
    bars,
    minutes,
    idxAt,
    atr: atr(bars, 14),
    sw: swings(bars, n),
    dow: withDow ? dowStates(bars, n) : null,
    sma20: withDow
      ? sma(
          bars.map((b) => b.c),
          20,
        )
      : null,
    sma200: sma(
      bars.map((b) => b.c),
      200,
    ),
  };
}

export function wwPrep(prep, combo, nExec, nUpper = 6) {
  prep.ww = prep.ww || {};
  const key = `${combo}:${nExec}:${nUpper}`;
  if (prep.ww[key]) return prep.ww[key];
  const c = WW_COMBOS[combo];
  const base = prep.candles;
  const exec = c.exec === c.base ? base : aggregate(base, c.exec);
  const upper = aggregate(base, c.upper);
  const mid = aggregate(base, c.mid);
  const side = (m) => {
    const e = m ? mirror(exec) : exec;
    const u = m ? mirror(upper) : upper;
    const md = m ? mirror(mid) : mid;
    return {
      exec: e,
      execAtr: atr(e, 14),
      big: swings(e, nExec),
      small: swings(e, 2),
      upper: tfPack(u, c.upper, nUpper, true),
      mid: tfPack(md, c.mid, nUpper, false),
    };
  };
  const out = { combo: c, exec, execAtr: atr(exec, 14), sell: side(false), buy: side(true) };
  prep.ww[key] = out;
  return out;
}

// i が [from, to] の山谷（i順）を二分探索で取り出す
function range(list, from, to, confirmBy) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].i < from) lo = mid + 1;
    else hi = mid;
  }
  const out = [];
  for (let k = lo; k < list.length && list[k].i <= to; k++)
    if (list[k].confirm <= confirmBy) out.push(list[k]);
  return out;
}

// ---------- Wトップの判定（売り目線。買いは鏡のチャートで同じ判定） ----------
export function detect(v, i, gp, used) {
  const bars = v.exec;
  const a = v.execAtr[i];
  if (!a) return null;
  // ネックラインCの候補：直近160本の谷（新しい順）
  const lowsC = range(v.big.lows, i - 160, i, i).reverse();
  for (const C of lowsC) {
    // 左山の第1高値B：Cの前100本で一番高い山
    let B = null;
    for (const h of range(v.big.highs, C.i - 100, C.i - 1, i)) if (!B || h.p > B.p) B = h;
    if (!B) continue;
    // 左山の起点A：本数20〜100、深さ半分以上、ネックラインに一番近い安値
    let A = null;
    for (const s of range(v.big.lows, C.i - 100, B.i - 1, i)) {
      const nb = C.i - s.i;
      if (nb < 20 || nb > 100) continue;
      if (B.p - s.p < 0.5 * (B.p - C.p)) continue;
      let maxH = Number.NEGATIVE_INFINITY;
      for (let k = s.i; k <= C.i; k++) maxH = Math.max(maxH, bars[k].h);
      if (maxH > B.p + 1e-12) continue;
      if (!A || Math.abs(s.p - C.p) < Math.abs(A.p - C.p)) A = s;
    }
    if (!A) continue;
    // 同じ左山の高値Bでは1回しか入らない（Wが崩れたらそのWは終わり）
    const id = `B${B.i}`;
    if (used.has(id)) continue;
    const left = C.i - A.i;
    const elapsed = i - C.i;
    if (elapsed < 0.5 * left) continue;
    if (elapsed > left) continue; // 期限切れ（見送り）
    // 右山：Cより下に行っていない、Dの高さは左山の50〜150%
    let D = Number.NEGATIVE_INFINITY;
    let dI = -1;
    let minL = Number.POSITIVE_INFINITY;
    for (let k = C.i + 1; k <= i; k++) {
      if (bars[k].h > D) {
        D = bars[k].h;
        dI = k;
      }
      minL = Math.min(minL, bars[k].l);
    }
    if (minL <= C.p || dI < C.i + 3) continue;
    const ratio = (D - C.p) / (B.p - C.p);
    if (ratio < 0.5 || ratio > 1.5) continue;
    // 右山の中のミニWトップ
    const hs = range(v.small.highs, C.i + 1, i, i);
    if (hs.length < 2) continue;
    const h2 = hs.at(-1);
    const h1 = hs.at(-2);
    let m = Number.POSITIVE_INFINITY;
    for (let k = h1.i + 1; k < h2.i; k++) m = Math.min(m, bars[k].l);
    if (!Number.isFinite(m)) continue;
    // ミニWトップは右山の頂上付近の小さなW（山は上位20%、ネックラインも上位35%以内）
    const top = C.p + 0.8 * (D - C.p);
    if (h1.p < top || h2.p < top) continue;
    if (m < C.p + 0.65 * (D - C.p)) continue;
    const r2 = (h2.p - m) / (h1.p - m);
    if (!(r2 >= 0.5 && r2 <= 1.5)) continue;
    if (i - h2.i > 12) continue;
    // 3点反応のトレンドライン（Cから右山までの安値）
    const pts = [C, ...range(v.small.lows, C.i + 2, i, i)];
    const tl = trendline(pts, bars, C.i, i, a * gp.tlTol);
    if (!tl) continue;
    const trig = Math.min(m, tl.at(i + 1));
    if (bars[i].c <= trig) continue; // すでに割れている（出遅れ）
    return { id, trig, D, left, dI, touches: tl.touches, A, B, C, m };
  }
  return null;
}

// ---------- 押し戻り手法・フラッグW（売り目線。買いは鏡のチャート） ----------
function execIndexAt(bars, t) {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (bars[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// 上位足の戻り高値H0から直近安値Lwへの下げに対して、どれだけ戻したか
function pullback(v, i, ui, gp) {
  const st = v.upper.dow[ui];
  if (st.keyHigh === null || st.keyHighI < 0) return null;
  const bars = v.exec;
  const H0 = st.keyHigh;
  const from = execIndexAt(bars, v.upper.bars[st.keyHighI].t);
  if (i - from < 12) return null;
  let Lw = Number.POSITIVE_INFINITY;
  let iLw = -1;
  for (let k = from; k <= i; k++) {
    if (bars[k].l < Lw) {
      Lw = bars[k].l;
      iLw = k;
    }
  }
  if (iLw < 0 || i - iLw < 6 || H0 - Lw <= 0) return null;
  let top = Number.NEGATIVE_INFINITY;
  for (let k = iLw; k <= i; k++) top = Math.max(top, bars[k].h);
  if (top >= H0) return null; // 戻り高値を超えた＝前提が崩れた
  const r = (top - Lw) / (H0 - Lw);
  if (r < gp.fib) return null;
  return { H0, Lw, iLw, top, r, fibLine: Lw + gp.fib * (H0 - Lw) };
}

// 戻りの先端にできたWトップ（執行足）
function wTopAt(v, i, from, minPrice) {
  const bars = v.exec;
  const hs = range(v.small.highs, from + 1, i, i);
  if (hs.length < 2) return null;
  const h2 = hs.at(-1);
  const h1 = hs.at(-2);
  if (i - h2.i > 12 || h1.p < minPrice || h2.p < minPrice) return null;
  let m = Number.POSITIVE_INFINITY;
  for (let k = h1.i + 1; k < h2.i; k++) m = Math.min(m, bars[k].l);
  if (!Number.isFinite(m)) return null;
  const r2 = (h2.p - m) / (h1.p - m);
  if (!(r2 >= 0.5 && r2 <= 1.5)) return null;
  return { h1, h2, m, D: Math.max(h1.p, h2.p) };
}

export function detectOshi(v, i, ui, gp, used) {
  const pb = pullback(v, i, ui, gp);
  if (!pb) return null;
  const id = `O${pb.iLw}`;
  if (used.has(id)) return null;
  const a = v.execAtr[i];
  const w = wTopAt(v, i, pb.iLw, pb.fibLine);
  if (!w) return null;
  const pts = [{ i: pb.iLw, p: pb.Lw }, ...range(v.small.lows, pb.iLw + 2, i, i)];
  const tl = trendline(pts, v.exec, pb.iLw, i, a * gp.tlTol);
  if (!tl) return null;
  const trig = Math.min(w.m, tl.at(i + 1));
  if (v.exec[i].c <= trig) return null;
  if (w.D - trig > 4 * a) return null; // 押し目・戻りから遠すぎる
  return {
    id,
    trig,
    D: w.D,
    left: null,
    dI: w.h1.p >= w.h2.p ? w.h1.i : w.h2.i,
    touches: tl.touches,
    A: { i: pb.iLw, p: pb.Lw },
    B: w.h1,
    C: { i: w.h1.i, p: w.m },
    m: w.m,
  };
}

export function detectFlag(v, i, ui, gp, used) {
  const pb = pullback(v, i, ui, gp);
  if (!pb) return null;
  const id = `F${pb.iLw}`;
  if (used.has(id)) return null;
  const a = v.execAtr[i];
  const tol = a * gp.tlTol;
  const hs = range(v.small.highs, pb.iLw + 1, i, i);
  const ls = [{ i: pb.iLw, p: pb.Lw }, ...range(v.small.lows, pb.iLw + 1, i, i)];
  if (hs.length < 2 || ls.length < 2) return null;
  const line = (p0, p1) => {
    const sl = (p1.p - p0.p) / (p1.i - p0.i);
    return { sl, at: (k) => p0.p + sl * (k - p0.i) };
  };
  const up = line(hs[0], hs.at(-1));
  const lo = line(ls[0], ls.at(-1));
  if (!(up.sl > 0 && lo.sl > 0)) return null; // 下降トレンド中の上向きフラッグ
  if (Math.abs(up.sl - lo.sl) > 0.25 * Math.max(up.sl, lo.sl)) return null; // 平行
  const upHits = hs.filter((h) => Math.abs(h.p - up.at(h.i)) <= tol).length;
  const loHits = ls.filter((l) => Math.abs(l.p - lo.at(l.i)) <= tol).length;
  if (upHits < 2 || loHits < 2) return null;
  if (hs.some((h) => h.p > up.at(h.i) + tol) || ls.some((l) => l.p < lo.at(l.i) - tol)) return null;
  const w = wTopAt(v, i, pb.iLw, pb.Lw + 0.3 * (pb.top - pb.Lw));
  if (!w) return null;
  const trig = Math.min(w.m, lo.at(i + 1));
  if (v.exec[i].c <= trig) return null;
  if (w.D - trig > 4 * a) return null;
  return {
    id,
    trig,
    D: w.D,
    left: null,
    dI: w.h2.i,
    touches: loHits * 10 + upHits,
    A: { i: pb.iLw, p: pb.Lw },
    B: w.h1,
    C: { i: w.h1.i, p: w.m },
    m: w.m,
  };
}

// ---------- バックテスト ----------
export function simulateWW(prep, gp, env) {
  const { spread, conv, pip, fromTs, toTs, slip = 0, symbol, cfg } = env;
  const W = wwPrep(prep, gp.combo, gp.nExec);
  const tfMs = W.combo.exec * MIN;
  const bars = W.exec;
  const trades = [];
  const used = { SELL: new Set(), BUY: new Set() };
  let pos = null;
  let armed = null;
  let equity = cfg.paperBalance;
  let peak = 0;
  let mtmDd = 0;
  let realized = 0;
  // 本と同じ「損失額固定・ロット変動」（資金の riskPct %）
  const scfg = {
    ...cfg,
    sizingMode: "risk",
    riskPct: cfg.sizingMode === "risk" ? cfg.riskPct : 0.5,
    maxUnits: Math.max(cfg.maxUnits || 0, 1000000),
  };

  const close = (exit, reason, t) => {
    const dir = pos.side === "BUY" ? 1 : -1;
    const fee = feeOf(symbol, pos.units, cfg);
    const net = round(pnlYen(pos.side, pos.entry, exit, pos.units, conv) - fee, 0);
    trades.push({
      side: pos.side,
      setup: `${METHOD_JP[gp.method || "ww"]}${pos.side === "BUY" ? "買い" : "売り"}`,
      session: SESSION_LABEL[sessionOf(pos.openedAt)] || "その他",
      units: pos.units,
      entry: pos.entry,
      exit,
      reason,
      openedAt: pos.openedAt,
      closedAt: t,
      pips: round((dir * (exit - pos.entry)) / pip, 1),
      net,
      fee,
      touches: pos.touches,
      sl: pos.sl,
      tp: pos.tp,
      ww: pos.ww,
    });
    equity += net;
    realized += net;
    pos = null;
  };

  for (let i = 30; i < bars.length - 1; i++) {
    const b = bars[i];
    const t = b.t;
    if (t >= toTs) break;
    const tEnd = t + tfMs;

    // 1) 待機中の逆指値（トリガー）
    if (!pos && armed && t >= fromTs) {
      const { side, trig } = armed;
      const bidTrig = side === "SELL" ? trig : -trig; // 鏡のチャートから実際の価格へ
      let entry = null;
      if (side === "SELL") {
        if (b.o <= bidTrig) entry = b.o;
        else if (b.l <= bidTrig) entry = bidTrig;
        if (entry !== null) entry -= slip;
      } else {
        const askTrig = bidTrig; // 買いは ask で判定
        if (b.o + spread >= askTrig) entry = b.o + spread;
        else if (b.h + spread >= askTrig) entry = askTrig;
        if (entry !== null) entry += slip;
      }
      if (entry !== null && !timeBlock(t, symbol, side)) {
        const D = side === "SELL" ? armed.D : -armed.D;
        const buf = spread * gp.slBuf;
        const sl = side === "SELL" ? D + spread + buf : D - buf;
        const slDist = Math.abs(entry - sl);
        const tp = side === "SELL" ? entry - slDist * gp.rr : entry + slDist * gp.rr;
        const size =
          slDist > spread * 2
            ? sizeUnits({ cfg: scfg, equity, slDist, conv, symbol, price: entry })
            : { units: 0 };
        if (size.units > 0) {
          pos = {
            side,
            entry,
            sl,
            tp,
            units: size.units,
            openedAt: t,
            i0: i,
            left: armed.left,
            touches: armed.touches,
            ww: (() => {
              const px = (p) => round(side === "SELL" ? p : -p, 5);
              const at = (k) => bars[k]?.t;
              return {
                A: [at(armed.A.i), px(armed.A.p)],
                B: [at(armed.B.i), px(armed.B.p)],
                C: [at(armed.C.i), px(armed.C.p)],
                D: [at(armed.dI), px(armed.D)],
                miniNeck: px(armed.m),
                touches: armed.touches,
              };
            })(),
          };
          used[side].add(armed.id);
          // 同じ足で損切りに届いていれば損切り（保守的）
          const hitSl = side === "SELL" ? b.h + spread >= sl : b.l <= sl;
          if (hitSl) close(sl, "損切り", tEnd);
        }
      }
      armed = null;
    }

    // 2) 保有中の決済
    if (pos && pos.i0 !== i) {
      const sell = pos.side === "SELL";
      const hi = sell ? b.h + spread : b.h;
      const lo = sell ? b.l + spread : b.l;
      if (sell ? hi >= pos.sl : lo <= pos.sl)
        close(sell ? pos.sl + slip : pos.sl - slip, "損切り", tEnd);
      else if (sell ? lo <= pos.tp : hi >= pos.tp) close(pos.tp, "利確", tEnd);
      else {
        const held = i - pos.i0;
        const left = pos.left || 40; // 押し戻り・フラッグWは時間ルールなし（最長200本で打ち切り）
        if (pos.left && held >= 2.5 * left && (sell ? lo <= pos.entry : hi >= pos.entry))
          close(pos.entry, "建値撤退", tEnd);
        else if (held >= 5 * left) close(sell ? b.c + spread : b.c, "時間切れ", tEnd);
      }
    }

    // 3) 次の足のためのセットアップ判定（上位足のトレンドに順張り）
    if (!pos && t >= fromTs - 3 * 86400000) {
      armed = null;
      for (const side of ["SELL", "BUY"]) {
        const v = side === "SELL" ? W.sell : W.buy;
        const ui = v.upper.idxAt(tEnd);
        if (ui < 0) continue;
        const st = v.upper.dow[ui];
        if (st.trend !== -1) continue; // 鏡のチャートでは買い＝下降に見える
        if (
          gp.sma &&
          !(
            v.upper.sma20[ui] < v.upper.sma20[Math.max(0, ui - 3)] &&
            v.upper.sma200[ui] < v.upper.sma200[Math.max(0, ui - 3)]
          )
        )
          continue;
        // 指標などの急変直後は見送り（直近6本に、平均の3倍を超える足がある）
        if (gp.spike !== false) {
          const a0 = W.execAtr[i];
          let spiky = false;
          for (let k = Math.max(0, i - 5); k <= i; k++)
            if (a0 && bars[k].h - bars[k].l > 3 * a0) spiky = true;
          if (spiky) continue;
        }
        const method = gp.method || "ww";
        const s =
          method === "oshi"
            ? detectOshi(v, i, ui, gp, used[side])
            : method === "flag"
              ? detectFlag(v, i, ui, gp, used[side])
              : detect(v, i, gp, used[side]);
        if (!s) continue;
        if (gp.level) {
          const zs = zonesAt([v.upper, v.mid], tEnd);
          const tol = (v.mid.atr[v.mid.idxAt(tEnd)] || v.execAtr[i]) * 0.3;
          if (!zs.some((z) => Math.abs(z - s.D) <= tol)) continue;
        }
        armed = { side, ...s };
        break;
      }
    }

    // 時価評価のドローダウン
    let eq = realized;
    if (pos)
      eq += pnlYen(pos.side, pos.entry, pos.side === "SELL" ? b.c + spread : b.c, pos.units, conv);
    if (eq > peak) peak = eq;
    if (peak - eq > mtmDd) mtmDd = peak - eq;
  }
  if (pos)
    close(
      pos.side === "SELL" ? bars.at(-1).c + spread : bars.at(-1).c,
      "期間終了で時価評価",
      bars.at(-1).t + tfMs,
    );
  return { trades, mtmDd: round(mtmDd, 0) };
}

export function wwCombos() {
  const out = [];
  for (const combo of Object.keys(WW_COMBOS))
    for (const nExec of [3, 4])
      for (const level of [true, false])
        for (const sma of [false, true])
          out.push({
            strategy: "ww",
            combo,
            nExec,
            level,
            rr: 1,
            sma,
            tlTol: 0.25,
            slBuf: 1,
            spike: true,
          });
  return out;
}

export function oshiCombos() {
  const out = [];
  for (const combo of Object.keys(WW_COMBOS))
    for (const fib of [0.5, 0.382])
      for (const level of [true, false])
        out.push({
          strategy: "ww",
          method: "oshi",
          combo,
          nExec: 3,
          fib,
          level,
          rr: 1,
          sma: false,
          tlTol: 0.25,
          slBuf: 1,
          spike: true,
        });
  return out;
}

export function flagCombos() {
  const out = [];
  for (const combo of Object.keys(WW_COMBOS))
    for (const fib of [0.5, 0.382])
      for (const level of [true, false])
        out.push({
          strategy: "ww",
          method: "flag",
          combo,
          nExec: 3,
          fib,
          level,
          rr: 1,
          sma: false,
          tlTol: 0.25,
          slBuf: 1,
          spike: true,
        });
  return out;
}

export function wwNeighbors(p) {
  return [
    { ...p, nExec: p.nExec === 3 ? 4 : 3 },
    { ...p, tlTol: 0.15 },
    { ...p, tlTol: 0.35 },
    { ...p, rr: p.rr === 1 ? 1.2 : 1 },
    { ...p, slBuf: 0 },
    { ...p, slBuf: 2 },
    { ...p, sma: !p.sma },
    { ...p, spike: false },
  ];
}

export function wwLabel(p) {
  if (p.method === "oshi" || p.method === "flag")
    return `クロユキ${METHOD_JP[p.method]}・${WW_COMBOS[p.combo].label}・フィボ${p.fib}以上${p.level ? "・上位足の抵抗帯・支持帯あり" : ""}・利確${p.rr}倍`;
  return `クロユキWW・${WW_COMBOS[p.combo].label}・山谷${p.nExec}本・${p.level ? "上位足の抵抗帯・支持帯あり" : "水平線なし"}${p.sma ? "・20/200SMAの向き" : ""}・利確${p.rr}倍${p.spike === false ? "・急変フィルターなし" : ""}`;
}

// ---------- 手法③ サテライト・スキャルピング（1分足、ルール案 E章） ----------
function rci(values, n) {
  const out = new Array(values.length).fill(null);
  const denom = n * (n * n - 1);
  for (let i = n - 1; i < values.length; i++) {
    const w = [];
    for (let k = 0; k < n; k++) w.push({ v: values[i - k], t: k + 1 }); // t: 新しい順の順位
    const sorted = [...w].sort((a, b) => b.v - a.v);
    let d2 = 0;
    sorted.forEach((x, r) => {
      d2 += (x.t - (r + 1)) ** 2;
    });
    out[i] = (1 - (6 * d2) / denom) * 100;
  }
  return out;
}

function stdevBands(closes, n, k) {
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const mid = new Array(closes.length).fill(null);
  for (let i = n - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += closes[j];
    const m = s / n;
    let v = 0;
    for (let j = i - n + 1; j <= i; j++) v += (closes[j] - m) ** 2;
    const sd = Math.sqrt(v / n);
    mid[i] = m;
    upper[i] = m + k * sd;
    lower[i] = m - k * sd;
  }
  return { upper, lower, mid };
}

export function satCombos() {
  const out = [];
  for (const dirBars of [3, 5])
    for (const sma of [false, true])
      out.push({ strategy: "ww", method: "sat", dirBars, sma, slBuf: 1, spike: true, rr: 0 });
  return out;
}

export function satLabel(p) {
  return `クロユキサテライト・1分足RCI12＋5分/15分RCI25（向き${p.dirBars}本）${p.sma ? "・20SMAの向き" : ""}・2分割決済`;
}

export function simulateSat(candles, gp, env) {
  const { spread, conv, pip, fromTs, toTs, slip = 0, symbol, cfg } = env;
  const m1 = candles;
  const c1 = m1.map((b) => b.c);
  const r12 = rci(c1, 12);
  const bb = stdevBands(c1, 20, 2);
  const a1 = atr(m1, 14);
  const m5 = aggregate(m1, 5);
  const m15 = aggregate(m1, 15);
  const r5 = rci(
    m5.map((b) => b.c),
    25,
  );
  const r15 = rci(
    m15.map((b) => b.c),
    25,
  );
  const s5 = sma(
    m5.map((b) => b.c),
    20,
  );
  const s15 = sma(
    m15.map((b) => b.c),
    20,
  );
  // 1分足の時点で確定している5分足・15分足の位置
  const map = (bigBars, minutes) => {
    const out = new Int32Array(m1.length).fill(-1);
    let j = -1;
    for (let i = 0; i < m1.length; i++) {
      const tEnd = m1[i].t + MIN;
      while (j + 1 < bigBars.length && bigBars[j + 1].t + minutes * MIN <= tEnd) j++;
      out[i] = j;
    }
    return out;
  };
  const i5 = map(m5, 5);
  const i15 = map(m15, 15);
  const scfg = {
    ...cfg,
    sizingMode: "risk",
    riskPct: cfg.sizingMode === "risk" ? cfg.riskPct : 0.5,
    maxUnits: Math.max(cfg.maxUnits || 0, 1000000),
  };
  const trades = [];
  let pos = null;
  let equity = cfg.paperBalance;
  let realized = 0;
  let peak = 0;
  let mtmDd = 0;
  const dirOf = (arr, j, k) =>
    j - k >= 0 && arr[j] !== null && arr[j - k] !== null ? Math.sign(arr[j] - arr[j - k]) : 0;

  const finish = (t) => {
    const fee = feeOf(symbol, pos.units, cfg);
    const net = round(pos.pnl - fee, 0);
    trades.push({
      side: pos.side,
      setup: `サテライト${pos.side === "BUY" ? "買い" : "売り"}`,
      session: SESSION_LABEL[sessionOf(pos.openedAt)] || "その他",
      units: pos.units,
      entry: pos.entry,
      exit: pos.lastExit,
      reason: pos.reasons.join("＋"),
      openedAt: pos.openedAt,
      closedAt: t,
      pips: round(pos.pipsSum / 2, 1),
      net,
      fee,
      sl: pos.sl,
      tp: null,
    });
    equity += net;
    realized += net;
    pos = null;
  };
  const exitPart = (share, px, reason, t) => {
    const dir = pos.side === "BUY" ? 1 : -1;
    pos.pnl += pnlYen(pos.side, pos.entry, px, pos.units * share, conv);
    pos.pipsSum += ((dir * (px - pos.entry)) / pip) * (share * 2);
    pos.left -= share;
    pos.lastExit = px;
    pos.reasons.push(reason);
    if (pos.left <= 1e-9) finish(t);
  };

  for (let i = 30; i < m1.length; i++) {
    const b = m1[i];
    if (b.t >= toTs) break;
    const tEnd = b.t + MIN;
    if (pos) {
      const buy = pos.side === "BUY";
      const bidLow = b.l;
      const askHigh = b.h + spread;
      if (buy ? bidLow <= pos.sl : askHigh >= pos.sl)
        exitPart(pos.left, buy ? pos.sl - slip : pos.sl + slip, "損切り", tEnd);
      else {
        if (!pos.h1Done && r12[i] !== null && (buy ? r12[i] >= 80 : r12[i] <= -80)) {
          pos.h1Done = true;
          exitPart(0.5, buy ? b.c : b.c + spread, "RCI反対側", tEnd);
        }
        if (pos && !pos.h2Done && bb.upper[i] !== null) {
          const band = buy ? bb.upper[i] : bb.lower[i];
          if (buy ? b.h >= band : b.l + spread <= band) {
            pos.h2Done = true;
            exitPart(0.5, band, "反対側の2σ", tEnd);
          }
        }
        if (pos && i - pos.i0 >= 10) exitPart(pos.left, buy ? b.c : b.c + spread, "時間切れ", tEnd);
      }
    }
    if (!pos && b.t >= fromTs && r12[i] !== null && r12[i - 1] !== null) {
      for (const side of ["BUY", "SELL"]) {
        const buy = side === "BUY";
        const crossed = buy ? r12[i - 1] <= -80 && r12[i] > -80 : r12[i - 1] >= 80 && r12[i] < 80;
        if (!crossed) continue;
        const want = buy ? 1 : -1;
        if (dirOf(r5, i5[i], gp.dirBars) !== want || dirOf(r15, i15[i], gp.dirBars) !== want)
          continue;
        if (gp.sma && (dirOf(s5, i5[i], 3) !== want || dirOf(s15, i15[i], 3) !== want)) continue;
        if (timeBlock(tEnd, symbol, side)) continue;
        let spiky = false;
        for (let k = Math.max(0, i - 5); k <= i; k++)
          if (a1[i] && m1[k].h - m1[k].l > 3 * a1[i]) spiky = true;
        if (spiky) continue;
        let ext = buy ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
        for (let k = Math.max(0, i - 9); k <= i; k++)
          ext = buy ? Math.min(ext, m1[k].l) : Math.max(ext, m1[k].h + spread);
        const entry = buy ? b.c + spread + slip : b.c - slip;
        const sl = buy ? ext - spread * gp.slBuf : ext + spread * gp.slBuf;
        const slDist = Math.abs(entry - sl);
        if (!(slDist > spread * 2) || slDist > 3 * (a1[i] || slDist)) continue;
        const size = sizeUnits({ cfg: scfg, equity, slDist, conv, symbol, price: entry });
        if (!size.units) continue;
        pos = {
          side,
          entry,
          sl,
          units: size.units,
          openedAt: tEnd,
          i0: i,
          left: 1,
          pnl: 0,
          pipsSum: 0,
          reasons: [],
          h1Done: false,
          h2Done: false,
          lastExit: entry,
        };
        break;
      }
    }
    let eq = realized;
    if (pos)
      eq +=
        pnlYen(
          pos.side,
          pos.entry,
          pos.side === "BUY" ? b.c : b.c + spread,
          pos.units * pos.left,
          conv,
        ) + pos.pnl;
    if (eq > peak) peak = eq;
    if (peak - eq > mtmDd) mtmDd = peak - eq;
  }
  if (pos) exitPart(pos.left, m1.at(-1).c, "期間終了で時価評価", m1.at(-1).t + MIN);
  return { trades, mtmDd: round(mtmDd, 0) };
}
