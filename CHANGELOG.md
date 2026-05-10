# Changelog

All notable changes to runway are documented here. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); breaking
changes bump the major.

## 0.1.1 — 2026-05-10

Patch release verifying the npm Trusted Publishing (OIDC) path end-to-end. No code changes.

- Release workflow publishes via GitHub OIDC instead of a long-lived `NPM_TOKEN` (see [PR #11](https://github.com/ValescoAgency/runway/pull/11)).
- Each published tarball now carries a signed provenance attestation (`npm audit signatures` verifies the artifact was built and signed by this repo's release workflow at a specific commit).
- Repo-level `.npmrc` pins the `@valescoagency` scope to public npm so host-level config drift can't reroute a future publish ([PR #10](https://github.com/ValescoAgency/runway/pull/10)).

## 0.1.0 — 2026-05-09

First public npm release. **Experimental** — production-shaped (the
init/run/doctor/upgrade/upgrade-repo loop is verified end-to-end on
macOS arm64) but the surface may shift as we dogfood it.

### Commands

- `runway init` — scaffold a target repo with `.sandcastle/Dockerfile`
  + (tier 2) `.env.schema` for varlock + 1Password CLI inside the
  container. Writes the canonical claude-code Dockerfile directly,
  bypassing `sandcastle init`'s interactive prompts (which hang in
  non-TTY environments).
- `runway run` — drain a Linear queue. For each `Todo` issue: branch,
  agent works in a sandcastle Docker sandbox, sub-agent reviews, PR
  opens (or `needs-human` label).
- `runway doctor` — read-only preflight diagnostic with `--json` mode
  for CI / scripted health checks.
- `runway upgrade` — self-update the CLI from its git clone (`git
  pull`, `pnpm install`, typecheck). Will gain a global-install path
  in a follow-up.
- `runway upgrade-repo` — re-render a target repo's runway scaffold
  against current vendored templates. Extracts existing op:// values
  so the user never re-types them. `--check` mode for CI drift detection.

### Notable design choices

- **Tier 2 by default** — secrets resolved at agent runtime via
  varlock + 1Password CLI inside the container, never written to the
  target repo's filesystem.
- **No `.sandcastle/.env`** — runway's tier 2 path keeps the file off
  disk entirely; tier 1 is available as `--tier=1` for users opting
  out of varlock.
- **Vendored Dockerfile base** — runway ships its own copy of
  sandcastle's claude-code Dockerfile so we can patch macOS-specific
  bugs (host GID 20 collision with Debian's `dialout` group) and
  apply the varlock layer without depending on `sandcastle init`'s
  prompts.

### Limitations

- One target repo per `runway run` invocation (no multi-repo dispatch).
- Sequential issue processing (no parallel runs).
- Docker sandbox only — Vercel sandbox provider is a follow-up.
- No DAG / dependency awareness across issues.
- Auto-rebase / merge of approved PRs is the human's job.

### License

MIT.
