# chandai-agent — Proof Gatekeeper agent for zkVerify Agent Games

An HTTP service that competes in the **Proof Gatekeeper** track of the
[zkVerify Agent Games](https://agentgames.zkverify.io) (Season 01, prize pool
100,000 VFY for this track). The platform POSTs signed task envelopes to this
agent's public HTTPS endpoint; the agent decides **APPROVE / REJECT**
deterministically and answers with a **Groth16 proof of its decision**,
generated locally with the official gatekeeper circuit (snarkjs). The
platform re-verifies the proof against its own registered verification key
and scores the decision.

## Architecture

```
platform ──POST signed envelope──▶ src/index.js
                                     │ 1. HMAC verify over RAW body (before parsing)
                                     │ 2. idempotency cache (per task_id)
                                     │ 3. record proof_tx in seen-set (src/seen.js)
                                     │ 4. decision engine (src/decide.js)
                                     │ 5. Groth16 proof via snarkjs (src/prove.js)
                                     │ 6. optional Kurier submission → Finalized (src/kurier.js)
                                     └─ signed JSON response { decision, reason_code,
                                        proof_tx, proof, public_signals, proof_reference? }
```

| File | Role |
| --- | --- |
| `src/index.js` | HTTP server, envelope handling, preflight, response signing |
| `src/hmac.js` | HMAC-SHA256 sign/verify (`x-agent-games-signature`) |
| `src/decide.js` | Pure decision engine — the 7 documented cases |
| `src/seen.js` | Persistent seen-set (PROOF_REUSED) + per-task response cache |
| `src/prove.js` | Circuit input builder + snarkjs `fullProve` |
| `src/kurier.js` | Kurier REST submission + Finalized polling (fail-soft) |
| `src/config.js` | Environment configuration |
| `circuits/` | Official artifacts: `gatekeeper.wasm`, `gatekeeper_final.zkey`, `verification_key.json` |
| `test/selftest.js` | End-to-end test: all 7 cases + HMAC + preflight + idempotency |

## Decision rules (in check order)

From the event page's "Trap encyclopedia" — the first failing check wins:

1. `proof_vk != registered_vk` → `REJECT / VK_SUBSTITUTION`
2. `public_balance < minimum` → `REJECT / THRESHOLD_MISMATCH`
3. `proof_tx` already seen under a different task → `REJECT / PROOF_REUSED`
4. `current_block > expiry_block` → `REJECT / EXPIRED_CONDITION`
5. `recipient != condition_recipient` → `REJECT / RECIPIENT_MISMATCH`
6. `amount > max_transfer` → `REJECT / AMOUNT_OVERFLOW`
7. otherwise → `APPROVE / VALID_CONDITION`

Amounts are compared as `BigInt`; hashes/addresses as normalized lowercase
hex. Fail closed: malformed tasks get a REJECT, never an approval.

Scoring (event page): +12 correct decision, −6 wrong approve, −3 wrong
reject, −2 timeout, −2 missing/invalid proof, plus a reliability bonus
pro-rated by verified proofs. `PROOF_REUSED` tasks are excluded from the
proof requirement — see below.

## Protocol facts (resolved, with sources)

- **Envelope**: `{ type: "agent-games.proof-gatekeeper.v1", task_id, mode,
  issued_at, deadline_at, input: { registered_vk, proof_vk, minimum,
  public_balance, expiry_block, current_block, recipient,
  condition_recipient, amount, max_transfer, proof_tx } }`
  — [event page](https://agentgames.zkverify.io/events/proof-gatekeeper) sample payload.
- **Response**: `{ decision, reason_code, proof, public_signals }`, signed —
  official starter prompt on the [build page](https://agentgames.zkverify.io/build).
  The event page's "expected shape" additionally shows a `proof_tx` echo;
  this agent sends the union of both shapes.
- **HMAC**: verify the platform's HMAC over the **raw** request body against
  the `x-agent-games-signature` header **before** parsing JSON; sign every
  response the same way — build page + starter prompt.
- **Preflight reply**: `{ ok: true, protocolVersion: "v1" }`, signed — starter prompt.
- **Deadline**: 60 s hard response limit, HTTPS only — build page.
- **Circuit**: Groth16 / BN128, Circom 2.x. Gatekeeper VK hash
  `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`,
  registered on zkVerify mainnet —
  [`/api/circuit-info`](https://agentgames.zkverify.io/api/circuit-info).
- **Circuit inputs (13)** — not published on the build page; recovered by
  Diki Ardian by probing the compiled wasm
  ([write-up](https://medium.com/@dickycan42/dont-trust-the-agent-verify-it-1636c3a826bc))
  and **independently re-verified here empirically** against the artifacts:
  `registeredVkHash, proofVkHash, minimum, publicBalance, expiryBlock,
  currentBlock, recipient, conditionRecipient, amount, maxTransfer,
  decision, taskId, salt` (salt is private and required).
- **Circuit semantics** (verified empirically): the circuit enforces
  `decision == 1` **iff** all five field checks pass; a mismatched decision
  has no witness and `fullProve` throws. Public signals (13, in order):
  `[saltCommitment, registeredVkHash, proofVkHash, minimum, publicBalance,
  expiryBlock, currentBlock, recipient, conditionRecipient, amount,
  maxTransfer, decision, taskId]`, where index 0 is an output that depends
  only on the salt. Hash/address inputs are `BigInt(hex) mod p` (BN254).
  Consequence: for `PROOF_REUSED` (otherwise-valid task, wrong decision =
  REJECT) **no proof can exist** — matching the event page's note that
  reused tasks "have no proof to submit and are excluded".
- **Kurier**: `POST https://api.kurier.xyz/api/v1/submit-proof/{API_KEY}`
  with `{ proofType: "groth16", vkRegistered: true, proofOptions:
  { library: "snarkjs", curve: "bn128" }, proofData: { proof,
  publicSignals, vk: <vkHash> } }`, then poll
  `GET /job-status/{API_KEY}/{jobId}` until `Finalized` —
  [zkVerify docs](https://docs.zkverify.io/overview/getting-started/kurier).
  The gatekeeper VK is already registered on mainnet, so no `register-vk`
  call is needed.
- **Entry requirements**: authenticated account, registered HTTPS endpoint
  passing a health check, completed signed preflight + ≥1 practice task,
  one agent per owner per event — event page.
- **Schedule**: 8 daily rounds, 13–20 Nov 2026, 16:00–02:00 IST
  (17:30–03:30 WIB), 8 tasks per agent per round — event page.

## Unresolved items (read before competing)

These could not be pinned down from any public source. Each has a sane
default and a single place to change; **practice mode is where they get
confirmed** (dashboard → Practice Mode runs unscored tasks end-to-end).

1. **`taskId` derivation.** The envelope's `task_id` is a string
   (`"gk_24_9d1"`); the circuit's `taskId` input is a field element. No
   source states the mapping. Default: `BigInt(sha256(task_id)) mod p`
   (`TASK_ID_MODE=sha256` in `src/prove.js`; `numeric` passes integer ids
   through). Every other public signal is copied verbatim from the task,
   so this is the only agent-derived value in the proof. If practice
   rejects proofs over public signals, this is the first suspect.
2. **HMAC digest/format.** The docs say "HMAC" + the header name but never
   name the digest. Implemented: HMAC-SHA256, hex digest; verification also
   accepts an optional `sha256=` prefix. Change `src/hmac.js` if the
   preflight shows a different scheme.
3. **Preflight request shape.** Only the reply is specified. Implemented
   heuristic: any signed POST without an `input` field gets the preflight
   reply; `GET /health` returns the same object unsigned.
4. **Extra response fields.** We send the union of the two documented
   response shapes plus `proof_reference` when Kurier finalizes in time.
   If the platform validator ever rejects extra fields, drop them in
   `src/index.js` (`handleTask`).
5. **Kurier timing.** Finalization typically takes ~15–30 s. If it exceeds
   `KURIER_WAIT_MS`, the response still goes out with the locally valid
   proof (the platform re-verifies the attached proof itself) but without
   `proof_reference`.

## Run locally

```bash
npm install
npm run fetch-artifacts   # refresh circuits/ from the official site (optional; artifacts are committed)
cp .env.example .env      # fill AGENT_GAMES_HMAC_SECRET (and KURIER_API_KEY if you have one)
npm start                 # listens on :8080, agent path /agent
npm test                  # 24 end-to-end assertions over all 7 cases
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `AGENT_GAMES_HMAC_SECRET` | yes (prod) | Platform secret from the dashboard's "Rotate Secret". (`AGENT_GAMES_SECRET` accepted as alias.) Without it, HMAC checks are disabled — local dev only. |
| `KURIER_API_KEY` | no | Mainnet Kurier key from [kurier.xyz](https://kurier.xyz). Without it, proofs are answered locally only. |
| `KURIER_API_URL` | no | Default `https://api.kurier.xyz/api/v1` (use `https://api-testnet.kurier.xyz/api/v1` for testnet). |
| `KURIER_WAIT_MS` | no | Finalization wait budget, default 40000 (the platform deadline is 60 s). |
| `PORT` / `AGENT_PATH` | no | Default `8080` / `/agent`. Register the exact path in the dashboard. |
| `TASK_ID_MODE` | no | `sha256` (default) or `numeric` — see unresolved item 1. |
| `SEEN_STORE_PATH` | no | Seen-set persistence file, default `./data/seen.json`. Put it on a volume in production. |
| `GATEKEEPER_VK_HASH` | no | Defaults to the mainnet hash from `/api/circuit-info`. |

## Deploy (fly.io example)

```bash
fly apps create chandai-agent
fly volumes create agent_data --size 1 --region sin   # persists the seen-set
fly secrets set AGENT_GAMES_HMAC_SECRET=<from dashboard Rotate Secret> KURIER_API_KEY=<from kurier.xyz>
fly deploy
# endpoint: https://chandai-agent.fly.dev/agent
```

`fly.toml` disables auto-stop and keeps one machine running — the agent
must be awake for the full round window (17:30–03:30 WIB). Any always-on
HTTPS host works; the service is a plain Node process (`npm start`) behind
the included `Dockerfile`.

## What the owner still has to do

1. **Push this repo** to the public GitHub repo
   (`https://github.com/chandchand22/chandai-agent`) — agent registration
   requires a public repo on a personal account.
2. **Create the competitor account** at
   [agentgames.zkverify.io/register](https://agentgames.zkverify.io/register)
   (sign in with X or a wallet) and set a wallet address — required to
   claim VFY prizes.
3. **Deploy the service** (above) and note the public endpoint URL.
4. **Register the agent** in the dashboard: name, track **Proof
   Gatekeeper**, repository URL, endpoint URL.
5. **Rotate Secret** in the dashboard and set the value as
   `AGENT_GAMES_HMAC_SECRET` on the host; restart the service.
6. **Get a Kurier mainnet API key** at [kurier.xyz](https://kurier.xyz) and
   set `KURIER_API_KEY`.
7. **Pass the signed preflight** from the dashboard, then run **at least
   one practice task** (Practice Mode) and confirm the decision and proof
   are accepted — this is also where unresolved items 1–3 get confirmed.
8. **Be registered before a round opens** — entries lock while a round is
   open. Rounds 1–2 (13–14 Nov) are already finished; rounds 3–8 run
   15–20 Nov, 17:30–03:30 WIB. Registration closes 21 Nov.

## Security notes

- Secrets come from environment variables only; nothing is logged.
- Inbound HMAC is verified over the raw body before any parsing.
- The decision is made by deterministic code only (no LLM in the loop).
- Fail closed everywhere: bad signature → 401, malformed task → REJECT,
  Kurier failure → answer with the local proof anyway, never an
  unjustified APPROVE.
