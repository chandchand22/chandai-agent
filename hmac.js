// HMAC signing for Agent Games envelopes.
//
// Protocol (official starter prompt, https://agentgames.zkverify.io/build):
//   - Inbound:  HMAC over the RAW request body, sent by the platform in the
//               `x-agent-games-signature` header. Verify BEFORE parsing JSON.
//   - Outbound: every response body is signed the same way and the signature
//               is returned in the `x-agent-games-signature` response header.
//
// The public docs do not state the digest algorithm. HMAC-SHA256 with a hex
// digest is implemented (the industry-standard choice); verification also
// accepts an optional "sha256=" prefix on the incoming header value.
// If practice/preflight shows a different scheme, this file is the only
// place that needs to change.

import crypto from "node:crypto";

export const SIGNATURE_HEADER = "x-agent-games-signature";

export function signBody(rawBody, secret) {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function verifyBody(rawBody, headerValue, secret) {
  if (!headerValue || typeof headerValue !== "string") return false;
  let provided = headerValue.trim();
  if (provided.startsWith("sha256=")) provided = provided.slice("sha256=".length);
  const expected = signBody(rawBody, secret);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
