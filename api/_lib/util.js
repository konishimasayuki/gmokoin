export const SYMBOLS = ["USD_JPY", "EUR_JPY", "GBP_JPY", "AUD_JPY", "EUR_USD", "GBP_USD"];

export const DEFAULT_CONFIG = {
  symbol: "USD_JPY",
  units: 10000,
  running: false,
  tickSec: 5,
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
  sessions: { tokyo: true, london: true, ny: true },
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
  minRr: 1.0,
  signalTf: 1, // シグナルを見る足（1分 or 5分）
  symbolMode: "auto", // auto=検証結果から自動で銘柄と設定を選ぶ / manual
  autoBlocked: false, // 自動選定で合格がなかったとき true（新規エントリー停止）
  autoPickAt: null,
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

export function pipSize(symbol) {
  return symbol.endsWith("_JPY") ? 0.01 : 0.0001;
}

export function priceDigits(symbol) {
  return symbol.endsWith("_JPY") ? 3 : 5;
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
