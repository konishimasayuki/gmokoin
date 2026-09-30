export const FX_SYMBOLS = ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_USD", "GBP_USD"];
// GMOコイン 取引所（レバレッジ）で取引手数料が無料の銘柄
export const CRYPTO_SYMBOLS = ["BTC_JPY", "ETH_JPY", "XRP_JPY", "BCH_JPY", "LTC_JPY"];
export const SYMBOLS = [...FX_SYMBOLS, ...CRYPTO_SYMBOLS];
export const isCrypto = (s) => CRYPTO_SYMBOLS.includes(s);
export const assetOf = (s) => (isCrypto(s) ? "crypto" : "fx");
// 値幅の単位が違うので、FX(pips)と仮想通貨(bp)で既定値を分ける
export const ASSET_DEFAULTS = {
  fx: { maxSpreadPips: 1.0, slMinPips: 2, slMaxPips: 8, minAtrPips: 0.4, maxAtrPips: 6 },
  crypto: { maxSpreadPips: 8, slMinPips: 10, slMaxPips: 60, minAtrPips: 2, maxAtrPips: 60 },
};
const CRYPTO_DIGITS = { BTC_JPY: 0, ETH_JPY: 0, BCH_JPY: 0, LTC_JPY: 1, XRP_JPY: 3 };
// 最小注文数量の目安（ペーパー用の近似）
export const CRYPTO_STEP = { BTC_JPY: 0.01, ETH_JPY: 0.1, XRP_JPY: 10, BCH_JPY: 0.1, LTC_JPY: 1 };

export const DEFAULT_CONFIG = {
  symbol: "USD_JPY",
  units: 10000,
  running: false,
  tickSec: 10,
  maxSpreadPips: 1.0,
  dailyLossLimit: 5000,
  maxTradesPerDay: 30,
  regimeIntervalMin: 15,
  feeOn: true,
  feePerUnit: 0.002,
  slAtrMult: 1.2,
  slMinPips: 2,
  slMaxPips: 8,
  rr: 1.2,
  timeStopMin: 15,
  minAtrPips: 0.4,
  maxAtrPips: 6,
  cooldownSec: 60,
  eventBufferMin: 15,
  // 取引時間帯（JST）東京9-15時 / ロンドン16-21時 / NY21-翌2時。それ以外は取引しない
  sessions: { tokyo: true, london: true, ny: true, other: false },
  htfFilter: true, // 5分足の向きと一致するときだけ
  beOn: true, // 建値ストップ
  beTriggerR: 1.0, // 損切り幅の何倍の含み益で建値へ
  lossStreakMax: 3, // 連敗ストップ
  lossStreakPauseMin: 60,
  levelFilter: true, // 利確までの間に水平線があれば見送り
  sizingMode: "fixed", // fixed | risk
  paperBalance: 1000000,
  riskPct: 0.5,
  maxUnits: 200000,
  cryptoNotional: 1000000, // 仮想通貨の1回あたりの取引額（円）。レバレッジは最大2倍
  minRr: 1.0,
  signalTf: 1, // シグナルを見る足（1分 or 5分）
  symbolMode: "auto", // auto=検証結果から自動で銘柄と設定を選ぶ / manual
  autoBlocked: false, // 自動選定で合格がなかったとき true（新規エントリー停止）
  autoPickAt: null,
  // ポートフォリオ（AIおまかせ時に、合格した銘柄と各銘柄の設定が入る）
  portfolio: [],
  aiMode: "rules", // rules=ルールだけで方針を決める（Claude不要・無料） / claude=AIチームが方針を決める
  maxSymbols: 5, // 採用する銘柄数の上限
  maxPositions: 3, // 同時に持つポジション数の上限
  maxSameCurrency: 2, // 同じ通貨を同じ向きに持つ数の上限（円売りが重なりすぎないように）
};

export const BOOLEAN_KEYS = ["running", "feeOn", "htfFilter", "beOn", "levelFilter"];

// 最適化で自動的に変える項目
export const TUNED_KEYS = [
  "signalTf",
  "sessions",
  "beOn",
  "beTriggerR",
  "rr",
  "slAtrMult",
  "slMinPips",
  "slMaxPips",
  "htfFilter",
  "timeStopMin",
  "minAtrPips",
  "maxAtrPips",
];

// 増やすとリスクが上がる項目（損失中・連敗中はロック）
export const RISK_UP_KEYS = [
  "maxPositions",
  "maxSameCurrency",
  "cryptoNotional",
  "units",
  "riskPct",
  "maxUnits",
  "dailyLossLimit",
  "maxTradesPerDay",
  "lossStreakMax",
  "slMaxPips",
];

// 設定画面で変更できる数値項目と許容範囲
export const NUMERIC_LIMITS = {
  units: [10000, 500000],
  tickSec: [3, 30],
  maxSpreadPips: [0.1, 10],
  dailyLossLimit: [0, 1000000],
  maxTradesPerDay: [1, 500],
  regimeIntervalMin: [5, 120],
  feePerUnit: [0, 0.1],
  slAtrMult: [0.3, 5],
  slMinPips: [0.5, 50],
  slMaxPips: [1, 100],
  rr: [0.5, 5],
  timeStopMin: [1, 240],
  minAtrPips: [0, 20],
  maxAtrPips: [0.5, 100],
  cooldownSec: [0, 3600],
  eventBufferMin: [0, 120],
  beTriggerR: [0.2, 3],
  lossStreakMax: [1, 20],
  lossStreakPauseMin: [0, 1440],
  paperBalance: [10000, 100000000],
  riskPct: [0.05, 5],
  maxUnits: [10000, 1000000],
  minRr: [0.3, 5],
  cryptoNotional: [10000, 100000000],
  maxSymbols: [1, 11],
  maxPositions: [1, 11],
  maxSameCurrency: [1, 11],
};

const JST = 9 * 3600 * 1000;

function pad(n) {
  return String(n).padStart(2, "0");
}

export function jstParts(ts) {
  const d = new Date(ts + JST);
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hh: d.getUTCHours(),
    mm: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  };
}

export function jstDate(ts) {
  const p = jstParts(ts);
  return `${p.y}${pad(p.m)}${pad(p.d)}`;
}

export function jstHM(ts) {
  const p = jstParts(ts);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

export function jstLabel(ts) {
  const p = jstParts(ts);
  const w = ["日", "月", "火", "水", "木", "金", "土"][p.dow];
  return `${p.y}/${pad(p.m)}/${pad(p.d)}(${w}) ${pad(p.hh)}:${pad(p.mm)} JST`;
}

// GMOコインのKLine日付は日本時間6:00に切り替わる
export function businessDate(ts) {
  return jstDate(ts - 6 * 3600 * 1000);
}

// 営業日(bd: YYYYMMDD, 6:00開始)の "HH:MM" を絶対時刻へ。6時前は翌日扱い
export function businessHmToTs(hm, bd) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
  if (!m || !/^\d{8}$/.test(String(bd))) return null;
  const y = Number(bd.slice(0, 4));
  const mo = Number(bd.slice(4, 6));
  const d = Number(bd.slice(6, 8));
  const hh = Number(m[1]);
  const base = Date.UTC(y, mo - 1, d) - JST;
  return base + ((hh < 6 ? hh + 24 : hh) * 60 + Number(m[2])) * 60000;
}

// "HH:MM"(JST) を基準時刻付近の絶対時刻(ms)へ。基準より12時間以上前なら翌日扱い。
export function hmToTs(hm, baseTs) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || "").trim());
  if (!m) return null;
  const p = jstParts(baseTs);
  const dayStartUtc = Date.UTC(p.y, p.m - 1, p.d) - JST;
  let ts = dayStartUtc + (Number(m[1]) * 60 + Number(m[2])) * 60000;
  if (ts < baseTs - 12 * 3600 * 1000) ts += 24 * 3600 * 1000;
  return ts;
}

// 値動きの単位。FXはpips、仮想通貨は価格の0.01%（bp）。仮想通貨は基準価格refが必要
export function pipSize(symbol, ref) {
  if (isCrypto(symbol)) return (ref > 0 ? ref : 1) * 0.0001;
  return symbol.endsWith("_JPY") ? 0.01 : 0.0001;
}

export function unitLabel(symbol) {
  return isCrypto(symbol) ? "bp" : "pips";
}

export function priceDigits(symbol) {
  if (isCrypto(symbol)) return CRYPTO_DIGITS[symbol] ?? 0;
  return symbol.endsWith("_JPY") ? 3 : 5;
}

// 往復の手数料（円）。仮想通貨の取引所レバレッジは取引手数料無料
export function feeOf(symbol, units, cfg) {
  if (isCrypto(symbol)) return 0;
  return cfg.feeOn ? cfg.feePerUnit * units * 2 : 0;
}

export function round(v, d = 0) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

// 決済通貨→円の換算レート
export function quoteToJpy(symbol, tickers) {
  const quote = symbol.split("_")[1];
  if (quote === "JPY") return 1;
  const t = tickers[`${quote}_JPY`];
  if (!t) return null;
  return (t.bid + t.ask) / 2;
}

export function pnlYen(side, entry, exit, units, conv) {
  const dir = side === "BUY" ? 1 : -1;
  return dir * (exit - entry) * units * conv;
}

export function mergeConfig(stored) {
  const c = { ...DEFAULT_CONFIG, ...(stored || {}) };
  c.sessions = { ...DEFAULT_CONFIG.sessions, ...(stored?.sessions || {}) };
  return c;
}

export const MIN_UNITS = 10000;

// 動かす銘柄の一覧（おまかせ時は検証に合格した銘柄、手動時は選んだ1銘柄）
export function portfolioOf(cfg) {
  if (cfg.symbolMode !== "auto") return [{ symbol: cfg.symbol, params: {} }];
  if (Array.isArray(cfg.portfolio) && cfg.portfolio.length) {
    return cfg.portfolio.filter((p) => SYMBOLS.includes(p?.symbol));
  }
  // 旧形式（1銘柄だけ採用していた頃）
  if (cfg.autoPickAt && !cfg.autoBlocked) return [{ symbol: cfg.symbol, params: {} }];
  return [];
}

// 銘柄ごとの実効設定（共通設定＋その銘柄で検証済みの設定）
export function cfgFor(cfg, item) {
  const p = item?.params || {};
  const a = assetOf(item.symbol);
  const spread = a === assetOf(cfg.symbol) ? cfg.maxSpreadPips : ASSET_DEFAULTS[a].maxSpreadPips;
  return {
    ...cfg,
    maxSpreadPips: spread,
    ...p,
    symbol: item.symbol,
    sessions: { ...cfg.sessions, ...(p.sessions || {}) },
  };
}

// 通貨ごとの向き（BUY USD_JPY = USD買い・JPY売り）
export function legsOf(symbol, side) {
  const [base, quote] = symbol.split("_");
  const d = side === "BUY" ? 1 : -1;
  return [
    [base, d],
    [quote, -d],
  ];
}
