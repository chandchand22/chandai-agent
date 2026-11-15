// chandai-agent — Proof Gatekeeper agent service.
//
// Flow per task (https://agentgames.zkverify.io/build + starter prompt):
//   1. Read the RAW body; verify HMAC (x-agent-games-signature) BEFORE parsing.
//   2. Parse the envelope { type, task_id, mode, issued_at, deadline_at, input }.
//   3. Idempotency: a re-delivered task_id gets its cached response back.
//   4. Record input.proof_tx in the persistent seen-set, then run the
//      deterministic decision engine (decide.js).
//   5. Unless the answer is PROOF_REUSED (for which no circuit witness
//      exists), generate the Groth16 decision proof locally with snarkjs.
//   6. If a Kurier API key is configured, submit the proof to zkVerify and
//      poll for Finalized within the remaining time budget; the finalized
//      transaction hash is attached as `proof_reference`.
//   7. Respond { decision, reason_code, proof_tx, proof, public_signals }
//      with an x-agent-games-signature header over the raw response body.
//      (proof_tx echo follows the event page's "Expected response shape";
//      proof/public_signals follow the official starter prompt.)
//
// Preflight/control POSTs (no `input` field) are answered with the signed
// { ok: true, protocolVersion: "v1" } reply the starter prompt specifies.
// GET /health returns the same object unsigned, for platform/fly health checks.

import http from "node:http";
import { config } from "./config.js";
import { SIGNATURE_HEADER, signBody, verifyBody } from "./hmac.js";
import { parseInput, decide, REASON } from "./decide.js";
import { SeenStore } from "./seen.js";
import { buildCircuitInputs, generateDecisionProof } from "./prove.js";
import { kurierEnabled, submitAndAwaitFinalized } from "./kurier.js";

const TASK_TYPE = "agent-games.proof-gatekeeper.v1";
const seen = new SeenStore(config.seenStorePath);

if (!config.hmacSecret) {
  console.warn(
    "WARNING: AGENT_GAMES_HMAC_SECRET is not set — inbound HMAC verification is DISABLED (local dev only)."
  );
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  const headers = { "content-type": "application/json" };
  if (config.hmacSecret) headers[SIGNATURE_HEADER] = signBody(body, config.hmacSecret);
  res.writeHead(status, headers);
  res.end(body);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleTask(req, res, envelope) {
  const started = Date.now();
  const taskId = String(envelope.task_id ?? "");
  if (!taskId) {
    return sendJson(res, 400, { error: "missing task_id" });
  }

  // Idempotent re-delivery of the same task: return the original response.
  const cached = seen.getResponse(taskId);
  if (cached) return sendJson(res, 200, cached);

  const { fields, error } = parseInput(envelope.input);
  if (error) {
    // Fail closed: a decision-shaped REJECT beats a timeout for scoring,
    // and a malformed task must never be approved.
    const response = {
      decision: "REJECT",
      reason_code: REASON.INVALID_TASK,
      proof_tx: envelope.input?.proof_tx ?? null,
      proof: null,
      public_signals: null,
    };
    console.error(`task ${taskId}: invalid input (${error})`);
    seen.recordResponse(taskId, response);
    return sendJson(res, 200, response);
  }

  // Record first, then decide: a proof_tx already recorded under a
  // different task_id is exactly the PROOF_REUSED trap.
  seen.recordProof(fields.proof_tx, taskId);
  const { decision, reason_code } = decide(fields, (tx) => seen.isReused(tx, taskId));

  const response = { decision, reason_code, proof_tx: fields.proof_tx, proof: null, public_signals: null };

  if (reason_code !== REASON.PROOF_REUSED) {
    try {
      const inputs = buildCircuitInputs(fields, decision, taskId);
      const { proof, publicSignals } = await generateDecisionProof(inputs);
      response.proof = proof;
      response.public_signals = publicSignals;

      if (kurierEnabled()) {
        const remaining = config.requestBudgetMs - (Date.now() - started);
        const budget = Math.min(config.kurierWaitMs, Math.max(0, remaining));
        if (budget > 0) {
          const k = await submitAndAwaitFinalized(proof, publicSignals, budget);
          if (k && k.status === "Finalized" && k.txHash) {
            response.proof_reference = k.txHash;
          }
        }
      }
    } catch (e) {
      // The decision stands; only the proof is missing. This should be
      // impossible when the engine and the circuit agree (see prove.js).
      console.error(`task ${taskId}: proof generation failed:`, e.message);
    }
  }

  seen.recordResponse(taskId, response);
  return sendJson(res, 200, response);
}

async function handleAgentPost(req, res) {
  let raw;
  try {
    raw = await readRawBody(req);
  } catch {
    return sendJson(res, 413, { error: "body too large" });
  }

  // HMAC over the raw body, BEFORE parsing — per the official spec.
  if (config.hmacSecret) {
    const ok = verifyBody(raw, req.headers[SIGNATURE_HEADER], config.hmacSecret);
    if (!ok) return sendJson(res, 401, { error: "invalid signature" });
  }

  let envelope;
  try {
    envelope = JSON.parse(raw.toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "invalid json" });
  }

  // Preflight / control messages carry no task input.
  if (!envelope || typeof envelope !== "object" || envelope.input === undefined) {
    return sendJson(res, 200, { ok: true, protocolVersion: "v1" });
  }
  if (envelope.type !== undefined && envelope.type !== TASK_TYPE) {
    return sendJson(res, 400, { error: `unsupported type: ${envelope.type}` });
  }
  return handleTask(req, res, envelope);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET") {
    return sendJson(res, 200, { ok: true, protocolVersion: "v1", agent: "chandai-agent" });
  }
  if (req.method === "POST" && (url.pathname === config.agentPath || url.pathname === "/")) {
    handleAgentPost(req, res).catch((e) => {
      console.error("handler error:", e);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    });
    return;
  }
  return sendJson(res, 404, { error: "not found" });
});

server.listen(config.port, () => {
  console.log(
    `chandai-agent listening on :${config.port} (agent path ${config.agentPath}, kurier ${kurierEnabled() ? "enabled" : "disabled"})`
  );
});
