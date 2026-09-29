import { useEffect, useRef } from "react";

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export default function Chart({ chart, position, bid, digits }) {
  const boxRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    const box = boxRef.current;
    const cv = canvasRef.current;
    if (!box || !cv) return;

    const draw = () => {
      const ctx = cv.getContext("2d");
      const W = box.clientWidth;
      const H = box.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      cv.width = W * dpr;
      cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const cs = chart?.candles || [];
      if (!cs.length) {
        ctx.fillStyle = cssVar("--muted");
        ctx.font = '13px "Zen Kaku Gothic New", sans-serif';
        ctx.fillText("1分足を読み込み中", 12, H / 2);
        return;
      }
      const C = {
        ink: cssVar("--ink"),
        muted: cssVar("--muted"),
        line: cssVar("--line"),
        buy: cssVar("--buy"),
        sell: cssVar("--sell"),
        brass: cssVar("--brass"),
        surface: cssVar("--surface"),
      };
      const axisW = 56;
      const plotW = W - axisW;
      const cw = plotW / cs.length;
      let hi = Math.max(...cs.map((c) => c.h));
      let lo = Math.min(...cs.map((c) => c.l));
      const levels = [];
      if (bid) levels.push(bid);
      if (position) levels.push(position.entry, position.sl, position.tp);
      for (const v of levels) {
        hi = Math.max(hi, v);
        lo = Math.min(lo, v);
      }
      const pad = (hi - lo) * 0.08 || 0.001;
      hi += pad;
      lo -= pad;
      const y = (v) => 6 + ((hi - v) / (hi - lo)) * (H - 12);
      const x = (i) => i * cw + cw / 2;

      ctx.font = '12px "Barlow Condensed", sans-serif';
      ctx.textBaseline = "middle";
      for (let g = 0; g <= 4; g++) {
        const v = lo + ((hi - lo) * g) / 4;
        const yy = y(v);
        ctx.strokeStyle = C.line;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(plotW, yy);
        ctx.stroke();
        ctx.fillStyle = C.muted;
        ctx.fillText(v.toFixed(digits), plotW + 5, yy);
      }

      cs.forEach((c, i) => {
        const col = c.c >= c.o ? C.buy : C.sell;
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.moveTo(x(i), y(c.h));
        ctx.lineTo(x(i), y(c.l));
        ctx.stroke();
        const bw = Math.max(1.5, cw * 0.62);
        const top = y(Math.max(c.o, c.c));
        const bh = Math.max(1, Math.abs(y(c.o) - y(c.c)));
        ctx.fillRect(x(i) - bw / 2, top, bw, bh);
      });

      const line = (arr, col, w) => {
        if (!arr) return;
        ctx.strokeStyle = col;
        ctx.lineWidth = w;
        ctx.beginPath();
        let started = false;
        arr.forEach((v, i) => {
          if (v === null || v === undefined) return;
          if (started) ctx.lineTo(x(i), y(v));
          else ctx.moveTo(x(i), y(v));
          started = true;
        });
        ctx.stroke();
      };
      line(chart.ema9, C.brass, 1.6);
      line(chart.ema21, C.muted, 1.2);

      const tag = (v, col, label, dashed) => {
        const yy = y(v);
        if (dashed) ctx.setLineDash([5, 4]);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, yy);
        ctx.lineTo(plotW, yy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = col;
        ctx.fillRect(plotW, yy - 9, axisW, 18);
        ctx.fillStyle = C.surface;
        ctx.fillText(v.toFixed(digits), plotW + 4, yy);
        if (label) {
          ctx.fillStyle = col;
          ctx.font = '11px "Zen Kaku Gothic New", sans-serif';
          ctx.fillText(label, 4, yy - 9);
          ctx.font = '12px "Barlow Condensed", sans-serif';
        }
      };
      if (position) {
        tag(position.tp, C.buy, "利確", true);
        tag(position.sl, C.sell, "損切", true);
        tag(position.entry, C.ink, position.side === "BUY" ? "買い" : "売り", true);
      }
      if (bid) tag(bid, C.ink, "", false);
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(box);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", draw);
    return () => {
      ro.disconnect();
      mq.removeEventListener?.("change", draw);
    };
  }, [chart, position, bid, digits]);

  return (
    <div className="chart" ref={boxRef}>
      <canvas ref={canvasRef} aria-label="1分足チャート" />
    </div>
  );
}
