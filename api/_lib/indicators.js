export function sma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

export function ema(values, n) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (n + 1);
  let e = null;
  for (let i = 0; i < values.length; i++) {
    e = e === null ? values[i] : values[i] * k + e * (1 - k);
    if (i >= n - 1) out[i] = e;
  }
  return out;
}

export function rsi(values, n = 14) {
  const out = new Array(values.length).fill(null);
  let g = 0;
  let l = 0;
  for (let i = 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const up = Math.max(d, 0);
    const dn = Math.max(-d, 0);
    if (i <= n) {
      g += up;
      l += dn;
      if (i === n) {
        g /= n;
        l /= n;
        out[i] = 100 - 100 / (1 + g / (l || 1e-12));
      }
    } else {
      g = (g * (n - 1) + up) / n;
      l = (l * (n - 1) + dn) / n;
      out[i] = 100 - 100 / (1 + g / (l || 1e-12));
    }
  }
  return out;
}

export function atr(candles, n = 14) {
  const out = new Array(candles.length).fill(null);
  let a = null;
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const tr =
      i === 0
        ? c.h - c.l
        : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c));
    if (i < n) {
      sum += tr;
      if (i === n - 1) {
        a = sum / n;
        out[i] = a;
      }
    } else {
      a = (a * (n - 1) + tr) / n;
      out[i] = a;
    }
  }
  return out;
}

export function bollinger(values, n = 20, k = 2) {
  const mid = sma(values, n);
  return values.map((_, i) => {
    if (mid[i] === null) return null;
    let s = 0;
    for (let j = i - n + 1; j <= i; j++) s += (values[j] - mid[i]) ** 2;
    const sd = Math.sqrt(s / n);
    return { mid: mid[i], up: mid[i] + k * sd, lo: mid[i] - k * sd };
  });
}

export function computeScalpIndicators(candles) {
  const closes = candles.map((c) => c.c);
  return {
    ema9: ema(closes, 9),
    ema21: ema(closes, 21),
    rsi7: rsi(closes, 7),
    atr14: atr(candles, 14),
    bb: bollinger(closes, 20, 2),
  };
}
