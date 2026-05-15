# Agent commit signing: SSH-signed with a 1Password-managed bot key

Commits produced by the runway agent are signed with a non-human SSH key whose
private half lives in 1Password and is materialized inside the sandcastle
container at agent-run time only. The bot's public signing key is registered
on a dedicated GitHub "runway agent" account, which GitHub uses to render the
**Verified** badge on every commit the agent pushes.

## Status

Accepted (2026-05-15).

## Context

The sandcastle container had no signing material configured. Commits arrived
on master unverified (e.g. PRs #62, #63 from the first self-hosted AFK drain),
which forces audits to trust GitHub's UI rather than `git log --show-signature`,
and would block runway from working against repos that enforce signed commits
on protected branches.

## Considered options

Three plausible strategies surfaced in VA-413's discovery phase:

- **(a) GitHub App identity.** A dedicated GitHub App, with commits authored
  via the `createCommitOnBranch` GraphQL mutation. Server-side signing →
  Verified badge with no signing material in the container. **Rejected as
  v1 because** it requires rewriting the agent's commit path: a `git commit
  && git push` via App installation token does *not* produce a Verified
  commit, only commits created through GitHub's API do. The agent's natural
  multi-commit-per-iteration mode (and the iterative review/rework loop)
  works against the API's tree-replay shape. Migration is tractable when
  branch protection or multi-tenant operation makes the cost worthwhile —
  see "Future migration" below.
- **(b) GPG signing with a 1Password-managed bot key.** Dedicated non-human
  GPG keypair stored in 1Password, materialized in the container at run
  time, `git commit -S` signs locally, plain `git push`. Rejected because
  the GPG toolchain inside Docker carries UX friction (gpg-agent quirks,
  passphrase plumbing, ~10MB image bloat) and Git ≥ 2.34 supports SSH
  signing natively without the gpg dependency. Trust model is otherwise
  identical to (c).
- **(c) SSH signing with a 1Password-managed bot key.** Chosen.

## Decision

Use **SSH signing with a non-human bot key managed in 1Password**:

- A dedicated SSH signing keypair (Ed25519, separate from any
  authentication key) is generated once and stored in 1Password under the
  runway scaffolder's vault.
- The public half is registered as a *Signing Key* on a dedicated GitHub
  "runway agent" account; that account also holds the agent's `GH_TOKEN`
  used for `gh pr create`.
- The bot's `user.name` / `user.email` (matching the GitHub agent account)
  are stored alongside in 1Password.
- At sandcastle container start, the varlock-wrapped `claude` shim
  resolves the signing material via `op://` references in
  `.env.schema`, writes the private key to a tmpfs-backed path inside
  the agent's home, and configures `gpg.format=ssh`,
  `user.signingkey=<pubkey>`, `commit.gpgsign=true` globally. When the
  container is destroyed at end of run, the key file disappears with it.
- Operators who haven't yet provisioned a bot key see runway run exactly
  as before — the signing bootstrap is opt-in via the presence of the
  signing env vars in `.env.schema`. `runway doctor` flags the missing
  configuration as a `warn`, not a `fail`, so existing scaffolds keep
  working.

## Why SSH signing wins for now

| Axis | App identity (a) | GPG (b) | SSH signing (c) |
|------|------------------|---------|-----------------|
| Verified badge | server-side | client-side | client-side |
| Signing material in container | none | yes (private key + passphrase) | yes (private key) |
| Long-lived secret | App pem (offloaded to 1Password) | bot GPG key | bot SSH key |
| Container toolchain | API client only | `gpg` + `gpg-agent` | git ≥ 2.34 only |
| Agent commit path | **rewritten** (createCommitOnBranch) | unchanged | unchanged |
| Provider portability | GitHub-only | portable | portable |
| Local verify UX | n/a (always Verified on GitHub) | `gpg --verify` | `allowedSignersFile` |
| Implementation cost | 3–5 days | 1 day | 0.5 day |

The "long-lived private key" objection from the ACs applies to (b) and
(c). It is mitigated in (c) by:

- The key is non-human and single-purpose (signing only, no auth).
- Its private half lives in 1Password — already in the audit perimeter
  for ANTHROPIC_API_KEY and GH_TOKEN, with the same rotation story.
- Compromise blast radius is bounded by the bot GitHub account: revoke
  the public key in that account's Signing Keys list and every prior
  signature becomes "Unverified" rather than the attacker being able to
  forge as a human contributor.
- Rotation is a single 1Password update + a `gh ssh-key delete`/`add`
  pair, documented in the README.

## Consequences

- The sandcastle Dockerfile does **not** need a `gpg` install. Git's
  built-in SSH signing path is sufficient.
- The varlock-wrapped `claude` shim grows a small bootstrap block: read
  the signing env vars, materialize the key, run `git config`. The
  bootstrap is idempotent — repeated `claude` invocations within one
  container reuse the existing config.
- `runway init` (tier 2) prompts for the signing key's 1Password item
  name and the bot's git user.name / user.email at scaffold time, and
  writes the references into `.env.schema` alongside the existing
  ANTHROPIC + GH_TOKEN entries. Operators who haven't provisioned a bot
  key skip these prompts; the scaffold still works.
- `runway doctor` gains a `git-signing` diagnostic: when the scaffold
  declares the signing env vars, verify the op:// items resolve;
  optionally verify the host's git has `gpg.ssh.allowedSignersFile`
  configured so an operator can re-verify the agent's commits locally
  with `git log --show-signature`.
- The bot signing key never appears in:
  - The runway repo (it's an op:// reference, not a literal value).
  - The container image layers (it's resolved at run time from env).
  - Any logged process environment (varlock's wrapper exposes secrets
    only to the immediate child).
  - The host's git config (signing is configured global-to-the-container,
    not on the host).

## Future migration to App identity

When any of the following becomes true, revisit option (a):

1. A target repo enforces signed commits on protected branches AND
   requires App-attested authorship (some compliance regimes).
2. Runway operates against repos under multiple GitHub organizations
   where managing per-org bot accounts becomes administratively
   expensive.
3. The agent's commit cadence migrates to a single per-iteration
   commit emission (eliminating the multi-commit-per-iteration friction
   with `createCommitOnBranch`).

The migration path is additive: the SSH-signing bootstrap becomes a
fallback for environments where the App path isn't installed, the
agent's commit emission moves into a new "commit author" seam, and
the App's pem is provisioned via the same 1Password slot the SSH key
occupies today.
