import { useEffect, useRef } from "react";

function cssVar(n) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim();
}

// 損益曲線（0円ラインつき）
export default function Spark({ points, height = 120 }) {
  const box = useRef(null);
  const cv = useRef(null);
  useEffect(() => {
    const b = box.current;
    const c = cv.current;
    if (!b || !c) return;
    const draw = () => {
      const W = b.clientWidth;
      const H = height;
      const dpr = window.devicePixelRatio || 1;
      c.width = W * dpr;
      c.height = H * dpr;
      const ctx = c.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const vals = [0, ...(points || []).map((p) => p.v)];
      const hi = Math.max(...vals, 1);
      const lo = Math.min(...vals, -1);
      const y = (v) => 6 + ((hi - v) / (hi - lo)) * (H - 12);
      const x = (i) => (i / Math.max(1, vals.length - 1)) * W;
      ctx.strokeStyle = cssVar("--line");
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y(0));
      ctx.lineTo(W, y(0));
      ctx.stroke();
      ctx.setLineDash([]);
      const last = vals[vals.length - 1];
      ctx.strokeStyle = last >= 0 ? cssVar("--buy") : cssVar("--sell");
      ctx.lineWidth = 2;
      ctx.beginPath();
      vals.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
      ctx.stroke();
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(b);
    return () => ro.disconnect();
  }, [points, height]);
  return (
    <div ref={box} style={{ height }}>
      <canvas ref={cv} style={{ width: "100%", height }} aria-label="損益曲線" />
    </div>
  );
}
