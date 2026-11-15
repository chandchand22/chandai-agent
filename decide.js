// Deterministic decision engine for Proof Gatekeeper tasks.
//
// Rules and reason codes are the seven documented cases from
// https://agentgames.zkverify.io/events/proof-gatekeeper ("Trap encyclopedia").
// Checks run in the encyclopedia's order; the first failing check wins:
//
//   1. proof_vk != registered_vk        -> REJECT / VK_SUBSTITUTION
//   2. public_balance < minimum         -> REJECT / THRESHOLD_MISMATCH
//   3. proof_tx seen in a previous task -> REJECT / PROOF_REUSED
//   4. current_block > expiry_block     -> REJECT / EXPIRED_CONDITION
//   5. recipient != condition_recipient -> REJECT / RECIPIENT_MISMATCH
//   6. amount > max_transfer            -> REJECT / AMOUNT_OVERFLOW
//   otherwise                           -> APPROVE / VALID_CONDITION
//
// Amounts are compared as BigInt. Hash/address fields are compared as
// normalized (lowercase, trimmed) hex strings. The engine is pure: the
// seen-set lookup is injected by the caller.

export const REASON = {
  VALID_CONDITION: "VALID_CONDITION",
  VK_SUBSTITUTION: "VK_SUBSTITUTION",
  THRESHOLD_MISMATCH: "THRESHOLD_MISMATCH",
  PROOF_REUSED: "PROOF_REUSED",
  EXPIRED_CONDITION: "EXPIRED_CONDITION",
  RECIPIENT_MISMATCH: "RECIPIENT_MISMATCH",
  AMOUNT_OVERFLOW: "AMOUNT_OVERFLOW",
  // Local extension, never produced for well-formed platform tasks: the
  // envelope parsed but a required field was missing or unparseable.
  INVALID_TASK: "INVALID_TASK",
};

const REQUIRED_FIELDS = [
  "registered_vk",
  "proof_vk",
  "minimum",
  "public_balance",
  "expiry_block",
  "current_block",
  "recipient",
  "condition_recipient",
  "amount",
  "max_transfer",
  "proof_tx",
];

function normHex(v) {
  return String(v).trim().toLowerCase();
}

function toBig(v) {
  // Accepts decimal strings, hex strings (0x...), and safe integers.
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("unsafe integer");
    return BigInt(v);
  }
  const s = String(v).trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
  if (/^-?\d+$/.test(s)) return BigInt(s);
  throw new Error(`not an integer: ${s}`);
}

// Parse + normalize the task input. Returns { fields } or { error }.
export function parseInput(input) {
  if (!input || typeof input !== "object") return { error: "missing input" };
  for (const f of REQUIRED_FIELDS) {
    if (input[f] === undefined || input[f] === null || input[f] === "") {
      return { error: `missing field: ${f}` };
    }
  }
  try {
    return {
      fields: {
        registered_vk: normHex(input.registered_vk),
        proof_vk: normHex(input.proof_vk),
        minimum: toBig(input.minimum),
        public_balance: toBig(input.public_balance),
        expiry_block: toBig(input.expiry_block),
        current_block: toBig(input.current_block),
        recipient: normHex(input.recipient),
        condition_recipient: normHex(input.condition_recipient),
        amount: toBig(input.amount),
        max_transfer: toBig(input.max_transfer),
        proof_tx: normHex(input.proof_tx),
      },
    };
  } catch (e) {
    return { error: String(e.message || e) };
  }
}

// isProofTxSeen: (proof_tx) => boolean, supplied by the caller (seen-store).
export function decide(fields, isProofTxSeen) {
  if (fields.proof_vk !== fields.registered_vk) {
    return { decision: "REJECT", reason_code: REASON.VK_SUBSTITUTION };
  }
  if (fields.public_balance < fields.minimum) {
    return { decision: "REJECT", reason_code: REASON.THRESHOLD_MISMATCH };
  }
  if (isProofTxSeen(fields.proof_tx)) {
    return { decision: "REJECT", reason_code: REASON.PROOF_REUSED };
  }
  if (fields.current_block > fields.expiry_block) {
    return { decision: "REJECT", reason_code: REASON.EXPIRED_CONDITION };
  }
  if (fields.recipient !== fields.condition_recipient) {
    return { decision: "REJECT", reason_code: REASON.RECIPIENT_MISMATCH };
  }
  if (fields.amount > fields.max_transfer) {
    return { decision: "REJECT", reason_code: REASON.AMOUNT_OVERFLOW };
  }
  return { decision: "APPROVE", reason_code: REASON.VALID_CONDITION };
}
