// リピート（グリッド）戦略の検証
// 過去N日の高値〜安値をレンジにして、一定間隔で買い（または売り）を並べ、
// 1〜2マス戻ったら利確を繰り返す。レンジ外の「想定外ライン」に触れたら全決済して翌日まで休む。
// 含み損を含めた最大ドローダウン（時価評価）も記録する。
import { SESSION_LABEL } from "./strategy.js";
import { CRYPTO_STEP, feeOf, isCrypto, pnlYen, round } from "./util.js";

const CRYPTO_CARRY = 0.0004; // 取引所レバレッジの建玉は日をまたぐごとに0.04%（レバレッジ手数料）

function unitsPerLine({ symbol, equity, riskPct, sumDist, conv, price, levels }) {
  const riskYen = (equity * riskPct) / 100;
  let u = riskYen / (sumDist * conv);
  const lev = isCrypto(symbol) ? 2 : 25;
  const cap = (equity * lev) / (levels * price * conv);
  u = Math.min(u, cap);
  if (isCrypto(symbol)) {
    const step = CRYPTO_STEP[symbol] || 0.01;
    u = Math.floor(u / step + 1e-9) * step;
    return u >= step ? round(u, 6) : 0;
  }
  u = Math.floor(u / 1000) * 1000;
  // GMOコインFXの最小数量（1万通貨）に満たなければ1万通貨で入る（リスクは設定より大きくなる）
  return Math.max(u, 10000);
}

export function simulateGrid(prep, gp, env) {
  const { m5, m5bd, m5reg, m5ses, days } = prep;
  const { spread, conv, pip, fromTs, toTs, slip = 0, symbol, cfg } = env;
  const crypto = isCrypto(symbol);
  const trades = [];
  let open = [];
  let realized = 0;
  let peak = 0;
  let mtmDd = 0;
  let equity = cfg.paperBalance;
  let grid = null; // { dir, lines:[{price,tp}], stop, units }
  let pausedBd = null;
  let curBd = null;
  let dayIdx = -1;

  const closePos = (p, exit, reason, t) => {
    const dir = p.side === "BUY" ? 1 : -1;
    const fee = feeOf(symbol, p.units, cfg) + (p.carry || 0);
    const net = round(pnlYen(p.side, p.entry, exit, p.units, conv) - fee, 0);
    realized += net;
    equity += net;
    trades.push({
      side: p.side,
      setup: p.side === "BUY" ? "リピート買い" : "リピート売り",
      session: SESSION_LABEL[p.ses] || "不明",
      units: p.units,
      entry: p.entry,
      exit,
      reason,
      openedAt: p.openedAt,
      closedAt: t,
      pips: round((dir * (exit - p.entry)) / pip, 1),
      net,
      fee: round(fee, 0),
    });
  };

  for (let k = 0; k < m5.length; k++) {
    const c = m5[k];
    if (c.t >= toTs) break;
    const bd = m5bd[k];
    if (!bd) continue;
    const t = c.t + 5 * 60000;

    // 日が変わったらレンジを作り直す（保有中のポジションはそのまま）
    if (bd !== curBd) {
      curBd = bd;
      while (dayIdx + 1 < days.length && days[dayIdx + 1].bd <= bd) dayIdx++;
      if (crypto)
        for (const p of open) p.carry = (p.carry || 0) + p.entry * p.units * conv * CRYPTO_CARRY;
      grid = null;
      const past = days.slice(Math.max(0, dayIdx - gp.lookbackDays), dayIdx);
      if (past.length >= Math.min(3, gp.lookbackDays) && c.t >= fromTs) {
        const hi = Math.max(...past.map((d) => d.hi));
        const lo = Math.min(...past.map((d) => d.lo));
        const step = (hi - lo) / gp.levels;
        if (step > spread * 4) {
          let dir = gp.dir;
          if (dir === "auto") {
            const r = m5reg[k];
            if (r?.mode === "TREND_UP") dir = "long";
            else if (r?.mode === "TREND_DOWN") dir = "short";
            else dir = c.o < (hi + lo) / 2 ? "long" : "short";
          }
          const lines = [];
          for (let i = 0; i < gp.levels; i++) {
            const price = dir === "long" ? lo + step * i : hi - step * i;
            lines.push({
              price,
              tp: dir === "long" ? price + step * gp.tpSteps : price - step * gp.tpSteps,
            });
          }
          const stop = dir === "long" ? lo - step * gp.stopSteps : hi + step * gp.stopSteps;
          const sumDist = lines.reduce((s, l) => s + Math.abs(l.price - stop), 0);
          const units = unitsPerLine({
            symbol,
            equity,
            riskPct: gp.riskPct,
            sumDist,
            conv,
            price: c.o,
            levels: gp.levels,
          });
          if (units > 0) grid = { dir, lines, stop, units };
        }
      }
    }

    // 1) 決済：想定外ラインに触れたら残り全部を決済、それ以外は利確
    if (open.length) {
      const remain = [];
      let stopHit = false;
      for (const p of open) {
        const buy = p.side === "BUY";
        if (buy ? c.l <= p.stop : c.h + spread >= p.stop) {
          stopHit = true;
          remain.push(p);
          continue;
        }
        const hitTp = p.k < k && (buy ? c.h >= p.tp : c.l + spread <= p.tp);
        if (hitTp) closePos(p, p.tp, "利確", t);
        else remain.push(p);
      }
      if (stopHit) {
        for (const p of remain)
          closePos(p, p.side === "BUY" ? p.stop - slip : p.stop + slip, "想定外ラインで全決済", t);
        open = [];
        pausedBd = bd;
        grid = null;
      } else open = remain;
    }

    // 2) 新規：まだ持っていないマスに価格が触れたら約定（同じ足では利確しない）
    if (grid && pausedBd !== bd && c.t >= fromTs) {
      for (const line of grid.lines) {
        if (open.some((p) => p.line === line)) continue;
        const buy = grid.dir === "long";
        const touched = buy
          ? c.l + spread <= line.price && c.h + spread >= line.price
          : c.h >= line.price && c.l <= line.price;
        if (!touched) continue;
        open.push({
          side: buy ? "BUY" : "SELL",
          entry: buy ? line.price + slip : line.price - slip,
          tp: line.tp,
          stop: grid.stop,
          units: grid.units,
          openedAt: t,
          k,
          line,
          ses: m5ses[k],
        });
      }
    }

    // 3) 時価評価（含み損込み）のドローダウン
    let unreal = 0;
    for (const p of open) {
      const px = p.side === "BUY" ? c.c : c.c + spread;
      unreal += pnlYen(p.side, p.entry, px, p.units, conv) - (p.carry || 0);
    }
    const eq = realized + unreal;
    if (eq > peak) peak = eq;
    if (peak - eq > mtmDd) mtmDd = peak - eq;
  }
  return { trades, mtmDd: round(mtmDd, 0), openAtEnd: open.length };
}
