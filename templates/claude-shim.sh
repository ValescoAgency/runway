#!/usr/bin/env bash
# VA-358 / VA-413: claude wrapper inside the sandcastle container.
#
# Every `claude` invocation is routed through varlock, which resolves
# the op:// references in .env.schema and exposes them as env vars to
# the wrapped process. The original binary moved to claude.real
# during image build; this shim runs at exec time.
#
# VA-413: when the four RUNWAY_SIGNING_* env vars are populated, we
# materialise the SSH signing key into $HOME/.config/runway/ and
# configure git globally so every `git commit` the agent runs is
# signed. Partial configs are treated as "off" — a half-applied
# scaffold doesn't half-sign commits. The key file lives only inside
# the container; when sandcastle tears it down at end of run, the
# file goes with it.
set -euo pipefail
exec varlock run --env-file /home/agent/workspace/.env.schema -- \
  bash -euo pipefail -c '
if [[ -n "${RUNWAY_SIGNING_SSH_PRIVKEY:-}" \
   && -n "${RUNWAY_SIGNING_SSH_PUBKEY:-}" \
   && -n "${RUNWAY_SIGNING_NAME:-}" \
   && -n "${RUNWAY_SIGNING_EMAIL:-}" ]]; then
  umask 077
  mkdir -p "$HOME/.config/runway"
  printf "%s\n" "$RUNWAY_SIGNING_SSH_PRIVKEY" > "$HOME/.config/runway/signing_key"
  printf "%s\n" "$RUNWAY_SIGNING_SSH_PUBKEY"  > "$HOME/.config/runway/signing_key.pub"
  chmod 600 "$HOME/.config/runway/signing_key"
  chmod 644 "$HOME/.config/runway/signing_key.pub"
  git config --global gpg.format ssh
  git config --global user.signingkey "$HOME/.config/runway/signing_key.pub"
  git config --global commit.gpgsign true
  git config --global tag.gpgsign true
  git config --global user.name  "$RUNWAY_SIGNING_NAME"
  git config --global user.email "$RUNWAY_SIGNING_EMAIL"
fi
exec /home/agent/.local/bin/claude.real "$@"
' -- "$@"
