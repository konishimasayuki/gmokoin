import { requireAuth, sendError } from "./_lib/auth.js";
import { runRegime } from "./_lib/regime.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  try {
    const out = await runRegime({ force: Boolean(req.body?.force) });
    return res.status(200).json(out);
  } catch (e) {
    return sendError(res, e, 502);
  }
}
