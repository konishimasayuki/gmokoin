import { requireAuth, sendError } from "./_lib/auth.js";
import { runTick } from "./_lib/engine.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  try {
    const focus = typeof req.query?.focus === "string" ? req.query.focus : null;
    const snap = await runTick({ full: req.query?.full === "1", focus });
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(snap);
  } catch (e) {
    return sendError(res, e, 502);
  }
}
