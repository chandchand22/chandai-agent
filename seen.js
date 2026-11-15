// Persistent seen-set for proof references (PROOF_REUSED detection) plus a
// per-task response cache.
//
// Semantics:
//   - A proof_tx is "reused" when it was first recorded under a DIFFERENT
//     task_id (the trap is a valid proof re-submitted for a new task).
//   - If the platform re-delivers the SAME task_id (e.g. our response was
//     lost), the cached original response is returned verbatim instead of
//     being misjudged as reuse.
//
// State is kept in memory and persisted to a JSON file with atomic
// write-temp-then-rename saves, so restarts do not lose the seen-set.

import fs from "node:fs";
import path from "node:path";

export class SeenStore {
  constructor(filePath) {
    this.filePath = filePath;
    // proof_tx -> { task_id, first_seen_at }
    this.proofs = new Map();
    // task_id -> response object (for idempotent re-delivery)
    this.responses = new Map();
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw);
      for (const [k, v] of Object.entries(data.proofs || {})) this.proofs.set(k, v);
      for (const [k, v] of Object.entries(data.responses || {})) this.responses.set(k, v);
    } catch {
      // Missing or unreadable store: start empty. Failing open here only
      // weakens reuse detection for pre-restart tasks; decisions stay safe.
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      const data = {
        proofs: Object.fromEntries(this.proofs),
        responses: Object.fromEntries(this.responses),
      };
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      console.error("seen-store save failed:", e.message);
    }
  }

  // True if this proof_tx was recorded under a different task_id.
  isReused(proofTx, taskId) {
    const rec = this.proofs.get(proofTx);
    return Boolean(rec) && rec.task_id !== taskId;
  }

  // Record a proof_tx the first time it is seen. Returns true if it was new.
  recordProof(proofTx, taskId) {
    if (this.proofs.has(proofTx)) return false;
    this.proofs.set(proofTx, { task_id: taskId, first_seen_at: new Date().toISOString() });
    this.save();
    return true;
  }

  getResponse(taskId) {
    return this.responses.get(taskId);
  }

  recordResponse(taskId, response) {
    this.responses.set(taskId, response);
    this.save();
  }
}
