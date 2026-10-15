#!/bin/sh
# Deploys staging to Cloudflare: the exported web app, the /api gateway and the Go API container.
# Filled-in values from .env.staging are uploaded as Worker secrets; secrets already uploaded
# are kept, so CI can redeploy code without them. Requires `wrangler login` and Docker.
set -eu
cd "$(dirname "$0")/.."

secrets=$(mktemp)
trap 'rm -f "$secrets"' EXIT
if [ -f .env.staging ]; then
  # Skip blank values and untouched YOUR_… placeholders.
  grep -E '^[A-Z0-9_]+=.+' .env.staging | grep -v 'YOUR_' > "$secrets" || true
fi

[ -d apps/mobile/node_modules ] || npm --prefix apps/mobile ci
EXPO_PUBLIC_API_URL=/api npm run build
[ -d infra/cloudflare/node_modules ] || npm --prefix infra/cloudflare ci

cd infra/cloudflare
if [ -s "$secrets" ]; then
  echo "Uploading $(wc -l < "$secrets" | tr -d ' ') secrets from .env.staging"
  npx wrangler deploy --env staging --containers-rollout immediate --secrets-file "$secrets"
else
  npx wrangler deploy --env staging --containers-rollout immediate
fi
