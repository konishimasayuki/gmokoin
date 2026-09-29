import { requireAuth, sendError } from "./_lib/auth.js";
import { runBrief } from "./_lib/brief.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  try {
    return res.status(200).json(await runBrief({ force: Boolean(req.body?.force) }));
  } catch (e) {
    return sendError(res, e, 502);
  }
}
