import { requireAuth, sendError } from "./_lib/auth.js";
import { listReports, runReport } from "./_lib/report.js";

export default async function handler(req, res) {
  if (!requireAuth(req, res)) return;
  try {
    if (req.method === "GET") return res.status(200).json({ reports: await listReports(10) });
    if (req.method !== "POST") return res.status(405).json({ error: "Method Not Allowed" });
    return res
      .status(200)
      .json(await runReport({ kind: req.body?.kind === "weekly" ? "weekly" : "daily" }));
  } catch (e) {
    return sendError(res, e, 502);
  }
}
