import { requireAuth, sendError } from "./_lib/auth.js";
import { runOptimize } from "./_lib/optimize.js";
import { K, redis } from "./_lib/redis.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === "GET")
      return res.status(200).json({ result: await redis.get(K.optimizeLast) });
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    return res.status(200).json({ result: await runOptimize({ apply: Boolean(req.body?.apply) }) });
  } catch (e) {
    return sendError(res, e, 502);
  }
}
