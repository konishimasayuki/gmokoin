export const MODE_JP = {
  TREND_UP: "上昇トレンド",
  TREND_DOWN: "下降トレンド",
  RANGE: "レンジ",
  NO_TRADE: "見送り",
};

export const ALLOW_JP = {
  LONG: "買いのみ",
  SHORT: "売りのみ",
  BOTH: "買い・売り両方",
  NONE: "取引しない",
};

export const SIDE_JP = { BUY: "買い", SELL: "売り" };

export function price(v, d) {
  return v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(d);
}

export function yen(v) {
  if (v === null || v === undefined) return "—";
  const n = Math.round(Number(v));
  return `${n > 0 ? "+" : ""}${n.toLocaleString("ja-JP")}円`;
}

export function pips(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}`;
}

export function tone(v) {
  if (!v) return "";
  return v > 0 ? "up" : "down";
}

export function hm(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function mdhm(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${hm(ts)}`;
}

export function symbolLabel(s) {
  return String(s || "").replace("_", "/");
}

export const CRITIC_JP = { AGREE: "同意", WEAKEN: "弱め", VETO: "却下" };

export const CRYPTO = ["BTC_JPY", "ETH_JPY", "XRP_JPY", "BCH_JPY", "LTC_JPY"];
export const isCrypto = (s) => CRYPTO.includes(s);
export const qtyLabel = (s) => (isCrypto(s) ? s.split("_")[0] : "通貨");
