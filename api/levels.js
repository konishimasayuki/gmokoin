import { requireAuth, sendError } from "./_lib/auth.js";
import { ensureLevels } from "./_lib/levels.js";
import { K, redis } from "./_lib/redis.js";
import { mergeConfig } from "./_lib/util.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    const cfg = mergeConfig(await redis.get(K.config));
    const force = req.method === "POST" && Boolean(req.body?.force);
    return res.status(200).json({ levels: await ensureLevels(cfg.symbol, { force }) });
  } catch (e) {
    return sendError(res, e, 502);
  }
}
