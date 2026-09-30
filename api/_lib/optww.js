// クロユキWWに絞った検証：1年分の5分足・15分足で、銘柄ごと＋全銘柄まとめて6段階の検証をする
import {
  DAY,
  DEFAULT_SPREAD,
  loadBars,
  loadCandles,
  loadYearBars,
  marketContext,
  metricsOf,
} from "./backtest.js";
import {
  gotobiCombos,
  gotobiLabel,
  simulateGotobi,
  simulateTrend,
  trendCombos,
  trendLabel,
} from "./flows.js";
import {
  METHOD_JP,
  WW_COMBOS,
  flagCombos,
  oshiCombos,
  satCombos,
  satLabel,
  simulateSat,
  simulateWW,
  wwCombos,
  wwLabel,
} from "./kuroyuki.js";
import { PASS_RULE, monteCarlo, randomWeeks, rngOf } from "./optimize.js";
import { K, acquireLock, addLog, redis } from "./redis.js";
import {
  ASSET_DEFAULTS,
  SYMBOLS,
  assetOf,
  businessDate,
  isCrypto,
  mergeConfig,
  pipSize,
  round,
} from "./util.js";

// 判定ルールを変えたら上げる（同じ日の結果の使い回しを止めるため）
export const WW_VERSION = 6;

// WWを検証する銘柄（既定は主要FXの6銘柄。仮想通貨は本の対象外なので外す）
export function wwTargets(cfg) {
  const list = (Array.isArray(cfg.wwSymbols) ? cfg.wwSymbols : []).filter((s) =>
    SYMBOLS.includes(s),
  );
  return list.length ? list : SYMBOLS.filter((s) => !isCrypto(s));
}
// 2年分：前の1年で設定を選び、直近1年（一度も使っていないデータ）で答え合わせ
export const WW_DAYS = 730;
export const WW_TEST_DAYS = 365;
const WW_DAYS_ = 730;
const WW_TEST_DAYS_ = 365;
// 実際に運用する2ペア（検証は統計のため主要6ペアで行い、この2ペアの成績も別に出す）
export const WW_LIVE_PAIRS = ["USD_JPY", "EUR_USD"];
const RESULT_TTL = 12 * 3600 * 1000;

// 検証する手法（本の3手法＋フラッグW）
export const METHODS = {
  ww: {
    combos: wwCombos,
    dims: ["nExec", "level", "sma"],
    days: WW_DAYS_,
    test: WW_TEST_DAYS_,
    label: wwLabel,
  },
  oshi: {
    combos: oshiCombos,
    dims: ["fib", "level"],
    days: WW_DAYS_,
    test: WW_TEST_DAYS_,
    label: wwLabel,
  },
  flag: {
    combos: flagCombos,
    dims: ["fib", "level"],
    days: WW_DAYS_,
    test: WW_TEST_DAYS_,
    label: wwLabel,
  },
  sat: { combos: satCombos, dims: ["dirBars", "sma"], days: 90, test: 30, label: satLabel },
  // 勝てる理由がある手法：仲値（ドル円だけ）と4時間足トレンドフォロー（5年分）
  gotobi: {
    combos: gotobiCombos,
    dims: ["entryHm", "exitHm", "days"],
    days: WW_DAYS_,
    test: WW_TEST_DAYS_,
    label: gotobiLabel,
    symbols: ["USD_JPY"],
  },
  trend: {
    combos: trendCombos,
    dims: ["n", "k", "filter"],
    days: 1825,
    test: 730,
    label: trendLabel,
  },
};
const keyOf = (p) => JSON.stringify(p);
// グリッド内で1項目だけ違う設定＝設定のブレ
function gridNeighbors(p, all) {
  const dims = METHODS[p.method || "ww"].dims;
  return all.filter((q) => {
    if (q.combo !== p.combo) return false;
    return dims.filter((d) => q[d] !== p[d]).length === 1;
  });
}
// 保存容量を抑えるため、時刻は分単位で持つ
const toTrade = (x) => ({
  openedAt: x[0] * 60000,
  closedAt: x[1] * 60000,
  net: x[2],
  pips: x[3],
  fee: 0,
});

// 取引の並びから6段階のチェック
function judge({ trades, testFrom, fromTs, now, stress, nbResults, mtmDd, balance, seed }) {
  const cfgLike = {};
  const train = metricsOf(
    trades.filter((t) => t.closedAt < testFrom),
    cfgLike,
  );
  const test = metricsOf(
    trades.filter((t) => t.closedAt >= testFrom),
    cfgLike,
  );
  const full = { ...metricsOf(trades, cfgLike), mtmDd: Math.max(mtmDd || 0, 0) };
  full.mtmDd = Math.max(full.mtmDd, full.maxDd);
  const rng = rngOf(seed);
  const weeks = randomWeeks(trades, fromTs, now, rng);
  const mc = monteCarlo(trades, rng);
  const nbOk = nbResults.filter((m) => m.pf >= 1 && m.net > 0).length;
  const nbNeed = Math.ceil((nbResults.length * 2) / 3);
  const minTest = 30; // 答え合わせの1年で最低30回
  const checks = {
    split:
      train.pf >= PASS_RULE.trainPf &&
      test.trades >= minTest &&
      test.pf >= PASS_RULE.testPf &&
      test.net > 0,
    weeks: weeks.counted >= PASS_RULE.minWeeks && weeks.winShare >= PASS_RULE.weekWin,
    mc: mc.lossProb <= PASS_RULE.mcLoss,
    stress: stress.pf >= PASS_RULE.stressPf && stress.net > 0,
    neighbors: nbOk >= nbNeed,
    dd: full.mtmDd <= (balance * PASS_RULE.ddCapPct) / 100,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  return {
    train,
    test,
    full,
    weeks,
    mc,
    stress,
    neighbors: { ok: nbOk, total: nbResults.length },
    checks,
    passed,
    pass: passed === 6,
    robust: round(Math.min(train.pf, test.pf, stress.pf) * (1 - mc.lossProb), 3),
  };
}

function statsOf(trades) {
  let gw = 0;
  let gl = 0;
  let net = 0;
  for (const t of trades) {
    net += t.net;
    if (t.net > 0) gw += t.net;
    else gl -= t.net;
  }
  return {
    pf: gl > 0 ? round(gw / gl, 2) : gw > 0 ? 99 : 0,
    net: round(net, 0),
    gw,
    gl,
    trades: trades.length,
  };
}

// 同じ営業日・同じルールの結果があれば、計算し直さずにそれを返す
export async function cachedWW(symbol, now = Date.now()) {
  const cur = await redis.get(K.optSymbol(symbol));
  if (
    cur?.mode === "ww" &&
    cur.version === WW_VERSION &&
    cur.at &&
    businessDate(cur.at) === businessDate(now) &&
    (cur.methods || cur.error)
  )
    return cur;
  return null;
}

export async function optimizeSymbolWW(symbol, { now = Date.now(), force = false } = {}) {
  if (!force) {
    const hit = await cachedWW(symbol, now);
    if (hit) return { ...hit, cached: true };
  }
  const ok = await acquireLock(`${K.optimizeLock}:${symbol}`, 290);
  if (!ok) throw new Error(`${symbol}は検証中です`);
  try {
    const stored = mergeConfig(await redis.get(K.config));
    const base =
      assetOf(symbol) === assetOf(stored.symbol)
        ? stored
        : { ...stored, ...ASSET_DEFAULTS[assetOf(symbol)] };
    const { conv } = await marketContext(symbol);
    const bars = {};
    for (const [k, c] of Object.entries(WW_COMBOS))
      bars[k] = await loadBars(symbol, c.iv, WW_DAYS, now);
    if ((bars["1h5m"]?.length || 0) < 20000) {
      const r = {
        symbol,
        at: now,
        mode: "ww",
        version: WW_VERSION,
        error: "過去データが不足しています",
      };
      await redis.set(K.optSymbol(symbol), r, { ex: 60 * 60 * 24 * 3 });
      return r;
    }
    const m1 = await loadCandles(symbol, METHODS.sat.days, now);
    const h4 = await loadYearBars(symbol, "4hour", 5, now);
    const last = bars["1h5m"].at(-1).c;
    const pip = pipSize(symbol, last);
    const spread = (DEFAULT_SPREAD[symbol] || 0.5) * pip;
    const slip = (isCrypto(symbol) ? 2 : 0.2) * pip;
    const preps = Object.fromEntries(Object.entries(bars).map(([k, b]) => [k, { candles: b }]));

    const summary = {
      symbol,
      at: now,
      mode: "ww",
      version: WW_VERSION,
      spreadPips: round(spread / pip, 2),
      methods: {},
    };
    for (const [mk, M] of Object.entries(METHODS)) {
      if (M.symbols && !M.symbols.includes(symbol)) continue;
      if (mk === "trend" && h4.length < 400) continue;
      const fromTs =
        mk === "sat"
          ? Math.max(now - M.days * DAY, (m1[60] || m1[0] || { t: now }).t)
          : mk === "trend"
            ? Math.max(now - M.days * DAY, h4[210].t)
            : Math.max(now - M.days * DAY, bars["1h5m"][300].t);
      const testFrom = now - M.test * DAY;
      const env = { spread, conv, pip, symbol, cfg: base, fromTs, toTs: now };
      const combos = M.combos();
      const run = (p, e) =>
        mk === "sat"
          ? simulateSat(m1, p, e)
          : mk === "gotobi"
            ? simulateGotobi(bars["1h5m"], p, e)
            : mk === "trend"
              ? simulateTrend(h4, p, e)
              : simulateWW(preps[p.combo], p, e);
      const params = combos.map((p) => {
        const r = m1.length || mk !== "sat" ? run(p, env) : { trades: [], mtmDd: 0 };
        const st =
          m1.length || mk !== "sat" ? run(p, { ...env, spread: spread * 2, slip }) : { trades: [] };
        return {
          key: keyOf(p),
          p,
          label: M.label(p),
          nets: r.trades.map((t) => [
            Math.round(t.openedAt / 60000),
            Math.round(t.closedAt / 60000),
            t.net,
            t.pips,
          ]),
          mtmDd: r.mtmDd,
          stress: statsOf(st.trades),
          sample: r.trades.slice(-12).map((t) => ({
            symbol,
            method: mk,
            side: t.side,
            openedAt: t.openedAt,
            closedAt: t.closedAt,
            entry: t.entry,
            exit: t.exit,
            sl: t.sl,
            tp: t.tp,
            reason: t.reason,
            pips: t.pips,
            net: t.net,
            ww: t.ww,
          })),
        };
      });
      await redis.set(K.optMethod(symbol, mk), params, { ex: 60 * 60 * 24 * 3 });
      // 銘柄ごとの一番良い設定（前の期間の成績で選ぶ）
      const trainScore = (x) => {
        const m = metricsOf(
          x.nets.map(toTrade).filter((t) => t.closedAt < testFrom),
          {},
        );
        return m.net > 0 ? m.pf * Math.min(1, m.trades / 60) : m.net / 1e7;
      };
      const top = [...params].sort((a, b) => trainScore(b) - trainScore(a))[0];
      const nb = gridNeighbors(top.p, combos).map((q) =>
        metricsOf(params.find((y) => y.key === keyOf(q)).nets.map(toTrade), {}),
      );
      const j = judge({
        trades: top.nets.map(toTrade),
        testFrom,
        fromTs,
        now,
        stress: top.stress,
        nbResults: nb,
        mtmDd: top.mtmDd,
        balance: base.paperBalance,
        seed: `${businessDate(now)}:${symbol}:${mk}`,
      });
      summary.methods[mk] = { strategy: "ww", method: mk, params: top.p, label: top.label, ...j };
    }
    summary.bestWW = summary.methods.ww;
    summary.best = summary.methods.ww;
    await redis.set(K.optSymbol(symbol), summary, { ex: 60 * 60 * 24 * 3 });
    return summary;
  } finally {
    await redis.del(`${K.optimizeLock}:${symbol}`);
  }
}

function poolMethod(mk, usable, perSymbolParams, now, balance) {
  const M = METHODS[mk];
  const combos = M.combos();
  const testFrom = now - M.test * DAY;
  const fromTs = now - M.days * DAY;
  const pooled = combos.map((p) => {
    const key = keyOf(p);
    const per = usable
      .filter((r) => !M.symbols || M.symbols.includes(r.symbol))
      .map((r) => ({
        symbol: r.symbol,
        x: (perSymbolParams[r.symbol]?.[mk] || []).find((y) => y.key === key),
      }))
      .filter((z) => z.x);
    const trades = per
      .flatMap((z) => z.x.nets.map(toTrade))
      .sort((a, b) => a.closedAt - b.closedAt);
    const stress = per.reduce(
      (acc, z) => ({
        gw: acc.gw + z.x.stress.gw,
        gl: acc.gl + z.x.stress.gl,
        net: acc.net + z.x.stress.net,
      }),
      { gw: 0, gl: 0, net: 0 },
    );
    stress.pf = stress.gl > 0 ? round(stress.gw / stress.gl, 2) : stress.gw > 0 ? 99 : 0;
    return {
      key,
      p,
      trades,
      stress,
      mtmDd: per.reduce((acc, z) => acc + (z.x.mtmDd || 0), 0),
      per,
    };
  });
  const sc = (x) => {
    const m = metricsOf(
      x.trades.filter((t) => t.closedAt < testFrom),
      {},
    );
    return m.net > 0 ? m.pf * Math.min(1, m.trades / 150) : m.net / 1e8;
  };
  pooled.sort((a, b) => sc(b) - sc(a));
  const top = pooled[0];
  if (!top?.trades.length) return null;
  const nb = gridNeighbors(top.p, combos).map((q) =>
    metricsOf(pooled.find((y) => y.key === keyOf(q)).trades, {}),
  );
  const j = judge({
    trades: top.trades,
    testFrom,
    fromTs,
    now,
    stress: top.stress,
    nbResults: nb,
    mtmDd: top.mtmDd,
    balance,
    seed: `${businessDate(now)}:${mk}pool`,
  });
  let eq = 0;
  const curve = top.trades.map((t) => {
    eq += t.net;
    return { t: t.closedAt, v: round(eq, 0) };
  });
  const step = Math.max(1, Math.ceil(curve.length / 120));
  const lt = top.per
    .filter((z) => WW_LIVE_PAIRS.includes(z.symbol))
    .flatMap((z) => z.x.nets.map(toTrade))
    .sort((a, b) => a.closedAt - b.closedAt);
  return {
    method: mk,
    name: METHOD_JP[mk],
    days: M.days,
    testDays: M.test,
    params: top.p,
    label: M.label(top.p),
    symbols: M.symbols ? usable.filter((r) => M.symbols.includes(r.symbol)).length : usable.length,
    ...j,
    curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1),
    live: {
      pairs: WW_LIVE_PAIRS,
      train: metricsOf(
        lt.filter((t) => t.closedAt < testFrom),
        {},
      ),
      test: metricsOf(
        lt.filter((t) => t.closedAt >= testFrom),
        {},
      ),
    },
    bySymbol: top.per
      .map((z) => {
        const m = metricsOf(z.x.nets.map(toTrade), {});
        return { symbol: z.symbol, trades: m.trades, winRate: m.winRate, net: m.net, pf: m.pf };
      })
      .sort((a, b) => b.net - a.net),
    others: pooled.slice(1).map((x) => {
      const m = metricsOf(x.trades, {});
      const tr = metricsOf(
        x.trades.filter((t) => t.closedAt < testFrom),
        {},
      );
      const te = metricsOf(
        x.trades.filter((t) => t.closedAt >= testFrom),
        {},
      );
      return {
        label: M.label(x.p),
        trades: m.trades,
        winRate: m.winRate,
        pf: m.pf,
        net: m.net,
        train: { trades: tr.trades, pf: tr.pf, net: tr.net },
        test: { trades: te.trades, pf: te.pf, net: te.net },
      };
    }),
    sample: top.per
      .flatMap((z) => z.x.sample)
      .sort((a, b) => b.openedAt - a.openedAt)
      .slice(0, 40),
  };
}

// 全銘柄まとめての検証（本の使い方＝多くのペアを見て、形が出たものを狙う）
export async function finalizeWW({ apply = false, now = Date.now() } = {}) {
  const cfg = mergeConfig(await redis.get(K.config));
  const targets = wwTargets(cfg);
  const rows = await Promise.all(targets.map((s) => redis.get(K.optSymbol(s))));
  const results = targets
    .map((s, i) => rows[i] || { symbol: s, error: "未検証" })
    .map((r) => (r.at && now - r.at > RESULT_TTL ? { ...r, stale: true } : r));
  const usable = results.filter(
    (r) => r.mode === "ww" && r.version === WW_VERSION && !r.stale && !r.error && r.methods,
  );
  const perSymbolParams = {};
  for (const r of usable) {
    perSymbolParams[r.symbol] = {};
    for (const mk of Object.keys(METHODS))
      perSymbolParams[r.symbol][mk] = (await redis.get(K.optMethod(r.symbol, mk))) || [];
  }
  const pools = {};
  for (const mk of Object.keys(METHODS))
    pools[mk] = usable.length
      ? poolMethod(mk, usable, perSymbolParams, now, cfg.paperBalance)
      : null;

  let applied = null;
  if (apply && cfg.symbolMode === "auto") {
    // クロユキ式はまだ本番に組み込んでいないので、今は新規エントリーを止めておく
    await redis.set(K.config, { ...cfg, portfolio: [], autoBlocked: true, autoPickAt: now });
    await addLog(
      "検証はクロユキ式のみ。本番運用は未実装のため、新規エントリーは止めています",
      "regime",
    );
    applied = { status: "blocked" };
  }
  const out = {
    at: now,
    mode: "ww",
    totalDays: WW_DAYS,
    testDays: WW_TEST_DAYS,
    rule: PASS_RULE,
    results,
    pools,
    wwPool: pools.ww,
    portfolio: [],
    applied,
    note: "クロユキ式（WW・押し戻り・フラッグWは2年分の5分足・15分足で、前の1年で選び直近1年で答え合わせ。サテライトは90日分の1分足で前60日・直近30日。仲値はドル円のみ2年分。4時間足トレンドフォローは5年分の4時間足で前3年・直近2年）。全銘柄をまとめた成績で判断。ロットは損失額固定（資金の0.5%）。",
  };
  await redis.set(K.optimizeLast, out, { ex: 60 * 60 * 24 * 30 });
  return out;
}
