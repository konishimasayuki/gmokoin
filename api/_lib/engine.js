// ポートフォリオ運用エンジン：複数銘柄を同時に監視し、条件がそろった銘柄から入る
import { briefStale } from "./brief.js";
import { closedOnly, getCachedKlines, getTickers } from "./gmo.js";
import { computeScalpIndicators } from "./indicators.js";
import { LEVELS_TTL_MS } from "./levels.js";
import { K, acquireLock, addLog, getLogs, getTrades, redis } from "./redis.js";
import {
  SESSION_LABEL,
  buildHtf,
  buildMechanicalRegime,
  htfDirAt,
  levelInPath,
  maybeBreakEven,
  mechanicalRegimeAt,
  sessionAllowed,
  signalAt,
  signalCandles,
  sizeUnits,
  slTp,
  stepCandle,
} from "./strategy.js";
import {
  SYMBOLS,
  businessDate,
  cfgFor,
  feeOf,
  isCrypto,
  jstHM,
  legsOf,
  mergeConfig,
  pipSize,
  pnlYen,
  portfolioOf,
  priceDigits,
  quoteToJpy,
  round,
  unitLabel,
} from "./util.js";

export const EMPTY_DAILY = { pnl: 0, trades: 0, wins: 0 };
export const EMPTY_STATS = { net: 0, trades: 0, wins: 0, grossWin: 0, grossLoss: 0, fees: 0 };
const SIDE_JP = { BUY: "買い", SELL: "売り" };
const MIN = 60000;
const label = (s) => s.replace("_", "/");

export function regimeFreshness(regime, cfg, now) {
  if (!regime) return { stale: true, expired: true };
  const age = now - regime.at;
  const iv = cfg.regimeIntervalMin * MIN;
  return { stale: age >= iv, expired: age >= iv * 2 };
}

// 銘柄ごとのAI判定（旧形式の1銘柄判定にも対応）
export function regimeOf(regime, symbol) {
  if (!regime) return null;
  if (regime.symbols) return regime.symbols[symbol] || null;
  return regime.symbol === symbol ? regime : null;
}

function no(why, waiting = false) {
  return { ok: false, why, waiting };
}

// 為替・仮想通貨のレートをまとめて取得
async function fetchTickers(symbols) {
  const needFx = symbols.some((s) => !isCrypto(s));
  const needCrypto = symbols.some(isCrypto);
  const [fx, cr] = await Promise.all([
    needFx ? getTickers() : Promise.resolve({}),
    needCrypto ? getTickers("BTC_JPY") : Promise.resolve({}),
  ]);
  return { ...fx, ...cr };
}

// ---- 決済（口座全体の成績も更新して返す）
async function closeTrade({ pos, exit, reason, closedAt, cfg, conv, acct }) {
  const pip = pos.pip || pipSize(pos.symbol, pos.entry);
  const dir = pos.side === "BUY" ? 1 : -1;
  const pips = round((dir * (exit - pos.entry)) / pip, 1);
  const gross = round(pnlYen(pos.side, pos.entry, exit, pos.units, conv), 0);
  const fee = round(feeOf(pos.symbol, pos.units, cfg), 0);
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
    unit: unitLabel(pos.symbol),
    gross,
    fee,
    net,
  };
  const { daily, stats } = acct;
  acct.daily = {
    pnl: daily.pnl + net,
    trades: daily.trades + 1,
    wins: daily.wins + (net > 0 ? 1 : 0),
  };
  acct.stats = {
    net: stats.net + net,
    trades: stats.trades + 1,
    wins: stats.wins + (net > 0 ? 1 : 0),
    grossWin: stats.grossWin + (net > 0 ? net : 0),
    grossLoss: stats.grossLoss + (net < 0 ? -net : 0),
    fees: stats.fees + fee,
  };
  let losses = net < 0 ? (acct.streak?.losses || 0) + 1 : 0;
  let pauseUntil = null;
  if (losses >= cfg.lossStreakMax && cfg.lossStreakPauseMin > 0) {
    pauseUntil = closedAt + cfg.lossStreakPauseMin * MIN;
    losses = 0;
  }
  acct.streak = { losses, lastAt: closedAt };
  if (pauseUntil) acct.pauseUntil = pauseUntil;
  const p = redis
    .pipeline()
    .set(K.trade(pos.id), trade, { ex: 60 * 60 * 24 * 120 })
    .lpush(K.tradeIds, pos.id)
    .ltrim(K.tradeIds, 0, 499)
    .set(K.daily(bd), acct.daily, { ex: 60 * 60 * 24 * 30 })
    .sadd(K.dailyKeys, K.daily(bd))
    .set(K.stats, acct.stats)
    .set(K.streak, acct.streak)
    .del(K.posOf(pos.symbol))
    .srem(K.openSet, pos.symbol);
  if (cfg.cooldownSec >= 1)
    p.set(K.cooldownOf(pos.symbol), closedAt, { ex: Math.round(cfg.cooldownSec) });
  if (pauseUntil)
    p.set(K.pauseUntil, pauseUntil, { ex: Math.ceil((pauseUntil - closedAt) / 1000) });
  await p.exec();
  const sign = net >= 0 ? "+" : "";
  await addLog(
    `${label(pos.symbol)} ${SIDE_JP[pos.side]}決済（${reason}）${sign}${pips}${trade.unit} / ${sign}${net.toLocaleString("ja-JP")}円`,
    net >= 0 ? "win" : "loss",
  );
  if (pauseUntil)
    await addLog(
      `${cfg.lossStreakMax}連敗のため${jstHM(pauseUntil)}まで全銘柄を停止します`,
      "error",
    );
  return trade;
}

// ---- 確定1分足で決済・建値移動を判定（画面を閉じていた間も含む）
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
  if (buy ? price <= pos.sl : price >= pos.sl) return { exit: price, reason: slReason };
  if (buy ? price >= pos.tp : price <= pos.tp) return { exit: price, reason: "利確" };
  if (now - pos.openedAt >= (pos.timeStopMin || 15) * MIN)
    return { exit: price, reason: "時間切れ" };
  maybeBreakEven(pos, price);
  return null;
}

// その銘柄に関係する通貨の指標だけで止める（仮想通貨は米国指標も対象）
function activeEvent(r, regime, brief, now, bufMin, symbol) {
  const buf = bufMin * MIN;
  const curs = new Set(symbol.split("_"));
  if (isCrypto(symbol)) curs.add("USD");
  const events = [...(r?.events || []), ...(regime?.events || []), ...(brief?.events || [])];
  return (
    events.find(
      (e) =>
        e.ts &&
        e.impact !== "low" &&
        (!e.currency || curs.has(e.currency)) &&
        Math.abs(now - e.ts) <= buf,
    ) || null
  );
}

// 同じ通貨の偏りチェック
function exposureBlock(openPositions, symbol, side, max) {
  const exp = {};
  for (const p of openPositions)
    for (const [cur, d] of legsOf(p.symbol, p.side)) exp[cur] = (exp[cur] || 0) + d;
  for (const [cur, d] of legsOf(symbol, side)) {
    const next = (exp[cur] || 0) + d;
    if (Math.abs(next) > max)
      return `${cur}${d > 0 ? "買い" : "売り"}のポジションが重なりすぎ（上限${max}）`;
  }
  return null;
}

// ---- 1銘柄のエントリー判定（AIの方針の範囲内で、ルールだけで入る）
function evaluateEntry(x) {
  const {
    cfg,
    r,
    fresh,
    brief,
    regime,
    levels,
    t,
    market,
    acct,
    cooldown,
    lastSignal,
    sig,
    now,
    pip,
    conv,
  } = x;
  const unit = unitLabel(cfg.symbol);
  const digits = priceDigits(cfg.symbol);
  const { candles, ind, htf, tf } = sig;
  if (t.status !== "OPEN") return no("市場クローズ中");
  const ses = sessionAllowed(now, cfg);
  if (!ses.ok)
    return no(ses.key === "other" ? "取引時間外" : `${SESSION_LABEL[ses.key]}時間は取引しない設定`);
  if (acct.pauseUntil && now < acct.pauseUntil)
    return no(`連敗ストップ中（${jstHM(acct.pauseUntil)}まで）`);
  if (!r) return no("AIの判定待ち");
  if (fresh.expired) return no("AIの判定が古いため待機");
  if (r.mode === "NO_TRADE" || r.allow === "NONE") {
    const who = r.critic?.verdict === "VETO" ? "反論役が却下" : "AI判定：見送り";
    return no(`${who}${r.summary ? `（${r.summary}）` : ""}`);
  }
  if (r.pauseUntilTs && now < r.pauseUntilTs)
    return no(`${jstHM(r.pauseUntilTs)}まで停止（AI指示）`);
  const ev = activeEvent(r, regime, brief, now, cfg.eventBufferMin, cfg.symbol);
  if (ev) return no(`指標前後のため停止：${ev.time_jst} ${ev.name}`);
  if (cfg.dailyLossLimit > 0 && acct.daily.pnl <= -cfg.dailyLossLimit)
    return no("日次損失上限に到達");
  if (acct.daily.trades >= cfg.maxTradesPerDay) return no("本日の取引回数上限");
  if (cooldown) return no("決済後のクールダウン中");
  const rs = Number(r.max_spread_pips) > 0 ? Number(r.max_spread_pips) : Number.POSITIVE_INFINITY;
  if (market.spreadPips > Math.min(cfg.maxSpreadPips, rs))
    return no(`スプレッド拡大（${market.spreadPips}${unit}）`);
  if (cfg.rr < cfg.minRr) return no(`リスクリワード${cfg.rr}が下限${cfg.minRr}未満`);

  const L = candles.length - 1;
  if (L < 60) return no(`${tf}分足データ不足`);
  const aPips = ind.atr14[L] / pip;
  if (aPips < cfg.minAtrPips) return no(`値動きが小さい（ATR ${round(aPips, 1)}${unit}）`);
  if (aPips > cfg.maxAtrPips) return no(`値動きが荒い（ATR ${round(aPips, 1)}${unit}）`);
  const c = candles[L];
  if (lastSignal && Number(lastSignal) === c.t) return no("同じ足では再エントリーしない");

  const htfDir = htfDirAt(htf, c.t + tf * MIN);
  const s = signalAt({
    mode: r.mode,
    allow: r.allow,
    candles,
    ind,
    L,
    confirm: t.bid,
    cfg,
    htfDir,
  });
  if (!s)
    return no(
      cfg.htfFilter && htfDir === 0
        ? `シグナル待ち（${tf === 5 ? 15 : 5}分足の方向感なし）`
        : "シグナル待ち",
      true,
    );

  const entry = round(s.side === "BUY" ? t.ask : t.bid, digits);
  const lv = slTp({ entry, side: s.side, atr: ind.atr14[L], cfg, pip, digits });
  if (cfg.levelFilter) {
    const hit = levelInPath(levels?.all, s.side, entry, lv.tp);
    if (hit)
      return no(`利確までの間に${hit.frame}の水平線（${hit.price}・反発${hit.touches}回）`, true);
  }
  const size = sizeUnits({
    cfg,
    equity: cfg.paperBalance + acct.stats.net,
    slDist: lv.slDist,
    conv,
    symbol: cfg.symbol,
    price: entry,
  });
  if (!size.units) return no(size.why);
  return {
    ok: true,
    ...s,
    ...lv,
    entry,
    units: size.units,
    lastT: c.t,
    session: ses.key,
    confidence: r.confidence || 0,
  };
}

async function openPosition({ ev, cfg, t, r, now, pip }) {
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
    regimeMode: r?.mode || null,
    regimeConfidence: r?.confidence ?? null,
    timeStopMin: cfg.timeStopMin,
    beOn: cfg.beOn,
    beTrigger: cfg.beOn ? ev.slDist * cfg.beTriggerR : null,
    beMoved: false,
    pip,
    digits,
  };
  await redis
    .pipeline()
    .set(K.posOf(cfg.symbol), pos)
    .sadd(K.openSet, cfg.symbol)
    .set(K.lastSignalOf(cfg.symbol), ev.lastT, { ex: 3600 })
    .exec();
  const q = isCrypto(cfg.symbol) ? cfg.symbol.split("_")[0] : "通貨";
  await addLog(
    `${label(cfg.symbol)} ${SIDE_JP[ev.side]}エントリー（${ev.setup}）${ev.units.toLocaleString("ja-JP")}${q} @${ev.entry.toFixed(digits)} 損切${ev.sl.toFixed(digits)} 利確${ev.tp.toFixed(digits)}`,
    "entry",
  );
  return pos;
}

function withUnrealized(pos, t, cfg, conv) {
  if (!pos || !t) return pos;
  const price = pos.side === "BUY" ? t.bid : t.ask;
  const dir = pos.side === "BUY" ? 1 : -1;
  return {
    ...pos,
    price,
    pips: round((dir * (price - pos.entry)) / (pos.pip || pipSize(pos.symbol, pos.entry)), 1),
    yen: round(
      pnlYen(pos.side, pos.entry, price, pos.units, conv) - feeOf(pos.symbol, pos.units, cfg),
      0,
    ),
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

// 旧形式（1ポジションだけ）のデータを移行
async function migrateLegacy() {
  const legacy = await redis.get(K.position);
  if (!legacy?.symbol) return;
  await redis
    .pipeline()
    .set(K.posOf(legacy.symbol), legacy)
    .sadd(K.openSet, legacy.symbol)
    .del(K.position)
    .exec();
}

export async function runTick({ full = false, focus = null } = {}) {
  const now = Date.now();
  await migrateLegacy();
  const [storedCfg, regime, storedStats, streakRaw, pauseUntil, openList] = await Promise.all([
    redis.get(K.config),
    redis.get(K.regime),
    redis.get(K.stats),
    redis.get(K.streak),
    redis.get(K.pauseUntil),
    redis.smembers(K.openSet),
  ]);
  const cfg = mergeConfig(storedCfg);
  const items = portfolioOf(cfg).slice(0, 11);
  const itemMap = Object.fromEntries(items.map((it) => [it.symbol, it]));
  const symbols = [
    ...new Set([
      ...items.map((i) => i.symbol),
      ...(openList || []).filter((s) => SYMBOLS.includes(s)),
    ]),
  ];
  const bd = businessDate(now);
  const perKeys = symbols.flatMap((s) => [
    K.posOf(s),
    K.cooldownOf(s),
    K.lastSignalOf(s),
    K.levels(s),
  ]);
  const rulesMode = cfg.aiMode !== "claude";
  const [tickers, klines, hourly, perVals, extra] = await Promise.all([
    symbols.length ? fetchTickers(symbols) : Promise.resolve({}),
    Promise.all(symbols.map((s) => getCachedKlines(s, "1min", now).catch(() => []))),
    // ルール判定用の1時間足（5分キャッシュ）
    rulesMode
      ? Promise.all(
          symbols.map((s) =>
            getCachedKlines(s, "1hour", now, { ttlMs: 5 * MIN, days: 4, keep: 120 }).catch(
              () => [],
            ),
          ),
        )
      : Promise.resolve([]),
    perKeys.length ? redis.mget(...perKeys) : Promise.resolve([]),
    redis.mget(K.daily(bd), K.brief("ALL", bd)),
  ]);
  const [dailyRaw, brief] = extra;
  const acct = {
    daily: { ...EMPTY_DAILY, ...(dailyRaw || {}) },
    stats: { ...EMPTY_STATS, ...(storedStats || {}) },
    streak: streakRaw || { losses: 0 },
    pauseUntil: Number(pauseUntil) || null,
  };
  // ルールモード：Claudeの代わりに1時間足の移動平均で方針を決める（検証と同じ判定）
  let effRegime = regime;
  if (rulesMode) {
    effRegime = {
      at: now,
      rules: true,
      summary: "ルール判定（1時間足の移動平均。Claudeは使っていません）",
      events: [],
      symbols: {},
    };
    symbols.forEach((s, i) => {
      const h1 = closedOnly(hourly[i] || [], "1hour", now);
      const m = mechanicalRegimeAt(buildMechanicalRegime(h1), now);
      effRegime.symbols[s] = {
        ...m,
        confidence: m.mode === "NO_TRADE" ? 0 : 60,
        summary: "",
        events: [],
      };
    });
  }
  const fresh = rulesMode ? { stale: false, expired: false } : regimeFreshness(regime, cfg, now);

  // 銘柄ごとの下ごしらえ
  const st = symbols.map((symbol, i) => {
    const ecfg = itemMap[symbol] ? cfgFor(cfg, itemMap[symbol]) : { ...cfg, symbol };
    const t = tickers[symbol] || null;
    const pip = pipSize(symbol, t ? (t.bid + t.ask) / 2 : 0);
    const candles = closedOnly(klines[i] || [], "1min", now);
    const tf = ecfg.signalTf === 5 ? 5 : 1;
    const ind1 = computeScalpIndicators(candles);
    const sc = signalCandles(candles, tf, now);
    const sig = {
      candles: sc,
      ind: tf === 5 ? computeScalpIndicators(sc) : ind1,
      htf: buildHtf(candles, tf === 5 ? 15 : 5),
      tf,
    };
    return {
      symbol,
      inPortfolio: Boolean(itemMap[symbol]),
      cfg: ecfg,
      t,
      pip,
      conv: quoteToJpy(symbol, tickers) ?? 1,
      candles,
      ind1,
      sig,
      pos: perVals[i * 4],
      cooldown: perVals[i * 4 + 1],
      lastSignal: perVals[i * 4 + 2],
      levels: perVals[i * 4 + 3],
      r: regimeOf(effRegime, symbol),
      closed: null,
      decision: null,
    };
  });

  const locked = await acquireLock(K.tickLock, 12);
  const closedTrades = [];
  if (locked) {
    try {
      // 1) 保有中の決済判定
      for (const x of st) {
        if (!x.pos || !x.t) continue;
        const before = JSON.stringify(x.pos);
        const pos = { ...x.pos };
        const scan = scanCandles(pos, x.candles);
        let hit = scan.hit;
        let at = hit?.at ?? now;
        if (!hit && x.t.status === "OPEN") {
          hit = liveCheck(pos, x.t, now);
          at = now;
        }
        if (hit) {
          x.closed = await closeTrade({
            pos,
            exit: hit.exit,
            reason: hit.reason,
            closedAt: Math.max(at, pos.openedAt),
            cfg: x.cfg,
            conv: x.conv,
            acct,
          });
          closedTrades.push(x.closed);
          x.pos = null;
        } else {
          if (pos.beMoved && !JSON.parse(before).beMoved)
            await addLog(`${label(x.symbol)} 損切りを建値へ移動`, "entry");
          if (JSON.stringify(pos) !== before) await redis.set(K.posOf(x.symbol), pos);
          x.pos = pos;
        }
      }

      // 2) 新規エントリー（確信度の高い順に、上限と通貨の偏りを守って入る）
      const open = () => st.filter((x) => x.pos).map((x) => x.pos);
      const candidates = [];
      for (const x of st) {
        if (x.pos) {
          x.decision = {
            state: "holding",
            text: `${SIDE_JP[x.pos.side]}保有中（${x.pos.setup}${x.pos.beMoved ? "・建値ストップ済み" : ""}）`,
          };
          continue;
        }
        if (!cfg.running) {
          x.decision = { state: "idle", text: "停止中" };
          continue;
        }
        if (!x.inPortfolio) {
          x.decision = { state: "idle", text: "採用外（決済済み）" };
          continue;
        }
        if (!x.t) {
          x.decision = { state: "blocked", text: "レートを取得できません" };
          continue;
        }
        const market = { spreadPips: round((x.t.ask - x.t.bid) / x.pip, 1) };
        const ev = evaluateEntry({
          cfg: x.cfg,
          r: x.r,
          fresh,
          brief,
          regime: effRegime,
          levels: x.levels,
          t: x.t,
          market,
          acct,
          cooldown: Boolean(x.cooldown) || Boolean(x.closed),
          lastSignal: x.lastSignal,
          sig: x.sig,
          now,
          pip: x.pip,
          conv: x.conv,
        });
        if (ev.ok) candidates.push({ x, ev });
        else x.decision = { state: ev.waiting ? "watching" : "blocked", text: ev.why };
      }
      candidates.sort((a, b) => b.ev.confidence - a.ev.confidence);
      for (const { x, ev } of candidates) {
        const cur = open();
        if (cur.length >= cfg.maxPositions) {
          x.decision = { state: "blocked", text: `同時ポジション上限（${cfg.maxPositions}）` };
          continue;
        }
        const ex = exposureBlock(cur, x.symbol, ev.side, cfg.maxSameCurrency);
        if (ex) {
          x.decision = { state: "blocked", text: ex };
          continue;
        }
        x.pos = await openPosition({ ev, cfg: x.cfg, t: x.t, r: x.r, now, pip: x.pip });
        x.decision = { state: "entered", text: `${SIDE_JP[ev.side]}エントリー（${ev.setup}）` };
      }
    } finally {
      await redis.del(K.tickLock);
    }
  } else {
    for (const x of st) x.decision = { state: "busy", text: "別の処理が実行中" };
  }

  // ---- 画面用のまとめ
  const rows = st.map((x) => {
    const L = x.sig.candles.length - 1;
    return {
      symbol: x.symbol,
      inPortfolio: x.inPortfolio,
      unit: unitLabel(x.symbol),
      digits: priceDigits(x.symbol),
      bid: x.t?.bid ?? null,
      ask: x.t?.ask ?? null,
      spreadPips: x.t ? round((x.t.ask - x.t.bid) / x.pip, 1) : null,
      status: x.t?.status || "CLOSE",
      decision: x.decision,
      position: withUnrealized(x.pos, x.t, x.cfg, x.conv),
      regime: x.r
        ? {
            mode: x.r.mode,
            allow: x.r.allow,
            confidence: x.r.confidence,
            summary: x.r.summary,
            critic: x.r.critic?.verdict || null,
          }
        : null,
      session: (() => {
        const s = sessionAllowed(now, x.cfg);
        return {
          key: s.key,
          label: s.key === "other" && !s.ok ? "時間外" : SESSION_LABEL[s.key],
          ok: s.ok,
        };
      })(),
      label: itemMap[x.symbol]?.label || null,
      watch:
        L >= 0
          ? {
              tf: x.sig.tf,
              rsi7: x.sig.ind.rsi7[L] === null ? null : round(x.sig.ind.rsi7[L], 1),
              atrPips: x.sig.ind.atr14[L] === null ? null : round(x.sig.ind.atr14[L] / x.pip, 2),
              htfDir: htfDirAt(x.sig.htf, x.sig.candles[L].t + x.sig.tf * MIN),
            }
          : null,
    };
  });
  const focusSym =
    (focus && rows.find((r) => r.symbol === focus)?.symbol) ||
    rows.find((r) => r.position)?.symbol ||
    rows[0]?.symbol ||
    null;
  const fx = st.find((x) => x.symbol === focusSym);
  const from = fx ? Math.max(0, fx.candles.length - 90) : 0;
  const positions = rows.filter((r) => r.position);
  const snap = {
    now,
    config: cfg,
    regime: effRegime,
    regimeStale: fresh.stale,
    briefStale:
      !rulesMode &&
      briefStale(
        brief,
        now,
        items.map((i) => i.symbol),
      ),
    levelsStale: st.some((x) => x.inPortfolio && (!x.levels || now - x.levels.at >= LEVELS_TTL_MS)),
    optimizeStale:
      cfg.symbolMode === "auto" && (!cfg.autoPickAt || now - cfg.autoPickAt >= 24 * 3600 * 1000),
    rows,
    focus: focusSym,
    totals: {
      open: positions.length,
      maxPositions: cfg.maxPositions,
      unrealized: positions.reduce((s, r) => s + (r.position.yen || 0), 0),
    },
    closed: closedTrades,
    daily: acct.daily,
    stats: acct.stats,
    equity: round(cfg.paperBalance + acct.stats.net, 0),
    streak: acct.streak,
    pauseUntil: acct.pauseUntil && acct.pauseUntil > now ? acct.pauseUntil : null,
    detail: fx
      ? {
          symbol: fx.symbol,
          digits: priceDigits(fx.symbol),
          unit: unitLabel(fx.symbol),
          nearest: fx.t ? nearestLevels(fx.levels, (fx.t.bid + fx.t.ask) / 2) : null,
          chart: {
            candles: fx.candles.slice(from),
            ema9: fx.ind1.ema9.slice(from),
            ema21: fx.ind1.ema21.slice(from),
          },
        }
      : null,
  };
  if (full || closedTrades.length) {
    const [trades, logs] = await Promise.all([getTrades(30), getLogs(40)]);
    snap.trades = trades;
    snap.logs = logs;
    snap.brief = brief;
    snap.levels = fx?.levels || null;
  }
  return snap;
}

export async function manualClose(symbol) {
  const now = Date.now();
  const ok = await acquireLock(K.tickLock, 12, 10, 300);
  if (!ok) throw new Error("処理中です。少し待ってからもう一度押してください");
  try {
    const [storedCfg, pos, storedStats, streak, dailyRaw] = await redis.mget(
      K.config,
      K.posOf(symbol),
      K.stats,
      K.streak,
      K.daily(businessDate(now)),
    );
    if (!pos) return { closed: null };
    const cfg = mergeConfig(storedCfg);
    const tickers = await fetchTickers([symbol, "USD_JPY"]);
    const t = tickers[symbol];
    if (!t || t.status !== "OPEN") throw new Error("市場クローズ中のため決済できません");
    const acct = {
      daily: { ...EMPTY_DAILY, ...(dailyRaw || {}) },
      stats: { ...EMPTY_STATS, ...(storedStats || {}) },
      streak: streak || { losses: 0 },
    };
    const closed = await closeTrade({
      pos,
      exit: pos.side === "BUY" ? t.bid : t.ask,
      reason: "手動決済",
      closedAt: now,
      cfg,
      conv: quoteToJpy(symbol, tickers) ?? 1,
      acct,
    });
    return { closed };
  } finally {
    await redis.del(K.tickLock);
  }
}

export async function resetPaper() {
  const ok = await acquireLock(K.tickLock, 12, 10, 300);
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
      K.openSet,
      ...SYMBOLS.flatMap((s) => [K.posOf(s), K.cooldownOf(s), K.lastSignalOf(s)]),
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
  if (pnl < 0) return { locked: true, why: "本日マイナスのため" };
  if (losses >= 2) return { locked: true, why: `${losses}連敗中のため` };
  if (Number(pauseUntil) > now) return { locked: true, why: "連敗ストップ中のため" };
  return { locked: false };
}

// 保有中の銘柄一覧（設定の銘柄変更チェック用）
export async function openSymbols() {
  return (await redis.smembers(K.openSet)) || [];
}
