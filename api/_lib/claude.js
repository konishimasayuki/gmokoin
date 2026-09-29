const API_URL = "https://api.anthropic.com/v1/messages";

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

export function extractJson(text) {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (let i = fences.length - 1; i >= 0; i--) {
    const j = tryParse(fences[i][1]);
    if (j) return j;
  }
  const end = text.lastIndexOf("}");
  // 最後に出てくるトップレベルのJSONを優先
  for (
    let start = text.lastIndexOf("{", end);
    start >= 0;
    start = text.lastIndexOf("{", start - 1)
  ) {
    const j = tryParse(text.slice(start, end + 1));
    if (j && Object.keys(j).length > 1) return j;
    if (start === 0) break;
  }
  const a = text.indexOf("{");
  if (a >= 0 && end > a) return tryParse(text.slice(a, end + 1));
  return null;
}

// 役割(system)とプロンプトを渡してJSONを受け取る。searches>0ならweb検索を許可
export async function askClaude({ system, prompt, searches = 0, maxTokens = 2500 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY が未設定です");
  const model = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
  const headers = {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  };
  if (process.env.ANTHROPIC_WORKSPACE_ID) {
    headers["anthropic-workspace-id"] = process.env.ANTHROPIC_WORKSPACE_ID;
  }
  const messages = [{ role: "user", content: prompt }];
  const body = { model, max_tokens: maxTokens, system, messages };
  if (searches > 0)
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: searches }];

  let data = null;
  let text = "";
  for (let turn = 0; turn < 3; turn++) {
    const r = await fetch(API_URL, { method: "POST", headers, body: JSON.stringify(body) });
    data = await r.json().catch(() => null);
    if (!r.ok || !data)
      throw new Error(`Claude APIエラー: ${data?.error?.message || `HTTP ${r.status}`}`);
    text += (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (data.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: data.content });
      continue;
    }
    break;
  }
  const json = extractJson(text);
  if (!json) throw new Error("Claudeの回答からJSONを読み取れませんでした");
  return { json, model };
}

export const arr = (v, n = 6, len = 140) =>
  (Array.isArray(v) ? v : [])
    .slice(0, n)
    .map((s) => String(typeof s === "object" ? JSON.stringify(s) : s).slice(0, len));
