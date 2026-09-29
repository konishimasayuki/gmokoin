import { requireAuth, sendError } from "./_lib/auth.js";
import { manualClose } from "./_lib/engine.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  try {
    return res.status(200).json(await manualClose());
  } catch (e) {
    return sendError(res, e, 409);
  }
}
