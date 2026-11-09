# Proofcard DSH

**Every DeepSeek Harness turn ends with a proof receipt: the claims the agent made, the tool calls that actually happened, and a verdict you can accept or challenge.**

Proofcard is a native DSH bundle. It reads the session log after each completed turn, extracts
the agent's completion claims ("all 14 tests pass", "I created `src/app.ts`", "pushed the
fix"), matches each against the recorded `tool/call` + `tool/result` events, and writes a
hash-chained receipt. A composer pill shows unproven work; a **Settings → Proofcard** page
lists receipts with **Accept** and **Challenge** actions.

It is **observe-only**: it never gates, rewrites, delays or withholds a turn. It is also
**zero-token and deterministic** — no model call, no API key, no network.

## What you get

| Surface | What it does |
|---|---|
| **Inline turn card** | After every completed turn, a Proofcard card appears in the chat: verdict ring, stacked verdict bar, claim chips with evidence counts, and Accept/Challenge/Details. No navigation required. |
| **Header button** | A `Proofcard` action in the session header opens the full slide-over drawer from anywhere. |
| **Slide-over drawer** | Right-hand panel with the trust ring, sparkline of recent turns, receipt cards, expandable claim/evidence rows, Accept/Challenge, and a This-session / All-receipts filter. |
| **Composer pill** | `Proofcard · N unproven` (or verified) for the current turn; click opens the drawer. |
| **Evidence-derived claims** | Regardless of prose, successful tool calls become checkable claims: writes → `file_changed`, test commands → `test_passed`, other commands → `command_ran`, fetches → `url_fetched` (marked as tool evidence). Narrative assertions show separately and never count toward the verified ratio. |
| **Receipt per completed turn** | `rc_…` id, verdict counts, claims with evidence links, commands with exit codes, files touched, duration. |
| **Four verdicts** | ✅ verified, 🟡 partial, ⚠️ unverified, ❌ contradicted. |
| **Mark reviewed** | Records your acceptance of the receipt (optional note) as an appended event and removes it from the composer's unproven count; the receipt itself stays immutable. It is an audit decision, not a re-verification. |
| **Challenge → fix** | Runs the proposed read-only checks and records their results. If claims are contradicted or checks fail, **Ask agent to fix** inserts a ready repair request (failed claims + evidence + failed checks) into the composer, so you can send it and have the agent actually fix or retract the claim; the next turn gets its own receipt. |
| **Settings page** | Full-page fallback with the same data for keyboard/configuration flows. |
| **Six tools** | `proofcard_list`, `proofcard_show`, `proofcard_accept`, `proofcard_challenge`, `proofcard_stats`, `proofcard_export`. |
| **Hash chain** | Each receipt links to the previous receipt in the same session. |

## Install

```powershell
git clone https://github.com/SicoXtra/proofcard-dsh.git
cd proofcard-dsh

# local directory install into a DSH profile
dsh plugin --profile desktop add .
```

Or install the bundle through the Harness plugin manager (`plugin_manager` `install_bundle`
with the path to this directory). The Host row is named `@local/proofcard-dsh`; the UI appears
as a composer pill and a **Proofcard** settings section after the page reloads.

Data lives in the first available of: the `dataDir` config, `<DSH_PROFILE_DIR>/proofcard`,
`<DSH_HOME>/proofcard`, `~/.dsh/proofcard`. In the Desktop app the host process may not expose
`DSH_PROFILE_DIR`/`DSH_HOME`, so this install resolved to `~/.dsh/proofcard` (one shared
ledger). Set `dataDir` in the row config if you want a per-profile ledger.

## Quick start

1. Do a task in DSH that runs a command ("run the tests and fix the failure").
2. When the turn completes, open **Settings → Proofcard** (or look at the composer pill).
3. Review each claim's evidence, press **Accept**, or **Challenge** an unproven claim to get a
   read-only check you can run.

Or ask the agent: *"Show me the proofcard for that turn and challenge the test claim."*

## Configuration

`cordis.patch.yml` row `proofcard-dsh`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch for capture and tools |
| `dataDir` | `''` (profile/homedir fallback) | explicit storage directory |
| `maxClaims` | `12` | cap on claims extracted per turn |
| `storeToolOutput` | `true` | keep bounded, redacted result excerpts |
| `retentionDays` | `30` | prune older receipts on load |
| `allowCommandRerun` | `false` | let challenges re-run allow-listed read-only commands |
| `ambientPrompt` | `true` | add short claim-writing guidance to the prompt |

## Privacy

- Local only: no network, no telemetry, no model calls.
- Stored per receipt: request (400 chars), final reply (1200 chars), up to 12 claim texts,
  bounded tool excerpts (args 600, results 2000 chars), commands/exit codes, files touched,
  timings, hash chain. All strings pass a credential-redaction filter (OpenAI/GitHub/AWS/
  Slack/Google/Stripe keys, JWTs, PEM keys, bearer tokens, `password=…`).
- Redaction is best-effort; delete `<dataDir>` to purge.

## How it works

```
session/event feed
  ├─ user/message          → turn request
  ├─ tool/call + tool/result → evidence (paired by callId)
  ├─ assistant/message     → last reply of the turn
  └─ turn/end (completed)  → receipts.buildReceipt() → ledger.jsonl
                                   │
              tools + /proofcard/* routes + client pill/settings page
```

Claim kinds: `test_passed`, `file_changed`, `file_exists`, `command_ran`, `url_fetched`,
`commit`, `message_sent`, `count`, `assertion`. Negated, future-tense, question-form and
code-fenced statements are dropped; ambiguous text is not guessed.

## Limits

- Heuristic claim extraction: precision-first, English-oriented; it will miss some claims and
  can be fooled by unusual phrasing.
- Evidence is only what the session log recorded; a claim about work done before the plugin
  was enabled or in another session is marked unverified, never silently verified.
- File paths resolve against the session cwd.
- Hash chain is tamper-evident, not signed.
- Not an auditor, not a security boundary.

## Development

```bash
node proofcard-dsh/tests/core-smoke.mjs     # core engine
node proofcard-dsh/tests/adversarial.mjs    # independent adversarial suite
node proofcard-dsh/tests/e2e.mjs            # end-to-end (mock Cordis ctx)
node proofcard-dsh/tests/mock-load.mjs      # Host registration/capture
node proofcard-dsh/tests/client-smoke.mjs   # Client slot registrations
```

See `VERIFICATION.md` for measured results and residual risks.
