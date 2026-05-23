# Credential brokering: agents hold placeholders, a broker holds secrets

Runway will move every credential the agent uses (Anthropic API, GitHub
token, Linear API key, and any future outbound auth) out of the
sandbox and behind a **credential broker**. The agent's environment
will hold long, random **placeholder strings** (e.g.
`__anthropic_a7f3e1__`); a broker on the planner host intercepts the
sandbox's outbound HTTPS, substitutes placeholders for real
credentials on its side of the wire, and forwards. The agent never
holds, sees, or is told about a real secret. Initial engine is
[Infisical Agent Vault](https://github.com/Infisical/agent-vault)
(self-hosted, MITM proxy + CA); a documented exit ramp swaps the engine
for [Vercel Sandbox `networkPolicy.transform.headers`](https://vercel.com/docs/vercel-sandbox/concepts/firewall#credentials-brokering)
when runway adopts the Vercel Sandbox provider.

## Status

Proposed (2026-05-23). Implementation deferred until a tracking epic
(VA-TBD) is filed; broker engine selection (Agent Vault vs. self-host
alternatives) is locked to Agent Vault for phase 1 by this ADR.

## Context

### The current secrets posture

Runway already has two layers of secret-handling (`docs/secrets-with-varlock.md`):

- **Layer 1 (host)**: `varlock run -- runway` resolves
  `LINEAR_API_KEY` and `OP_SERVICE_ACCOUNT_TOKEN` from 1Password into
  the runway process env. No disk-at-rest on the host.
- **Layer 2 (container)**: a `claude` shim wraps `varlock run --
  claude.real` inside the sandbox so `ANTHROPIC_API_KEY` and
  `GH_TOKEN` materialize JIT into the agent process env. The image
  ships varlock + the 1Password CLI; `OP_SERVICE_ACCOUNT_TOKEN`
  crosses the sandbox boundary so in-container varlock can authenticate.

The Layer 2 design eliminates secrets-at-rest in the image and on disk,
but does **not** eliminate secrets-in-process. The own doc admits it:
*"During an active claude run, the agent process holds
`ANTHROPIC_API_KEY` and `GH_TOKEN`."* `OP_SERVICE_ACCOUNT_TOKEN` is
worse — it's the master key to the runway 1Password vault, and it sits
in the container's PID 1 env for the lifetime of every drain.

### The threat surface is wider than "the issue body"

Every text channel runway feeds into an agent process is a
prompt-injection vector running adjacent to those credentials:

- Issue body and acceptance criteria (implement agent).
- Repo file contents the agent reads while implementing.
- The diff and the issue body again (reviewer agent).
- PR review-thread comments (VA-463, VA-479 reviewer-feedback path).
- Linear comments and review-thread comments (IRA, `runway review run`).
- CI log excerpts, mergeability conflict messages, and reviewer-bot
  comments (planner subscriptions VA-477..479).

A successful injection on any of those gets `GH_TOKEN` (broad
GitHub write, including opening PRs and pushing branches) and the
`OP_SERVICE_ACCOUNT_TOKEN` (the rest of the vault). "Narrow the
scopes" is not a durable fix — Anthropic put this sharply in their
Managed Agents post: *"narrow scoping is an obvious mitigation, but
this encodes an assumption about what Claude can't do with a limited
token — and Claude is getting increasingly smart."*

### Four-vendor convergence on the same architecture

Within a single quarter (April–May 2026) four independent products
shipped the same shape:

| Source | Mechanism | Engine location |
|---|---|---|
| Infisical Agent Vault | MITM HTTPS proxy + trusted CA, dummy creds in sandbox | Self-hosted vault server |
| Anthropic Managed Agents | "Dedicated proxy" for MCP tools, OAuth in vault, session token | Outside sandbox, platform-owned |
| Vercel Sandbox | Firewall-level `networkPolicy.allow[].transform.headers` injection | Outside the VM, in the firewall |
| LangSmith | Sidecar proxy with `proxy_config.rules` (`match_hosts`, `match_paths`, `headers`) | LangSmith service |

The shared invariant, stated cleanest by Anthropic, is the design
target this ADR adopts verbatim: **"The harness is never made aware of
any credentials."**

### Placeholder substitution vs. scheme-aware injection

The mechanically interesting detail — the one that decides what kind
of abstraction lives in runway — is *how* the broker swaps credentials
in:

- **Scheme-aware**: broker knows GitHub uses `Authorization: Bearer`,
  Stripe uses Basic-auth, some-future-service uses a query param. Every
  new credential means new broker code.
- **Placeholder substitution**: agent's env holds the literal string
  `__github_token__`; the broker greps the outbound request bytes for
  that placeholder and swaps in the real token, anywhere it appears.
  Works for headers, query strings, JSON bodies, multipart, whatever.

Substitution is the right choice for runway because runway's surface
keeps growing — Anthropic today, `gh` + Linear + git-over-HTTPS right
alongside, the planner HTTP API next, possibly Vercel/Sigstore/registry
tokens later — and the cost of adding the *next* credential should be
a config line, not a broker integration.

### Why now

Three factors line up:

1. **ADR 0004 just landed the planner daemon** on a Mac mini reachable
   via Tailscale. The planner host is already the natural location for
   a long-running broker; the trust + ops surface of "another process
   on the same host" is small.
2. **VA-475 already shipped the Tailscale-gated HTTP API**. The
   broker's management endpoint can hide behind the same ACL.
3. **The Vercel Sandbox provider is on the deferred-v1 list**
   (README: *"Vercel Sandbox provider (Docker only — swap to `vercel()`
   later)"*). If/when that swap happens, the broker collapses into the
   firewall layer for free — but only if runway's broker abstraction
   doesn't bake Agent-Vault assumptions into call sites.

## Decision

### Invariant

The harness — runway's host process **and** every sandbox it spawns —
is never made aware of any credentials runway uses to reach external
services. The trust boundary sits between the agent and the credential,
not between the agent and the network. Phrased as an
assertion that should hold at every commit on `master`:

> No process in runway's drain or planner code path ever has the real
> value of `ANTHROPIC_API_KEY`, `GH_TOKEN`, `LINEAR_API_KEY`, or
> `OP_SERVICE_ACCOUNT_TOKEN` in memory. Only the broker process does.

`LINEAR_API_KEY` is in scope despite being held by the runway host
(not the sandbox). If we're stating the invariant, we hold it.
`OP_SERVICE_ACCOUNT_TOKEN` is in scope too, and the broker is the
process that authenticates to 1Password to fetch the underlying
credentials — the token moves *to* the broker host, not into the
sandbox.

### Mechanism: placeholder substitution with per-session randomized placeholders

The Dockerfile bakes in literal placeholder env values:

```dockerfile
ENV ANTHROPIC_API_KEY=__anthropic_api_key__
ENV GH_TOKEN=__gh_token__
```

At session-mint time (see "Phase-scoped sessions" below) the broker
**rotates** the placeholder body with a random suffix:
`__anthropic_a7f3e1__`, `__gh_a7f3e1__`. The session-specific
placeholder is what the sandbox's env actually receives at run time
(written through Sandcastle's `env` field, not via image rebuild). The
hardcoded literals in the Dockerfile are tier-1 fallbacks for local
dev without a broker.

The randomization mitigates the substring-collision footgun: a fixed
`__github_token__` could theoretically appear inside some legitimate
payload byte and be replaced. A 6-character random suffix per session
makes accidental collisions vanishing.

### Engine: Agent Vault on the planner host (phase 1)

The broker process is Infisical Agent Vault, deployed on the planner
Mac mini. It exposes:

- The management HTTP API (port 14321) **behind the same Tailscale
  ACL** as the planner's HTTP API (VA-475 contract).
- The MITM HTTPS proxy (port 14322) on a tailnet-only bind.
- A locally-trusted CA whose root cert is baked into the sandbox image
  (`/etc/ssl/certs/`) and referenced via `NODE_EXTRA_CA_CERTS` plus
  whatever the language-specific equivalent is for the agent's HTTP
  clients.

`OP_SERVICE_ACCOUNT_TOKEN` lives on the planner host *only* and feeds
the broker's vault. Real credentials sit encrypted in Agent Vault's
store; the broker decrypts to memory only at substitution time.

### Mechanism: phase-scoped session tokens

Per-drain is too coarse: the reviewer pass doesn't need GitHub write,
the implement pass doesn't always need git push. The orchestrator
mints **one session per phase span** — `impl-iter-N`, `review`,
`finalize` — each scoped to the smallest set of services that phase
needs:

| Phase | Services scoped in |
|---|---|
| `impl-iter-N` | `api.anthropic.com`, package registries the repo needs |
| `review` | `api.anthropic.com`, **read-only** GitHub (`api.github.com` GET) |
| `finalize` | `api.github.com` (PR open + push), git-over-HTTPS to the repo |
| Planner subscriptions (out-of-drain) | `api.github.com` (per-capability scoping) |

Phase boundaries are already explicit Effect spans (`impl-iter-N`,
`review`, `finalize`); the broker session lifecycle hangs off those
spans. The drain's OTLP trace-id is the natural label for forensics —
every brokered request ties back to one span in the dashboard.

### Removals

Layer 2 in `docs/secrets-with-varlock.md` is **deleted**, not
extended. Specifically:

- `templates/claude-shim.sh` — removed.
- `templates/dockerfile-varlock.snippet` — removed.
- The in-container `varlock` + 1Password CLI installs come out of the
  image (smaller image, faster cold start).
- `OP_SERVICE_ACCOUNT_TOKEN` is no longer passed into the sandbox env
  at all.
- The `--auth-mode=api-key | oauth` switch in `runway init` is no
  longer load-bearing for the proxy path — both flavors materialize
  as a placeholder in the same env var the broker rule references.

Layer 1 (host varlock) **stays** but slims down: runway's host process
no longer needs `OP_SERVICE_ACCOUNT_TOKEN` for sandbox forwarding; the
planner host needs it for the broker. `LINEAR_API_KEY` on the host is
the one credential that lingers in plaintext — see "Deferred
questions" below.

### `CredentialBroker` abstraction (don't bake the engine into call sites)

Sandcastle invocations go through one interface:

```ts
interface CredentialBroker {
  mintSession(opts: { phase: 'impl' | 'review' | 'finalize';
                      services: ServiceScope[];
                      traceId: string }): Effect<Session>;
  revokeSession(s: Session): Effect<void>;
}

interface Session {
  envForSandbox(): Record<string, string>;
  // → { HTTPS_PROXY, HTTP_PROXY, NODE_EXTRA_CA_CERTS,
  //     ANTHROPIC_API_KEY: '__anthropic_a7f3e1__', ... }
  caBundlePath(): string;
}
```

Two implementations land:

- `AgentVaultBroker` (phase 1) — talks to Agent Vault on the planner
  host via its TypeScript SDK.
- `VercelSandboxBroker` (phase 2) — emits the equivalent shape into
  Vercel Sandbox's `networkPolicy.allow[].transform.headers`; no
  proxy, no CA, the firewall does the substitution.

Call sites in `src/sandcastle.ts`, `src/orchestrator.ts`,
`src/planner-mergeability.ts`, `src/planner-reviewer.ts`,
`src/finalize.ts` only see `CredentialBroker`. The engine swap is one
config change.

### `runway doctor` integration

A new check section, `Credential broker`, validates:

- Broker reachable at configured address (tailnet ping + management API
  health endpoint).
- Local CA bundle present and the sandbox image trusts it.
- A probe `mintSession` + `revokeSession` round-trip succeeds.
- Env vars in the proxy-mode `.env.schema` contain placeholder strings
  (sanity check that nothing's leaking real values).

This replaces the existing "is this `sk-ant-api03-…` or `sk-ant-oat01-…`?"
shape-sniffing logic — the doctor's job becomes deterministic.

### `runway init` / `upgrade-repo` integration

A new auth mode, `--auth-mode=proxy`, joins `api-key` and `oauth`:

- Writes a `.env.schema` whose Anthropic / GitHub entries are
  placeholder literals, not `op://` references.
- Bakes `NODE_EXTRA_CA_CERTS=/etc/ssl/runway-broker-ca.pem` into the
  Dockerfile.
- Drops the varlock + 1Password lines from the image.
- Adds `RUNWAY_BROKER_ADDR` to the host-side env contract.

`upgrade-repo` detects an existing `--auth-mode=oauth|api-key` schema
and offers (does not force) migration to `proxy`. The two modes
coexist: a target repo on `api-key` and one on `proxy` both work
against the same `runway run`.

## Phase 2: the Vercel Sandbox exit ramp

This is the explicitly intended long-term direction, captured here so
phase 1 doesn't accidentally close the door.

When runway swaps the Docker provider for Vercel Sandbox (the
deferred-v1 README item), the broker engine collapses:

- No more Agent Vault server.
- No more MITM proxy, no more CA distribution, no more `HTTPS_PROXY`
  in the sandbox env.
- The placeholder still lands in the sandbox env, but substitution
  happens **at the firewall**, per Vercel's
  `networkPolicy.allow[].transform.headers` shape — the same byte-level
  outbound substitution, performed by Vercel's infrastructure instead
  of our own proxy.
- `VercelSandboxBroker.envForSandbox()` returns just the placeholder
  env vars (no proxy, no CA); the `networkPolicy` is materialized into
  the sandbox spec at provision time.

Two design choices in phase 1 are specifically structured to make this
swap clean:

1. **`CredentialBroker` is the only interface call sites import.**
   No `import { AgentVault } from ...` outside `agent-vault-broker.ts`.
2. **Placeholder substitution is the substitution mechanism**, not
   scheme-aware injection. Vercel's `transform.headers` is also a
   string operation; the same placeholder format works for both
   engines unchanged.

A Vercel Sandbox provider epic does **not** require revisiting this
ADR — the broker abstraction already accommodates it. The epic only
needs to (a) ship the `VercelSandboxBroker` implementation and (b)
write a one-time migration path for operators (Agent Vault gets torn
down, broker config flips).

There's one open question for phase 2 that doesn't need answering
today but is worth flagging: Vercel's `transform.headers` is
header-level only as documented; if the substitution applies to header
bodies but not arbitrary request bytes (query strings, JSON bodies),
the runway services that use non-header auth need to all still be
header-borne. Anthropic's `x-api-key`, GitHub's
`Authorization: Bearer`, and Linear's `Authorization:` are all
headers, so we're fine — but a future credential that lives in a
query string would force us back to a proxy-based engine.

## Considered options

### Alternative 1: Keep Layer 2 varlock, narrow GitHub token scopes

Reduce `GH_TOKEN` to a narrow PAT (just the target repo, just PR
operations) and live with the in-process exposure. **Rejected** for
the Anthropic reason above: scope-narrowing encodes assumptions about
what the agent can't do with a limited token, and the structural fix
(creds outside the sandbox) is the only durable answer. Also fails to
address `OP_SERVICE_ACCOUNT_TOKEN`, which can't be meaningfully
narrowed without breaking the in-container varlock setup.

### Alternative 2: Scheme-aware broker (header rules per service)

Build the broker as "knows about Authorization: Bearer, x-api-key,
Basic-auth, etc." and inject scheme-correct headers per service.
**Rejected** because every new outbound credential is broker work.
Substitution is auth-scheme-agnostic and trivially handles future
services (planner HTTP API, Sigstore, registry tokens, MCP servers
yet-to-be-named) for free.

### Alternative 3: LangSmith or Anthropic Managed Agents as the engine

Both are credible. Both are SaaS-dependent and would put runway's
agent traffic through a third party's data plane. **Rejected** for
phase 1 because (a) Agent Vault is self-hostable on infra runway
already runs (the planner Mac mini), (b) Managed Agents would replace
Sandcastle entirely — a much bigger pivot, separate ADR — and (c)
runway's existing dashboard + OTLP plane already do the observability
job LangSmith ships with.

The Managed Agents post is also philosophically a quiet challenge to
runway's existence as a harness, separate from the credential
question. Worth periodic re-reading; not a phase-1 decision.

### Alternative 4: Roll our own broker

A small Node service in the runway repo that does the same job as
Agent Vault. **Rejected** because Agent Vault is BSL-licensed
open-source, actively maintained, and has solved problems (CA
trust, agent identity, session lifecycle, request matching) we'd have
to solve from scratch. We do not want runway to be in the
credential-broker business; we want to be a consumer of one.

### Alternative 5: Wait for the Vercel Sandbox swap, skip phase 1

Don't ship Agent Vault at all; live with Layer 2 varlock until
runway migrates to Vercel Sandbox. **Rejected** because the threat
surface (every reviewer-comment, every CI-log excerpt, every Linear
comment feeding the IRA) is live today and the Vercel Sandbox swap is
on no committed timeline. The structural fix is too valuable to defer
on an unbounded "we'll get to it" assumption.

### Alternative 6: Per-drain session tokens (one session for the whole drain)

Simpler than phase-scoped sessions: mint one session at the start of
`processIssue`, revoke at outcome. **Rejected** as the default but
kept as a fallback: a single per-issue session is the minimum-viable
shape, and the per-phase scoping is a refinement we promote
capability-by-capability after operational feedback. The
`CredentialBroker` interface supports both — phase scoping is just
narrower service rules.

## Consequences

### What changes

- New long-running process on the planner host (Agent Vault).
- New `.env.schema` shape under `--auth-mode=proxy`: placeholder
  literals, not `op://` references.
- New `CredentialBroker` interface and `AgentVaultBroker` implementation
  in `src/credential-broker/`.
- Call sites in `sandcastle.ts`, `orchestrator.ts`, the three planner
  capability files, and `finalize.ts` route through the broker.
- New `runway doctor` section: `Credential broker`.
- The sandbox image **loses** varlock + the 1Password CLI + the
  `claude` shim, **gains** a single CA cert and the proxy env vars.
- `OP_SERVICE_ACCOUNT_TOKEN` no longer crosses the sandbox boundary.

### What stays unchanged

- The drain composition (`processIssue` → implement → review →
  finalize) is structurally the same. Only the env materialization
  changes.
- The dashboard, OTLP pipeline, and SQLite projector are untouched.
- The planner's existing state machine and capabilities are untouched
  — capabilities that today read `GH_TOKEN` from process env start
  routing through a broker session, but the call-site shape stays.
- The IRA (`runway review run`) is untouched: it makes Anthropic API
  calls from the runway host, which the broker covers via host-side
  proxy config the same way the sandbox does.

### Backwards compatibility

`--auth-mode=api-key` and `--auth-mode=oauth` are **not** removed.
The proxy mode is opt-in per target repo. Operators who don't want to
stand up a broker stay on the existing modes; everything they have
today keeps working. The broker is the default for `runway init` once
the Agent Vault deployment is documented and the planner has shipped
a broker-companion mode, but the per-repo schema is the source of
truth.

### Deferred questions

- **`LINEAR_API_KEY` on the runway host.** Today it sits in the
  process env of `runway run` / `runway planner`. The invariant
  technically requires brokering it too. The path: route Linear API
  traffic from the host through the broker. Trade-off: the host now
  depends on the broker for queue reads. Worth it; not blocking
  phase 1.
- **Broker downtime semantics.** If the planner Mac mini is
  unreachable, every drain fails (no session can be minted). Same
  blast radius as Tailscale being down. Acceptable for the
  solo-operator profile; needs revisiting if the broker grows
  multi-operator.
- **Bootstrap chicken-and-egg.** The broker needs `OP_SERVICE_ACCOUNT_TOKEN`
  on the planner host. That has to be provisioned out-of-band (host
  varlock or env at process start). This is not new — Layer 1 already
  has this — but the broker concentrates trust on a single host that
  used to be split across runway-invocation hosts.
- **Multi-repo broker scoping.** Today runway runs against one repo
  per `runway run`. The broker's service rules can be repo-scoped or
  global; phase 1 picks the simpler global shape (one Agent Vault rule
  per service, regardless of which repo's drain is using it).
- **MCP server credentials.** If the Sandcastle agent gets MCP server
  access, those servers' credentials are also in scope. The
  placeholder mechanism extends naturally; the operational question
  is who registers them. Punted to whichever epic adds MCP.

## Relationship to other ADRs

- **ADR 0001 (custom OTLP collector)**: unaffected. Broker emits its
  own telemetry; that's a separate stream.
- **ADR 0002 (Effect Platform HTTP)**: unaffected.
- **ADR 0003 (agent commit signing)**: complementary. Phase 1
  leaves signing-key handling as-is. A future refinement is to let
  the broker mint per-drain ephemeral signing keys via a callback-URL
  pattern (LangSmith's idea); that's a phase-3 improvement, not
  phase 1.
- **ADR 0004 (planner daemon)**: the broker rides the planner's
  deployment story. Same Mac mini, same Tailscale ACL, same
  "long-running process on the host" trust model. The broker is
  documented as a planner-companion, not a separate piece of infra.

## Migration plan

Three sub-epics, sized to avoid a flag day:

1. **Broker foundation**: stand up Agent Vault on the planner host,
   write the `CredentialBroker` interface + `AgentVaultBroker`,
   update `runway init` / `runway doctor` / `runway upgrade-repo`,
   add `--auth-mode=proxy`. No call site changes yet — proxy mode is
   shippable but opt-in.
2. **Drain call sites**: route `sandcastle.ts` invocations through
   the broker. Implement phase-scoped sessions. At end of this epic
   the sandbox image drops varlock + the op CLI + the shim.
3. **Planner + IRA call sites**: planner capability files and the
   IRA's Anthropic calls route through the broker. After this lands,
   `OP_SERVICE_ACCOUNT_TOKEN` no longer crosses the sandbox boundary
   anywhere.

Phase 2 (Vercel Sandbox `VercelSandboxBroker`) is filed against
whichever epic ships the Vercel Sandbox provider swap. Not scheduled
by this ADR.
