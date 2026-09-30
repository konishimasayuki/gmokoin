import { waitUntil } from "@vercel/functions";
import { requireAuth, sendError } from "./_lib/auth.js";
import { SYMBOLS, finalizeOptimize, optimizeSymbol } from "./_lib/optimize.js";
import { finalizeWW, optimizeSymbolWW, wwTargets } from "./_lib/optww.js";
import { K, addLog, redis } from "./_lib/redis.js";
import { mergeConfig } from "./_lib/util.js";

const STALL_MS = 6 * 60 * 1000;

function selfUrl(req) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}/api/optimize`;
}

// 次の段階を別の呼び出しとして起動する（呼び出し先はすぐ応答し、裏で計算を続ける）
function kick(req, token) {
  return fetch(selfUrl(req), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "bgstep", token }),
  }).catch(() => {});
}

function jobView(job) {
  if (!job) return null;
  const stalled = job.status === "running" && Date.now() - job.updatedAt > STALL_MS;
  return { ...job, token: undefined, status: stalled ? "stalled" : job.status };
}

// バックグラウンドの1段階：1銘柄を検証 → 次を起動。最後に全銘柄まとめ
async function step(req, token) {
  const job = await redis.get(K.optJob);
  if (!job || job.token !== token || job.status !== "running") return;
  const cfg = mergeConfig(await redis.get(K.config));
  const wwOnly = (cfg.optStrategies || ["ww"]).join(",") === "ww";
  if (job.i < job.list.length) {
    const symbol = job.list[job.i];
    await redis.set(K.optJob, { ...job, current: symbol, updatedAt: Date.now() });
    let err = null;
    try {
      await (wwOnly ? optimizeSymbolWW : optimizeSymbol)(symbol);
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    const next = {
      ...job,
      i: job.i + 1,
      current: null,
      updatedAt: Date.now(),
      errors: err ? [...(job.errors || []), `${symbol}：${err}`] : job.errors || [],
    };
    await redis.set(K.optJob, next);
    await kick(req, token);
    return;
  }
  await redis.set(K.optJob, { ...job, current: "まとめ", updatedAt: Date.now() });
  await (wwOnly ? finalizeWW : finalizeOptimize)({ apply: job.apply });
  await redis.set(K.optJob, {
    ...job,
    status: "done",
    current: null,
    updatedAt: Date.now(),
    doneAt: Date.now(),
  });
  await addLog("バックグラウンドの検証が終わりました", "regime");
}

export default async function handler(req, res) {
  // バックグラウンドの内部呼び出し（ログイン不要。合言葉で確認）
  if (req.method === "POST" && req.body?.action === "bgstep") {
    const token = String(req.body.token || "");
    res.status(202).json({ ok: true });
    waitUntil(step(req, token));
    return;
  }
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === "GET") {
      const [last, job] = await redis.mget(K.optimizeLast, K.optJob);
      const c = mergeConfig(await redis.get(K.config));
      const ww = (c.optStrategies || ["ww"]).join(",") === "ww";
      return res.status(200).json({
        result: last?.rule?.weekWin ? last : null,
        symbols: ww ? wwTargets(c) : SYMBOLS,
        job: jobView(job),
      });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    const body = req.body || {};
    const cfg = mergeConfig(await redis.get(K.config));
    const wwOnly = (cfg.optStrategies || ["ww"]).join(",") === "ww";
    if (body.action === "background") {
      const cur = jobView(await redis.get(K.optJob));
      if (cur?.status === "running") return res.status(200).json({ job: cur });
      const old = await redis.get(K.optJob);
      const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
      // 止まっていたら続きから、それ以外は最初から
      const resume = cur?.status === "stalled" && old;
      const job = resume
        ? { ...old, token, status: "running", updatedAt: Date.now() }
        : {
            list: wwOnly ? wwTargets(cfg) : SYMBOLS,
            i: 0,
            apply: Boolean(body.apply),
            status: "running",
            startedAt: Date.now(),
            updatedAt: Date.now(),
            errors: [],
            token,
          };
      await redis.set(K.optJob, job, { ex: 60 * 60 * 24 * 3 });
      waitUntil(kick(req, token));
      return res.status(200).json({ job: jobView(job) });
    }
    if (body.action === "symbol") {
      if (!SYMBOLS.includes(body.symbol))
        return res.status(400).json({ error: "対応していない銘柄です" });
      return res.status(200).json({
        symbolResult: await (wwOnly ? optimizeSymbolWW : optimizeSymbol)(body.symbol, {
          force: Boolean(body.force),
        }),
      });
    }
    if (body.action === "finalize") {
      return res.status(200).json({
        result: await (wwOnly ? finalizeWW : finalizeOptimize)({ apply: Boolean(body.apply) }),
      });
    }
    return res.status(400).json({ error: "action を指定してください" });
  } catch (e) {
    return sendError(res, e, 502);
  }
}
