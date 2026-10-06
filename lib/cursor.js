const API = "https://api.cursor.com";

function authHeader(key) {
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

function errorMessage(body, status) {
  if (typeof body?.error === "string") return body.error;
  if (body?.error?.message) return body.error.message;
  if (body?.message) return body.message;
  return `Cursor HTTP ${status}`;
}

async function cursorRequest(key, path, { method = "GET", body, timeoutMs = 30000 } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: authHeader(key),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(errorMessage(json, response.status));
    error.status = response.status;
    throw error;
  }
  return json;
}

async function cursorAccount(key) {
  return cursorRequest(key, "/v1/me");
}

function modelSelection(model) {
  const id = String(model || "").trim();
  if (!id || id === "default" || id === "auto") return null;
  return { id };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRun(key, agentId, runId, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const run = await cursorRequest(key, `/v1/agents/${agentId}/runs/${runId}`);
    if (run.status === "FINISHED") return String(run.result || "");
    if (run.status === "ERROR" || run.status === "CANCELLED" || run.status === "EXPIRED") {
      throw new Error(run.result || `Cursor ${run.status}`);
    }
    await sleep(4000);
  }
  await cursorRequest(key, `/v1/agents/${agentId}/runs/${runId}/cancel`, { method: "POST" }).catch(() => {});
  throw new Error("Cursor a dépassé 3 minutes pour cette question.");
}

function createCursorSession({ key, model }) {
  let agentId = null;
  const selection = modelSelection(model);
  return {
    async reply(prompt) {
      if (!agentId) {
        const created = await cursorRequest(key, "/v1/agents", {
          method: "POST",
          timeoutMs: 90000,
          body: {
            prompt: { text: prompt },
            ...(selection ? { model: selection } : {}),
            name: "Collecte agenda 06",
            autoCreatePR: false,
            mode: "agent",
          },
        });
        agentId = created.agent?.id || "";
        const runId = created.run?.id || created.agent?.latestRunId || "";
        if (!agentId || !runId) throw new Error("Cursor n’a pas renvoyé d’agent.");
        return waitForRun(key, agentId, runId, 180000);
      }
      const follow = await cursorRequest(key, `/v1/agents/${agentId}/runs`, {
        method: "POST",
        body: { prompt: { text: prompt }, mode: "agent" },
      });
      const runId = follow.run?.id || "";
      if (!runId) throw new Error("Cursor n’a pas renvoyé de suite.");
      return waitForRun(key, agentId, runId, 180000);
    },
    async close() {
      if (!agentId) return;
      const id = agentId;
      agentId = null;
      await cursorRequest(key, `/v1/agents/${id}`, { method: "DELETE" }).catch(() => {});
    },
  };
}

module.exports = { cursorAccount, createCursorSession };
