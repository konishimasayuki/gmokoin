import { requireAuth, sendError } from "./_lib/auth.js";
import { BRAIN_IDS } from "./_lib/brains.js";
import { runAiBrain } from "./_lib/regime.js";

// AI型の脳に判定させる
export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
  const id = req.body?.id;
  if (!BRAIN_IDS.includes(id)) return res.status(400).json({ error: "脳のIDが不正です" });
  if (!process.env.ANTHROPIC_API_KEY)
    return res.status(400).json({ error: "Claude APIが未接続です" });
  try {
    return res.status(200).json(
      await runAiBrain({
        id,
        force: Boolean(req.body?.force),
        shadow: Boolean(req.body?.shadow),
      }),
    );
  } catch (e) {
    return sendError(res, e, 502);
  }
}
