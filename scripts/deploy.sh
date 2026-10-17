#!/bin/sh
# Deploys an environment to Cloudflare: the exported web app, the /api gateway and the Go API
# container. Usage: deploy.sh staging|production. Requires `wrangler login` (or
# CLOUDFLARE_API_TOKEN) and Docker.
#
# Filled-in values from .env.<environment> are uploaded as Worker secrets. Uploaded secrets
# persist: a deploy never removes one (CI deploys code only, without a .env file), and deleting a
# line from .env.<environment> doesn't remove it either. The only way to remove a secret is
#   cd infra/cloudflare && npx wrangler secret delete NAME [--env staging]
# and `npx wrangler secret list [--env staging]` shows which are set (docs/RUNBOOKS.md).
set -eu
target=${1:-}
case $target in
  staging) wrangler_env=staging ;;
  production) wrangler_env= ;; # the top level of wrangler.jsonc
  *) echo "usage: deploy.sh staging|production" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."

secrets=$(mktemp)
trap 'rm -f "$secrets"' EXIT
if [ -f ".env.$target" ]; then
  # Skip blank values and untouched YOUR_… placeholders.
  grep -E '^[A-Z0-9_]+=.+' ".env.$target" | grep -v 'YOUR_' > "$secrets" || true
fi

# The web app preconnects to the origin recipe media comes from (scripts/web-postbuild.mjs):
# EXPO_PUBLIC_MEDIA_ORIGIN if set (CI passes the MEDIA_ORIGIN variable), else the origin of
# S3_PUBLIC_URL in .env.<environment>, else production's media domain.
if [ -z "${EXPO_PUBLIC_MEDIA_ORIGIN:-}" ]; then
  EXPO_PUBLIC_MEDIA_ORIGIN=$(sed -n -E 's#^S3_PUBLIC_URL=["'\'']?(https://[^/"'\'']+).*#\1#p' "$secrets" | head -n 1)
  if [ -z "$EXPO_PUBLIC_MEDIA_ORIGIN" ] && [ "$target" = production ]; then
    EXPO_PUBLIC_MEDIA_ORIGIN=https://media.savorly.cooking
  fi
fi
export EXPO_PUBLIC_MEDIA_ORIGIN

[ -d apps/mobile/node_modules ] || npm --prefix apps/mobile ci
# The root `npm run build`, plus --clear: Metro reuses cached transforms between exports, with
# EXPO_PUBLIC_* values inlined, so an earlier local build's API URL could end up in this one.
EXPO_PUBLIC_API_URL=/api npm --prefix apps/mobile run build -- --clear
node scripts/web-postbuild.mjs
[ -d infra/cloudflare/node_modules ] || npm --prefix infra/cloudflare ci

cd infra/cloudflare
# Gradual, wrangler's default, rather than `immediate`; with the API's single container both
# replace it in one step, so see docs/DEPLOYMENT.md#deploys-and-live-sessions for what that means.
if [ -s "$secrets" ]; then
  echo "Uploading $(wc -l < "$secrets" | tr -d ' ') secrets from .env.$target"
  npx wrangler deploy --env="$wrangler_env" --containers-rollout gradual --secrets-file "$secrets"
else
  npx wrangler deploy --env="$wrangler_env" --containers-rollout gradual
fi
