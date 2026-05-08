# Secrets with varlock + 1Password — zero secrets at rest

Runway integrates [varlock](https://varlock.dev) so that no secret
(API key, token, OAuth credential) ever sits on disk in a `.env` file
on the host or inside any Docker image.

There are two layers, and they're independent — you can adopt Layer 1
today and add Layer 2 when you're ready.

## Layer 1 — host (runway invocation)

Runway needs `LINEAR_API_KEY` (to read the queue) and
`OP_SERVICE_ACCOUNT_TOKEN` (to forward into the sandcastle container
for Layer 2). Both are declared in [`/.env.schema`](../.env.schema)
with `op://` references.

### Setup

```bash
# 1. Install varlock once
brew install varlock   # or: pnpm add -g varlock

# 2. Authenticate the 1Password CLI on the host
op signin    # (or use a service-account token)

# 3. Verify the schema resolves
cd /path/to/runway
varlock load --show
# you should see all the keys with values [REDACTED]
```

### Use

Wrap every `runway` invocation:

```bash
cd /path/to/the/target/repo
varlock run --schema /path/to/runway/.env.schema -- runway --max 3
```

Or, more conveniently, alias it:

```bash
# in your shell rc
alias runway-secure='varlock run --schema $HOME/Developer/runway/.env.schema -- runway'
```

### What happens

```
varlock run -- runway
       │
       │ 1. reads .env.schema
       │ 2. for each shell-resolver call: invokes 1Password CLI
       │ 3. exports resolved values into process.env for child
       ▼
runway (Node process)
       │ 4. reads LINEAR_API_KEY from process.env
       │ 5. spawns sandcastle.run() — passes OP_SERVICE_ACCOUNT_TOKEN
       │    into the docker provider's env
       ▼
   ─── runway exits ───
       6. process.env disappears with the process
```

No secret ever lands on disk. Done.

## Layer 2 — inside the sandcastle container

The container's Claude Code agent needs `ANTHROPIC_API_KEY` and
`GH_TOKEN`. Sandcastle's default behavior is to read them from the
target repo's `.sandcastle/.env` — i.e., write them to disk. Layer 2
replaces that with in-container varlock + 1Password CLI.

### Per-target-repo setup (one-time)

```bash
cd /path/to/your/target/repo

# 1. Standard sandcastle scaffold
npx sandcastle init

# 2. Replace .sandcastle/.env with an .env.schema at repo root
rm -f .sandcastle/.env .sandcastle/.env.example
cp /path/to/runway/templates/.env.schema.target-repo .env.schema
# edit the op:// paths to match your 1Password vault layout

# 3. Patch the Dockerfile that sandcastle generated
cat /path/to/runway/templates/dockerfile-varlock.snippet >> .sandcastle/Dockerfile
# (then move the appended block above the final ENTRYPOINT line)

# 4. Commit
git add .env.schema .sandcastle/Dockerfile
git commit -m "feat(sandcastle): in-container secret resolution via varlock"
```

### What happens at run time

```
runway calls sandcastle.run({
  sandbox: docker({ env: { OP_SERVICE_ACCOUNT_TOKEN } })
})
       │
       ▼
sandcastle builds + starts container, passes OP_SERVICE_ACCOUNT_TOKEN
       │   (only this one secret crosses the boundary)
       ▼
container runs `sleep infinity` — agent not yet started
       │
       ▼
sandcastle: `docker exec <container> claude ...`
       │
       │   our Dockerfile shim intercepts:
       │   /home/agent/.local/bin/claude is now a 4-line bash script
       │   that runs `varlock run --env-file ... -- claude.real "$@"`
       ▼
varlock (inside container)
       │ 1. reads /home/agent/workspace/.env.schema (the target repo's)
       │ 2. for each op:// ref: invokes 1Password CLI authenticated
       │    with OP_SERVICE_ACCOUNT_TOKEN
       │ 3. exports ANTHROPIC_API_KEY, GH_TOKEN into the claude.real
       │    process env only
       ▼
claude.real runs the agent. When it exits, varlock exits, secrets gone.
```

The image contains: varlock binary, op CLI binary, the shim. **No
secrets**. The container at any moment between agent invocations
contains: nothing sensitive, just `OP_SERVICE_ACCOUNT_TOKEN` in PID 1's
env (`sleep infinity`). During an active claude run, the agent process
holds `ANTHROPIC_API_KEY` and `GH_TOKEN` — these die when the run ends.

## Verifying

After setup, you can prove no secrets sit at rest:

```bash
# In the target repo
git grep -l 'sk-ant\|ghp_\|lin_api'        # should print nothing
git grep -l 'ANTHROPIC_API_KEY=.\|GH_TOKEN=.\|LINEAR_API_KEY=.'  # only schema refs

# At rest in the built image
docker run --rm <runway-image> sh -c 'env | grep -iE "anthropic|gh_token|linear"'
# should print nothing (only OP_SERVICE_ACCOUNT_TOKEN if you exec'd into a running one)
```

## Cost

| Operation | Latency |
|---|---|
| Host varlock startup | ~50ms (one op-CLI lookup per secret) |
| In-container varlock per claude call | ~100-200ms (op-CLI auth + N lookups) |

The per-claude overhead is negligible compared to the agent's
multi-second LLM round trips. Not worth optimizing.

## Fallback

If you don't want varlock yet, runway still works the old way: export
`LINEAR_API_KEY` directly in your shell, and let sandcastle read
`.sandcastle/.env` from the target repo. Layer 1 and Layer 2 are
both opt-in.
