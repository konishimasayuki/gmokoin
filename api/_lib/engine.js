import { briefStale } from "./brief.js";
import { closedOnly, getCachedKlines, getTickers } from "./gmo.js";
import { computeScalpIndicators } from "./indicators.js";
import { LEVELS_TTL_MS } from "./levels.js";
import { K, acquireLock, addLog, getLogs, getTrades, redis } from "./redis.js";
import {
  SESSIONS,
  buildHtf,
  htfDirAt,
  levelInPath,
  maybeBreakEven,
  sessionAllowed,
  signalAt,
  sizeUnits,
  slTp,
  stepCandle,
} from "./strategy.js";
import {
  businessDate,
  jstHM,
  mergeConfig,
  pipSize,
  pnlYen,
  priceDigits,
  quoteToJpy,
  round,
} from "./util.js";

export const EMPTY_DAILY = { pnl: 0, trades: 0, wins: 0 };
export const EMPTY_STATS = { net: 0, trades: 0, wins: 0, grossWin: 0, grossLoss: 0, fees: 0 };
const SIDE_JP = { BUY: "買い", SELL: "売り" };
const MIN = 60000;

export function regimeFreshness(regime, cfg, now) {
  if (!regime) return { stale: true, expired: true };
  const age = now - regime.at;
  const iv = cfg.regimeIntervalMin * MIN;
  return { stale: age >= iv, expired: age >= iv * 2 };
}

function no(why, waiting = false) {
  return { ok: false, why, waiting };
}

// ---- 決済
async function closeTrade({ pos, exit, reason, closedAt, cfg, conv, daily, stats, streak }) {
  const pip = pipSize(pos.symbol);
  const dir = pos.side === "BUY" ? 1 : -1;
  const pips = round((dir * (exit - pos.entry)) / pip, 1);
  const gross = round(pnlYen(pos.side, pos.entry, exit, pos.units, conv), 0);
  const fee = cfg.feeOn ? round(cfg.feePerUnit * pos.units * 2, 0) : 0;
  const net = gross - fee;
  const bd = businessDate(closedAt);
  const trade = {
    id: pos.id,
    symbol: pos.symbol,
    side: pos.side,
    units: pos.units,
    entry: pos.entry,
    exit,
    sl: pos.sl,
    tp: pos.tp,
    setup: pos.setup,
    session: pos.session,
    regimeMode: pos.regimeMode,
    regimeConfidence: pos.regimeConfidence,
    beMoved: Boolean(pos.beMoved),
    openedAt: pos.openedAt,
    closedAt,
    reason,
    pips,
    gross,
    fee,
    net,
  };
  const nd = {
    pnl: daily.pnl + net,
    trades: daily.trades + 1,
    wins: daily.wins + (net > 0 ? 1 : 0),
  };
  const ns = {
    net: stats.net + net,
    trades: stats.trades + 1,
    wins: stats.wins + (net > 0 ? 1 : 0),
    grossWin: stats.grossWin + (net > 0 ? net : 0),
    grossLoss: stats.grossLoss + (net < 0 ? -net : 0),
    fees: stats.fees + fee,
  };
  let losses = net < 0 ? (streak?.losses || 0) + 1 : 0;
  let pauseUntil = null;
  if (losses >= cfg.lossStreakMax && cfg.lossStreakPauseMin > 0) {
    pauseUntil = closedAt + cfg.lossStreakPauseMin * MIN;
    losses = 0;
  }
  const p = redis
    .pipeline()
    .set(K.trade(pos.id), trade, { ex: 60 * 60 * 24 * 120 })
    .lpush(K.tradeIds, pos.id)
    .ltrim(K.tradeIds, 0, 499)
    .set(K.daily(bd), nd, { ex: 60 * 60 * 24 * 30 })
    .sadd(K.dailyKeys, K.daily(bd))
    .set(K.stats, ns)
    .set(K.streak, { losses, lastAt: closedAt })
    .del(K.position);
  if (cfg.cooldownSec >= 1) p.set(K.cooldown, closedAt, { ex: Math.round(cfg.cooldownSec) });
  if (pauseUntil)
    p.set(K.pauseUntil, pauseUntil, { ex: Math.ceil((pauseUntil - closedAt) / 1000) });
  await p.exec();
  const sign = net >= 0 ? "+" : "";
  await addLog(
    `${SIDE_JP[pos.side]}決済（${reason}）${sign}${pips}pips / ${sign}${net.toLocaleString("ja-JP")}円`,
    net >= 0 ? "win" : "loss",
  );
  if (pauseUntil)
    await addLog(`${cfg.lossStreakMax}連敗のため${jstHM(pauseUntil)}まで停止します`, "error");
  return { trade, daily: nd, stats: ns, streak: { losses }, pauseUntil };
}

// ---- 画面を閉じていた間も含め、確定1分足で決済・建値移動を判定
function scanCandles(pos, candles) {
  const spread = pos.spreadPrice || 0;
  let moved = false;
  for (const c of candles) {
    if (c.t < pos.scanFrom) continue;
    pos.scanFrom = c.t + MIN;
    const r = stepCandle(pos, c, spread);
    if (r.hit)
      return { hit: { ...r.hit, reason: `${r.hit.reason}（1分足で判定）`, at: c.t }, moved };
    if (r.moved) moved = true;
  }
  return { hit: null, moved };
}

function liveCheck(pos, t, now) {
  const buy = pos.side === "BUY";
  const price = buy ? t.bid : t.ask;
  const slReason = pos.beMoved ? "建値決済" : "損切り";
  if (buy ? price <= pos.sl : price >= pos.sl) return { hit: { exit: price, reason: slReason } };
  if (buy ? price >= pos.tp : price <= pos.tp) return { hit: { exit: price, reason: "利確" } };
  if (now - pos.openedAt >= (pos.timeStopMin || 15) * MIN)
    return { hit: { exit: price, reason: "時間切れ" } };
  return { hit: null, moved: maybeBreakEven(pos, price) };
}

function activeEvent(regime, brief, now, bufMin) {
  const buf = bufMin * MIN;
  const events = [...(regime?.events || []), ...(brief?.events || [])];
  return events.find((e) => e.ts && e.impact !== "low" && Math.abs(now - e.ts) <= buf) || null;
}

// ---- エントリー判定（Claudeの方針の範囲内で、ルールだけで入る）
function evaluateEntry(x) {
  const {
    cfg,
    regime,
    brief,
    levels,
    fresh,
    t,
    market,
    daily,
    cooldownActive,
    pauseUntil,
    lastSignal,
    candles,
    ind,
    htf,
    now,
    equity,
    conv,
  } = x;
  const pip = pipSize(cfg.symbol);
  const digits = priceDigits(cfg.symbol);
  if (t.status !== "OPEN") return no("市場クローズ中");
  const ses = sessionAllowed(now, cfg);
  if (!ses.ok)
    return no(
      ses.key
        ? `${SESSIONS[ses.key].label}時間は取引しない設定`
        : "取引時間外（早朝・時間帯の切り替わり）",
    );
  if (pauseUntil && now < pauseUntil) return no(`連敗ストップ中（${jstHM(pauseUntil)}まで）`);
  if (!regime) return no("Claudeの相場判定待ち");
  if (fresh.expired) return no("相場判定が古いため待機");
  if (regime.mode === "NO_TRADE" || regime.allow === "NONE") {
    const who = regime.critic?.verdict === "VETO" ? "反論役が却下" : "Claude判定：見送り";
    return no(`${who}${regime.summary ? `（${regime.summary}）` : ""}`);
  }
  if (regime.pauseUntilTs && now < regime.pauseUntilTs)
    return no(`${jstHM(regime.pauseUntilTs)}まで停止（Claude指示）`);
  const ev = activeEvent(regime, brief, now, cfg.eventBufferMin);
  if (ev) return no(`指標前後のため停止：${ev.time_jst} ${ev.name}`);
  if (cfg.dailyLossLimit > 0 && daily.pnl <= -cfg.dailyLossLimit) return no("日次損失上限に到達");
  if (daily.trades >= cfg.maxTradesPerDay) return no("本日の取引回数上限");
  if (cooldownActive) return no("決済後のクールダウン中");
  const rs =
    Number(regime.max_spread_pips) > 0 ? Number(regime.max_spread_pips) : Number.POSITIVE_INFINITY;
  if (market.spreadPips > Math.min(cfg.maxSpreadPips, rs))
    return no(`スプレッド拡大（${market.spreadPips}pips）`);
  if (cfg.rr < cfg.minRr) return no(`リスクリワード${cfg.rr}が下限${cfg.minRr}未満`);

  const L = candles.length - 1;
  if (L < 60) return no("1分足データ不足");
  const aPips = ind.atr14[L] / pip;
  if (aPips < cfg.minAtrPips) return no(`値動きが小さい（ATR ${round(aPips, 1)}pips）`);
  if (aPips > cfg.maxAtrPips) return no(`値動きが荒い（ATR ${round(aPips, 1)}pips）`);
  const c = candles[L];
  if (lastSignal && Number(lastSignal) === c.t) return no("同じ足では再エントリーしない");

  const htfDir = htfDirAt(htf, c.t + MIN);
  const sig = signalAt({
    mode: regime.mode,
    allow: regime.allow,
    candles,
    ind,
    L,
    confirm: t.bid,
    cfg,
    htfDir,
  });
  if (!sig)
    return no(
      cfg.htfFilter && htfDir === 0 ? "シグナル待ち（5分足の方向感なし）" : "シグナル待ち",
      true,
    );

  const entry = round(sig.side === "BUY" ? t.ask : t.bid, digits);
  const lv = slTp({ entry, side: sig.side, atr: ind.atr14[L], cfg, pip, digits });
  if (cfg.levelFilter) {
    const hit = levelInPath(levels?.all, sig.side, entry, lv.tp);
    if (hit)
      return no(`利確までの間に${hit.frame}の水平線（${hit.price}・反発${hit.touches}回）`, true);
  }
  const size = sizeUnits({ cfg, equity, slDist: lv.slDist, conv });
  if (!size.units) return no(size.why);
  return { ok: true, ...sig, ...lv, entry, units: size.units, lastT: c.t, session: ses.key };
}

async function openPosition({ ev, cfg, t, regime, now }) {
  const pip = pipSize(cfg.symbol);
  const digits = priceDigits(cfg.symbol);
  const pos = {
    id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    symbol: cfg.symbol,
    side: ev.side,
    units: ev.units,
    entry: ev.entry,
    sl: ev.sl,
    initialSl: ev.sl,
    tp: ev.tp,
    openedAt: now,
    scanFrom: Math.floor(now / MIN) * MIN + MIN,
    spreadPrice: t.ask - t.bid,
    setup: ev.setup,
    session: ev.session,
    regimeMode: regime?.mode || null,
    regimeConfidence: regime?.confidence ?? null,
    timeStopMin: cfg.timeStopMin,
    beOn: cfg.beOn,
    beTrigger: cfg.beOn ? ev.slDist * cfg.beTriggerR : null,
    beMoved: false,
    pip,
    digits,
  };
  await redis.pipeline().set(K.position, pos).set(K.lastSignal, ev.lastT, { ex: 3600 }).exec();
  await addLog(
    `${SIDE_JP[ev.side]}エントリー（${ev.setup}）${ev.units.toLocaleString("ja-JP")}通貨 @${ev.entry.toFixed(digits)} 損切${ev.sl.toFixed(digits)} 利確${ev.tp.toFixed(digits)}`,
    "entry",
  );
  return pos;
}

function withUnrealized(pos, t, cfg, conv) {
  if (!pos || !t) return pos;
  const price = pos.side === "BUY" ? t.bid : t.ask;
  const dir = pos.side === "BUY" ? 1 : -1;
  const fee = cfg.feeOn ? cfg.feePerUnit * pos.units * 2 : 0;
  return {
    ...pos,
    price,
    pips: round((dir * (price - pos.entry)) / pipSize(pos.symbol), 1),
    yen: round(pnlYen(pos.side, pos.entry, price, pos.units, conv) - fee, 0),
  };
}

function nearestLevels(levels, price) {
  if (!levels?.all?.length) return null;
  const above =
    levels.all.filter((l) => l.price > price).sort((a, b) => a.price - b.price)[0] || null;
  const below =
    levels.all.filter((l) => l.price <= price).sort((a, b) => b.price - a.price)[0] || null;
  return { above, below };
}

export async function runTick({ full = false } = {}) {
  const now = Date.now();
  const [storedCfg, regime, position, storedStats, cooldown, lastSignal, streakRaw, pauseUntil] =
    await redis.mget(
      K.config,
      K.regime,
      K.position,
      K.stats,
      K.cooldown,
      K.lastSignal,
      K.streak,
      K.pauseUntil,
    );
  const cfg = mergeConfig(storedCfg);
  const bd = businessDate(now);
  const [tickers, raw, extra] = await Promise.all([
    getTickers(),
    getCachedKlines(cfg.symbol, "1min", now),
    redis.mget(K.daily(bd), K.levels(cfg.symbol), K.brief(cfg.symbol, bd)),
  ]);
  const [dailyRaw, levels, brief] = extra;
  const t = tickers[cfg.symbol];
  if (!t) throw new Error(`${cfg.symbol}のレートを取得できません`);
  const conv = quoteToJpy(cfg.symbol, tickers) ?? 1;
  const pip = pipSize(cfg.symbol);
  const market = {
    bid: t.bid,
    ask: t.ask,
    spreadPips: round((t.ask - t.bid) / pip, 1),
    status: t.status,
    ts: t.ts,
  };
  const candles = closedOnly(raw, "1min", now);
  const ind = computeScalpIndicators(candles);
  const htf = buildHtf(candles);
  const fresh = regimeFreshness(regime, cfg, now);
  let daily = { ...EMPTY_DAILY, ...(dailyRaw || {}) };
  let stats = { ...EMPTY_STATS, ...(storedStats || {}) };
  let streak = streakRaw || { losses: 0 };
  let pausedUntil = Number(pauseUntil) || null;
  let pos = position;
  let closed = null;
  let decision = { state: "idle", text: "停止中（新規エントリーはしません）" };

  const locked = await acquireLock(K.tickLock, 8);
  if (locked) {
    try {
      if (pos) {
        const before = JSON.stringify(pos);
        pos = { ...pos };
        const scan = scanCandles(pos, candles);
        let hit = scan.hit;
        let at = hit?.at ?? now;
        if (!hit && t.status === "OPEN") {
          hit = liveCheck(pos, t, now).hit;
          at = now;
        }
        if (hit) {
          const r = await closeTrade({
            pos,
            exit: hit.exit,
            reason: hit.reason,
            closedAt: Math.max(at, pos.openedAt),
            cfg,
            conv,
            daily,
            stats,
            streak,
          });
          closed = r.trade;
          daily = r.daily;
          stats = r.stats;
          streak = r.streak;
          if (r.pauseUntil) pausedUntil = r.pauseUntil;
          pos = null;
        } else if (JSON.stringify(pos) !== before) {
          if (pos.beMoved && !JSON.parse(before).beMoved)
            await addLog("含み益が伸びたため損切りを建値へ移動", "entry");
          await redis.set(K.position, pos);
        }
      }

      if (pos) {
        decision = {
          state: "holding",
          text: `${SIDE_JP[pos.side]}ポジション保有中（${pos.setup}${pos.beMoved ? "・建値ストップ済み" : ""}）`,
        };
      } else if (cfg.running) {
        const ev = evaluateEntry({
          cfg,
          regime,
          brief,
          levels,
          fresh,
          t,
          market,
          daily,
          cooldownActive: Boolean(cooldown) || Boolean(closed),
          pauseUntil: pausedUntil,
          lastSignal,
          candles,
          ind,
          htf,
          now,
          equity: cfg.paperBalance + stats.net,
          conv,
        });
        if (ev.ok) {
          pos = await openPosition({ ev, cfg, t, regime, now });
          decision = { state: "entered", text: `${SIDE_JP[ev.side]}エントリー（${ev.setup}）` };
        } else {
          decision = { state: ev.waiting ? "watching" : "blocked", text: ev.why };
        }
      }
    } finally {
      await redis.del(K.tickLock);
    }
  } else {
    decision = { state: "busy", text: "別の処理が実行中" };
  }

  const L = candles.length - 1;
  const from = Math.max(0, candles.length - 90);
  const ses = sessionAllowed(now, cfg);
  const snap = {
    now,
    symbol: cfg.symbol,
    digits: priceDigits(cfg.symbol),
    config: cfg,
    market,
    regime,
    regimeStale: fresh.stale,
    briefStale: briefStale(brief, now),
    levelsStale: !levels || now - levels.at >= LEVELS_TTL_MS,
    position: withUnrealized(pos, t, cfg, conv),
    closed,
    daily,
    stats,
    equity: round(cfg.paperBalance + stats.net, 0),
    streak,
    pauseUntil: pausedUntil && pausedUntil > now ? pausedUntil : null,
    session: { key: ses.key, label: ses.key ? SESSIONS[ses.key].label : "時間外", ok: ses.ok },
    nearest: nearestLevels(levels, (t.bid + t.ask) / 2),
    decision,
    watch:
      L >= 0
        ? {
            rsi7: ind.rsi7[L] === null ? null : round(ind.rsi7[L], 1),
            atrPips: ind.atr14[L] === null ? null : round(ind.atr14[L] / pip, 2),
            htfDir: htfDirAt(htf, candles[L].t + MIN),
          }
        : null,
    chart: {
      candles: candles.slice(from),
      ema9: ind.ema9.slice(from),
      ema21: ind.ema21.slice(from),
    },
  };
  if (full || closed) {
    const [trades, logs] = await Promise.all([getTrades(30), getLogs(40)]);
    snap.trades = trades;
    snap.logs = logs;
    snap.levels = levels;
    snap.brief = brief;
  }
  return snap;
}

export async function manualClose() {
  const now = Date.now();
  const ok = await acquireLock(K.tickLock, 8, 10, 300);
  if (!ok) throw new Error("処理中です。少し待ってからもう一度押してください");
  try {
    const [storedCfg, pos, storedStats, streak] = await redis.mget(
      K.config,
      K.position,
      K.stats,
      K.streak,
    );
    if (!pos) return { closed: null };
    const cfg = mergeConfig(storedCfg);
    const tickers = await getTickers();
    const t = tickers[pos.symbol];
    if (!t || t.status !== "OPEN") throw new Error("市場クローズ中のため決済できません");
    const dailyRaw = await redis.get(K.daily(businessDate(now)));
    const r = await closeTrade({
      pos,
      exit: pos.side === "BUY" ? t.bid : t.ask,
      reason: "手動決済",
      closedAt: now,
      cfg,
      conv: quoteToJpy(pos.symbol, tickers) ?? 1,
      daily: { ...EMPTY_DAILY, ...(dailyRaw || {}) },
      stats: { ...EMPTY_STATS, ...(storedStats || {}) },
      streak,
    });
    return { closed: r.trade };
  } finally {
    await redis.del(K.tickLock);
  }
}

export async function resetPaper() {
  const ok = await acquireLock(K.tickLock, 8, 10, 300);
  if (!ok) throw new Error("処理中です。少し待ってからもう一度押してください");
  try {
    const ids = await redis.lrange(K.tradeIds, 0, -1);
    const dailyKeys = await redis.smembers(K.dailyKeys);
    const keys = [
      K.position,
      K.stats,
      K.tradeIds,
      K.cooldown,
      K.lastSignal,
      K.logs,
      K.dailyKeys,
      K.streak,
      K.pauseUntil,
      ...ids.map((id) => K.trade(id)),
      ...dailyKeys,
    ];
    for (let i = 0; i < keys.length; i += 200) await redis.del(...keys.slice(i, i + 200));
    await addLog("ペーパー口座をリセットしました");
    return { ok: true };
  } finally {
    await redis.del(K.tickLock);
  }
}

// 設定変更のロック判定（損失中・連敗中はリスクを増やす変更を禁止）
export async function riskLockState() {
  const now = Date.now();
  const [dailyRaw, streak, pauseUntil] = await redis.mget(
    K.daily(businessDate(now)),
    K.streak,
    K.pauseUntil,
  );
  const pnl = dailyRaw?.pnl || 0;
  const losses = streak?.losses || 0;
  const paused = Number(pauseUntil) > now;
  if (pnl < 0) return { locked: true, why: "本日マイナスのため" };
  if (losses >= 2) return { locked: true, why: `${losses}連敗中のため` };
  if (paused) return { locked: true, why: "連敗ストップ中のため" };
  return { locked: false };
}
