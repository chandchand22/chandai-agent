// Central configuration, loaded from environment variables only.
// No secret is ever hardcoded or logged.

import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function int(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  root,
  port: int("PORT", 8080),
  // Path the platform POSTs tasks to. Register this exact path in the dashboard.
  agentPath: process.env.AGENT_PATH || "/agent",
  // Platform-generated HMAC secret (dashboard -> agent -> "Rotate Secret").
  // AGENT_GAMES_HMAC_SECRET is the name used by the official starter prompt;
  // AGENT_GAMES_SECRET is accepted as a fallback alias.
  hmacSecret:
    process.env.AGENT_GAMES_HMAC_SECRET || process.env.AGENT_GAMES_SECRET || "",
  // Kurier (zkVerify) proof submission. Optional: without a key the agent still
  // answers with its locally generated proof, it just cannot anchor it on-chain.
  kurierApiKey: process.env.KURIER_API_KEY || "",
  kurierApiUrl: (process.env.KURIER_API_URL || "https://api.kurier.xyz/api/v1").replace(/\/$/, ""),
  // How long to wait for Kurier finalization before answering anyway.
  // The platform's hard response deadline is 60s; proving takes ~1s.
  kurierWaitMs: int("KURIER_WAIT_MS", 40_000),
  // Gatekeeper circuit verification-key hash, registered on zkVerify mainnet.
  // Source: https://agentgames.zkverify.io/api/circuit-info
  gatekeeperVkHash:
    process.env.GATEKEEPER_VK_HASH ||
    "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0",
  circuitsDir: process.env.CIRCUITS_DIR || path.join(root, "circuits"),
  seenStorePath:
    process.env.SEEN_STORE_PATH || path.join(root, "data", "seen.json"),
  // How the envelope's string task_id (e.g. "gk_24_9d1") is mapped to the
  // circuit's numeric `taskId` field element. See README "Unresolved items".
  //   "sha256"  -> BigInt(sha256(task_id)) mod BN254 prime   (default)
  //   "numeric" -> the task_id itself if it is a decimal integer, else sha256
  taskIdMode: process.env.TASK_ID_MODE || "sha256",
  // Overall per-request budget; optional stages are skipped past this point.
  requestBudgetMs: int("REQUEST_BUDGET_MS", 55_000),
};
