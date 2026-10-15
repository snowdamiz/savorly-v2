#!/bin/sh
# Deploys an environment to Cloudflare: the exported web app, the /api gateway and the Go API
# container. Usage: deploy.sh staging|production. Filled-in values from .env.<environment> are
# uploaded as Worker secrets; secrets already uploaded are kept, so CI can redeploy code
# without them. Requires `wrangler login` (or CLOUDFLARE_API_TOKEN) and Docker.
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

[ -d apps/mobile/node_modules ] || npm --prefix apps/mobile ci
EXPO_PUBLIC_API_URL=/api npm run build
[ -d infra/cloudflare/node_modules ] || npm --prefix infra/cloudflare ci

cd infra/cloudflare
if [ -s "$secrets" ]; then
  echo "Uploading $(wc -l < "$secrets" | tr -d ' ') secrets from .env.$target"
  npx wrangler deploy --env="$wrangler_env" --containers-rollout immediate --secrets-file "$secrets"
else
  npx wrangler deploy --env="$wrangler_env" --containers-rollout immediate
fi
