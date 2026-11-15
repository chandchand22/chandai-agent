// Kurier (zkVerify) proof submission — REST API.
// Docs: https://docs.zkverify.io/overview/getting-started/kurier
//
//   POST {KURIER_API_URL}/submit-proof/{API_KEY}
//     { proofType: "groth16", vkRegistered: true,
//       proofOptions: { library: "snarkjs", curve: "bn128" },
//       proofData: { proof, publicSignals, vk: <vkHash> } }
//     -> { jobId, optimisticVerify: "success" }
//
//   GET  {KURIER_API_URL}/job-status/{API_KEY}/{jobId}
//     -> { status: Queued|Valid|Submitted|IncludedInBlock|Finalized|Failed,
//          txHash, ... }
//
// The gatekeeper verification key is already registered on zkVerify mainnet
// (vkHash published at https://agentgames.zkverify.io/api/circuit-info), so
// no register-vk call is needed. All functions fail soft (return null):
// Kurier anchoring must never block or break the 60-second task response.

import { config } from "./config.js";

export function kurierEnabled() {
  return Boolean(config.kurierApiKey);
}

async function submitProof(proof, publicSignals) {
  const url = `${config.kurierApiUrl}/submit-proof/${config.kurierApiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      proofType: "groth16",
      vkRegistered: true,
      proofOptions: { library: "snarkjs", curve: "bn128" },
      proofData: { proof, publicSignals, vk: config.gatekeeperVkHash },
    }),
  });
  if (!res.ok) throw new Error(`kurier submit-proof HTTP ${res.status}`);
  const data = await res.json();
  if (data.optimisticVerify !== "success") {
    throw new Error(`kurier optimisticVerify=${data.optimisticVerify}`);
  }
  return data.jobId;
}

async function jobStatus(jobId) {
  const url = `${config.kurierApiUrl}/job-status/${config.kurierApiKey}/${jobId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`kurier job-status HTTP ${res.status}`);
  return res.json();
}

// Submit and poll until Finalized or the budget runs out.
// Returns { jobId, status, txHash } or null when Kurier is unavailable.
export async function submitAndAwaitFinalized(proof, publicSignals, budgetMs) {
  if (!kurierEnabled()) return null;
  const deadline = Date.now() + budgetMs;
  try {
    const jobId = await submitProof(proof, publicSignals);
    let last = { jobId, status: "Submitted", txHash: null };
    while (Date.now() < deadline) {
      const s = await jobStatus(jobId);
      last = { jobId, status: s.status, txHash: s.txHash || null };
      if (s.status === "Finalized" || s.status === "Failed") break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    return last;
  } catch (e) {
    console.error("kurier submission failed (continuing without it):", e.message);
    return null;
  }
}
