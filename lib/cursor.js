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

async function cursorRequest(key, path, { method = "GET", body, timeoutMs = 30000, signal } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: authHeader(key),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
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

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("Collecte interrompue."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("Collecte interrompue."));
    }, { once: true });
  });
}

function busyRun(error) {
  return /active run/i.test(error?.message || "");
}

async function startRun(key, path, body, signal) {
  let last;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await cursorRequest(key, path, { method: "POST", timeoutMs: 90000, signal, body });
    } catch (error) {
      last = error;
      if (!busyRun(error) || attempt === 3) throw error;
      await sleep(5000 * (attempt + 1), signal);
    }
  }
  throw last;
}

async function waitForRun(key, agentId, runId, timeoutMs, signal) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (signal?.aborted) {
      await cursorRequest(key, `/v1/agents/${agentId}/runs/${runId}/cancel`, { method: "POST" }).catch(() => {});
      throw signal.reason || new Error("Collecte interrompue.");
    }
    const run = await cursorRequest(key, `/v1/agents/${agentId}/runs/${runId}`, { signal });
    if (run.status === "FINISHED") return String(run.result || "");
    if (run.status === "ERROR" || run.status === "CANCELLED" || run.status === "EXPIRED") {
      throw new Error(run.result || `Cursor ${run.status}`);
    }
    await sleep(4000, signal);
  }
  await cursorRequest(key, `/v1/agents/${agentId}/runs/${runId}/cancel`, { method: "POST" }).catch(() => {});
  throw new Error("Cursor a dépassé le délai pour cette question.");
}

function createCursorSession({ key, model, signal }) {
  let agentId = null;
  const selection = modelSelection(model);
  return {
    async reply(prompt, timeoutMs = 180000) {
      if (signal?.aborted) throw signal.reason || new Error("Collecte interrompue.");
      if (!agentId) {
        const created = await startRun(key, "/v1/agents", {
          prompt: { text: prompt },
          ...(selection ? { model: selection } : {}),
          name: "Collecte agenda 06",
          autoCreatePR: false,
          mode: "agent",
        }, signal);
        agentId = created.agent?.id || "";
        const runId = created.run?.id || created.agent?.latestRunId || "";
        if (!agentId || !runId) throw new Error("Cursor n’a pas renvoyé d’agent.");
        return waitForRun(key, agentId, runId, timeoutMs, signal);
      }
      const follow = await startRun(key, `/v1/agents/${agentId}/runs`, {
        prompt: { text: prompt },
        mode: "agent",
      }, signal);
      const runId = follow.run?.id || "";
      if (!runId) throw new Error("Cursor n’a pas renvoyé de suite.");
      return waitForRun(key, agentId, runId, timeoutMs, signal);
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
