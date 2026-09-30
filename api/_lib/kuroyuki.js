// クロユキ式 WW手法（ルール案 v1 の B章）
// 上位足のトレンドに順張りで、執行足のWトップ（売り）／Wボトム（買い）の早仕掛けを狙う。
// 買いは価格を上下反転した「鏡のチャート」でWトップとして判定し、実際の約定だけ買いで計算する。
import { atr, sma } from "./indicators.js";
import { SESSION_LABEL, aggregate, sessionOf, sizeUnits } from "./strategy.js";
import { feeOf, isCrypto, pnlYen, round } from "./util.js";

const MIN = 60000;
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
  let lastH = null;
  let lastL = null;
  const seenH = [];
  const seenL = [];
  for (let k = 0; k < bars.length; k++) {
    while (hi < highs.length && highs[hi].confirm === k) {
      const h = highs[hi++];
      if (lastH && h.p > lastH.p) {
        const before = seenL.filter((x) => x.i < h.i).at(-1);
        if (before) keyLow = before.p;
        trend = 1;
      }
      lastH = h;
      seenH.push(h);
    }
    while (lo < lows.length && lows[lo].confirm === k) {
      const l = lows[lo++];
      if (lastL && l.p < lastL.p) {
        const before = seenH.filter((x) => x.i < l.i).at(-1);
        if (before) keyHigh = before.p;
        trend = -1;
      }
      lastL = l;
      seenL.push(l);
    }
    const c = bars[k].c;
    if (trend === 1 && keyLow !== null && c < keyLow) {
      trend = -1;
      keyHigh = lastH ? lastH.p : keyHigh;
    } else if (trend === -1 && keyHigh !== null && c > keyHigh) {
      trend = 1;
      keyLow = lastL ? lastL.p : keyLow;
    }
    out[k] = { trend, keyLow, keyHigh };
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
      setup: pos.side === "BUY" ? "WW買い" : "WW売り",
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
        if (held >= 2.5 * pos.left && (sell ? lo <= pos.entry : hi >= pos.entry))
          close(pos.entry, "建値撤退", tEnd);
        else if (held >= 5 * pos.left) close(sell ? b.c + spread : b.c, "時間切れ", tEnd);
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
        const s = detect(v, i, gp, used[side]);
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
  return `クロユキWW・${WW_COMBOS[p.combo].label}・山谷${p.nExec}本・${p.level ? "上位足の抵抗帯・支持帯あり" : "水平線なし"}${p.sma ? "・20/200SMAの向き" : ""}・利確${p.rr}倍${p.spike === false ? "・急変フィルターなし" : ""}`;
}
