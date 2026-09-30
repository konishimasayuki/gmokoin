// クロユキWWに絞った検証：1年分の5分足・15分足で、銘柄ごと＋全銘柄まとめて6段階の検証をする
import { DAY, DEFAULT_SPREAD, loadBars, marketContext, metricsOf } from "./backtest.js";
import { WW_COMBOS, simulateWW, wwCombos, wwLabel } from "./kuroyuki.js";
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
export const WW_VERSION = 2;
export const WW_DAYS = 365;
export const WW_TEST_DAYS = 120;
const RESULT_TTL = 12 * 3600 * 1000;

const keyOf = (p) => `${p.combo}|${p.nExec}|${p.level ? 1 : 0}|${p.rr}`;
// グリッド内で1項目だけ違う設定＝設定のブレ
function gridNeighbors(p, all) {
  return all.filter((q) => {
    if (q.combo !== p.combo) return false;
    const diff = [q.nExec !== p.nExec, q.level !== p.level, q.rr !== p.rr].filter(Boolean).length;
    return diff === 1;
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
  const minTest = Math.round((PASS_RULE.minTest * WW_TEST_DAYS) / 30);
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
    (cur.params || cur.error)
  )
    return cur;
  return null;
}

export async function optimizeSymbolWW(symbol, { now = Date.now(), force = false } = {}) {
  if (!force) {
    const hit = await cachedWW(symbol, now);
    if (hit) return { ...hit, params: undefined, cached: true };
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
      const r = { symbol, at: now, mode: "ww", error: "過去データが不足しています" };
      await redis.set(K.optSymbol(symbol), r, { ex: 60 * 60 * 24 * 3 });
      return r;
    }
    const last = bars["1h5m"].at(-1).c;
    const pip = pipSize(symbol, last);
    const spread = (DEFAULT_SPREAD[symbol] || 0.5) * pip;
    const slip = (isCrypto(symbol) ? 2 : 0.2) * pip;
    const fromTs = Math.max(now - WW_DAYS * DAY, bars["1h5m"][300].t);
    const testFrom = now - WW_TEST_DAYS * DAY;
    const preps = Object.fromEntries(Object.entries(bars).map(([k, b]) => [k, { candles: b }]));
    const env = { spread, conv, pip, symbol, cfg: base, fromTs, toTs: now };

    const combos = wwCombos();
    const params = combos.map((p) => {
      const r = simulateWW(preps[p.combo], p, env);
      const st = simulateWW(preps[p.combo], p, { ...env, spread: spread * 2, slip });
      return {
        key: keyOf(p),
        p,
        label: wwLabel(p),
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

    // 銘柄ごとの一番良い設定（前半の成績で選ぶ）
    const trainScore = (x) => {
      const m = metricsOf(
        x.nets.map(toTrade).filter((t) => t.closedAt < testFrom),
        {},
      );
      return m.net > 0 ? m.pf * Math.min(1, m.trades / 60) : m.net / 1e7;
    };
    const ranked = [...params].sort((a, b) => trainScore(b) - trainScore(a));
    const top = ranked[0];
    const nb = gridNeighbors(top.p, combos).map((q) => {
      const x = params.find((y) => y.key === keyOf(q));
      return metricsOf(x.nets.map(toTrade), {});
    });
    const j = judge({
      trades: top.nets.map(toTrade),
      testFrom,
      fromTs,
      now,
      stress: top.stress,
      nbResults: nb,
      mtmDd: top.mtmDd,
      balance: base.paperBalance,
      seed: `${businessDate(now)}:${symbol}:ww`,
    });
    const bestWW = { strategy: "ww", params: top.p, label: top.label, ...j };
    const result = {
      symbol,
      at: now,
      mode: "ww",
      version: WW_VERSION,
      days: WW_DAYS,
      testDays: WW_TEST_DAYS,
      spreadPips: round(spread / pip, 2),
      unit: isCrypto(symbol) ? "bp" : "pips",
      kind: isCrypto(symbol) ? "crypto" : "fx",
      tested: combos.length,
      best: bestWW,
      bestWW,
      params,
    };
    await redis.set(K.optSymbol(symbol), result, { ex: 60 * 60 * 24 * 3 });
    return { ...result, params: undefined };
  } finally {
    await redis.del(`${K.optimizeLock}:${symbol}`);
  }
}

// 全銘柄まとめての検証（本の使い方＝多くのペアを見て、形が出たものを狙う）
export async function finalizeWW({ apply = false, now = Date.now() } = {}) {
  const cfg = mergeConfig(await redis.get(K.config));
  // 1銘柄分が大きいので、まとめて取らずに個別に読む
  const rows = await Promise.all(SYMBOLS.map((s) => redis.get(K.optSymbol(s))));
  const results = SYMBOLS.map((s, i) => rows[i] || { symbol: s, error: "未検証" }).map((r) =>
    r.at && now - r.at > RESULT_TTL ? { ...r, stale: true } : r,
  );
  const usable = results.filter(
    (r) => r.mode === "ww" && r.version === WW_VERSION && !r.stale && !r.error && r.params,
  );
  const combos = wwCombos();
  const testFrom = now - WW_TEST_DAYS * DAY;
  const fromTs = now - WW_DAYS * DAY;
  const pooled = combos.map((p) => {
    const key = keyOf(p);
    const per = usable
      .map((r) => ({ symbol: r.symbol, x: r.params.find((y) => y.key === key) }))
      .filter((z) => z.x);
    const trades = per
      .flatMap((z) => z.x.nets.map(toTrade))
      .sort((a, b) => a.closedAt - b.closedAt);
    const stress = per.reduce(
      (s, z) => ({
        gw: s.gw + z.x.stress.gw,
        gl: s.gl + z.x.stress.gl,
        net: s.net + z.x.stress.net,
      }),
      { gw: 0, gl: 0, net: 0 },
    );
    stress.pf = stress.gl > 0 ? round(stress.gw / stress.gl, 2) : stress.gw > 0 ? 99 : 0;
    return {
      key,
      p,
      trades,
      stress,
      mtmDd: per.reduce((s, z) => s + (z.x.mtmDd || 0), 0),
      per,
    };
  });
  const trainOf = (x) =>
    metricsOf(
      x.trades.filter((t) => t.closedAt < testFrom),
      {},
    );
  pooled.sort((a, b) => {
    const ma = trainOf(a);
    const mb = trainOf(b);
    const sa = ma.net > 0 ? ma.pf * Math.min(1, ma.trades / 150) : ma.net / 1e8;
    const sb = mb.net > 0 ? mb.pf * Math.min(1, mb.trades / 150) : mb.net / 1e8;
    return sb - sa;
  });
  let wwPool = null;
  if (usable.length && pooled[0]?.trades.length) {
    const top = pooled[0];
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
      balance: cfg.paperBalance,
      seed: `${businessDate(now)}:wwpool`,
    });
    let eq = 0;
    const curve = top.trades.map((t) => {
      eq += t.net;
      return { t: t.closedAt, v: round(eq, 0) };
    });
    const step = Math.max(1, Math.ceil(curve.length / 120));
    wwPool = {
      params: top.p,
      label: wwLabel(top.p),
      symbols: usable.length,
      ...j,
      curve: curve.filter((_, i) => i % step === 0 || i === curve.length - 1),
      bySymbol: top.per
        .map((z) => {
          const m = metricsOf(z.x.nets.map(toTrade), {});
          return { symbol: z.symbol, trades: m.trades, winRate: m.winRate, net: m.net, pf: m.pf };
        })
        .sort((a, b) => b.net - a.net),
      others: pooled.slice(1).map((x) => {
        const m = metricsOf(x.trades, {});
        return { label: wwLabel(x.p), trades: m.trades, winRate: m.winRate, pf: m.pf, net: m.net };
      }),
      sample: top.per
        .flatMap((z) => z.x.sample)
        .sort((a, b) => b.openedAt - a.openedAt)
        .slice(0, 40),
    };
  }

  let applied = null;
  if (apply && cfg.symbolMode === "auto") {
    // WWはまだ本番に組み込んでいないので、今は新規エントリーを止めておく
    await redis.set(K.config, { ...cfg, portfolio: [], autoBlocked: true, autoPickAt: now });
    await addLog(
      "検証はクロユキWWのみ。WWの本番運用は未実装のため、新規エントリーは止めています",
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
    results: results.map((r) => ({ ...r, params: undefined })),
    wwPool,
    portfolio: [],
    applied,
    note: "クロユキWWだけを1年分の5分足・15分足で検証。全銘柄をまとめた成績で判断します（本の使い方＝多くのペアを見て形が出たものを狙う）。ロットは損失額固定（資金の0.5%）。",
  };
  await redis.set(K.optimizeLast, out, { ex: 60 * 60 * 24 * 30 });
  return out;
}
