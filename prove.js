// Groth16 decision proofs with the official gatekeeper circuit (snarkjs).
//
// Circuit facts, resolved empirically from the published artifacts
// (gatekeeper.wasm / gatekeeper_final.zkey) — see README "Protocol facts":
//
//   13 input signals: registeredVkHash, proofVkHash, minimum, publicBalance,
//   expiryBlock, currentBlock, recipient, conditionRecipient, amount,
//   maxTransfer, decision, taskId, salt (private).
//
//   The circuit enforces  decision == 1  IFF  every check passes
//   (vk equal, balance >= minimum, current <= expiry, recipient equal,
//   amount <= max). A wrong decision has no witness: fullProve throws.
//   That is why PROOF_REUSED answers carry no proof — a reused task is
//   otherwise valid, so a REJECT witness does not exist for it.
//
//   Public signals (13, in order): [ saltCommitment, registeredVkHash,
//   proofVkHash, minimum, publicBalance, expiryBlock, currentBlock,
//   recipient, conditionRecipient, amount, maxTransfer, decision, taskId ]
//   where index 0 is a circuit output that depends only on the salt.
//
// Encodings: hashes and addresses are field elements = BigInt(hex) mod p.
// taskId: see deriveTaskId() and the README's unresolved-items list.

import crypto from "node:crypto";
import path from "node:path";
import * as snarkjs from "snarkjs";
import { config } from "./config.js";

export const BN254_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export function fieldFromHex(hex) {
  const v = BigInt(String(hex).trim());
  return (v % BN254_PRIME).toString();
}

export function deriveTaskId(taskIdRaw) {
  const s = String(taskIdRaw);
  if (config.taskIdMode === "numeric" && /^\d+$/.test(s)) {
    return (BigInt(s) % BN254_PRIME).toString();
  }
  const digest = crypto.createHash("sha256").update(s, "utf8").digest("hex");
  return (BigInt("0x" + digest) % BN254_PRIME).toString();
}

function randomSalt() {
  // 31 random bytes always fit inside the BN254 scalar field.
  return BigInt("0x" + crypto.randomBytes(31).toString("hex")).toString();
}

// Build the circuit input object from normalized decision-engine fields.
// `fields` is the output of decide.js parseInput(); decision is "APPROVE"|"REJECT".
export function buildCircuitInputs(fields, decision, taskIdRaw) {
  return {
    registeredVkHash: fieldFromHex(fields.registered_vk),
    proofVkHash: fieldFromHex(fields.proof_vk),
    minimum: fields.minimum.toString(),
    publicBalance: fields.public_balance.toString(),
    expiryBlock: fields.expiry_block.toString(),
    currentBlock: fields.current_block.toString(),
    recipient: fieldFromHex(fields.recipient),
    conditionRecipient: fieldFromHex(fields.condition_recipient),
    amount: fields.amount.toString(),
    maxTransfer: fields.max_transfer.toString(),
    decision: decision === "APPROVE" ? "1" : "0",
    taskId: deriveTaskId(taskIdRaw),
    salt: randomSalt(),
  };
}

// Generate the proof. Resolves { proof, publicSignals }; throws if the
// circuit rejects the witness (which should be impossible when the decision
// engine and the circuit agree — a throw here means a bug or malformed task).
export async function generateDecisionProof(inputs) {
  const wasm = path.join(config.circuitsDir, "gatekeeper.wasm");
  const zkey = path.join(config.circuitsDir, "gatekeeper_final.zkey");
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasm, zkey);
  return { proof, publicSignals };
}
