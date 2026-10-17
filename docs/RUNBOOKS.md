# Runbooks

Step-by-step procedures for production incidents and routine operations. Commands run from the
repository root unless they say otherwise; Cloudflare commands run in `infra/cloudflare`, where
`--env staging` selects staging and no flag means production. Rehearse the database restore before
you need it.

## Restore the database

Neon keeps a history of every change for the project's history window, which depends on the plan
(Neon console → the project → Settings), and can branch or restore to any moment inside it. The
database and the media in R2 aren't restored together; see [R2](#recover-media-in-r2).

**1. Branch from just before the problem.** Pick the time in UTC, then (or in the console: Branches
→ Create branch → from a point in time):

```sh
neonctl branches create --project-id <production project id> --name restore-20261016 --parent 2026-10-16T09:58:00Z
neonctl connection-string restore-20261016 --project-id <production project id>
```

**2. Point staging at the branch** to check it through the app. Staging then serves real members'
data, so keep it to yourself while it does: don't trigger password-reset emails (they reach real
people), and remember that AI features spend money. In your checkout:

- set `SEED_DATA` to `"false"` under `env.staging` in `infra/cloudflare/wrangler.jsonc`, so fixture
  recipes aren't written into the branch;
- put the branch's connection string in `DATABASE_URL` in `.env.staging`, keeping the old value;
- run `npm run deploy:staging`. The API picks up the new `DATABASE_URL` when it restarts, within
  about 10 minutes in the daytime ([cold starts](DEPLOYMENT.md#cold-starts));
  `npx wrangler tail --env staging` shows `restarting the API for changed settings`.

**3. Verify** on staging.savorly.cooking: sign in with your own account, open the recipes and
members that were affected, compare the admin console's Overview with what you expect, and check
that the newest recipes stop at the restore time. Photos still load: they come from the production
bucket.

**4. Swap production.** Either way, writes made after the restore time are lost from production:

- _Restore in place_ (connection string unchanged): restore the production project's default
  branch (the one `DATABASE_URL` points at) to the same moment. Neon keeps the state before the
  restore as a branch, from which lost rows can be copied back.

  ```sh
  neonctl branches restore <default branch> ^self@2026-10-16T09:58:00Z --preserve-under-name before-restore-20261016 --project-id <production project id>
  ```

  Existing connections drop briefly and the API reconnects by itself.

- _Use the verified branch_: put its connection string in `DATABASE_URL` in `.env.production`,
  run `npm run deploy:production`, and make it the default branch
  (`neonctl branches set-default restore-20261016`).

**5. Put staging back**: restore `DATABASE_URL` in `.env.staging` and `SEED_DATA`, deploy staging,
and delete the restore branch unless production now uses it
(`neonctl branches delete restore-20261016`).

A rehearsal is steps 1–3 and 5 with a recent timestamp; note how long each took.

## Recover media in R2

R2 keeps no deleted or overwritten copies: there is no versioning or recycle bin, so a lost object
can only come back from a copy kept elsewhere. Savorly itself never overwrites (every upload gets a
new random key) and never deletes public media (`savorly-media`); only the private
`savorly-sources` bucket is cleaned up, on purpose, when a sous-chef conversation or an account is
deleted. Loss would come from people or tools: a lifecycle rule, a script, a dashboard delete, or a
leaked R2 token.

- To protect the media, add an R2 bucket lock rule to `savorly-media` (R2 → the bucket → Settings →
  Bucket lock), which blocks deleting or overwriting objects for a retention period. Keep it at 30
  days or less: the account-deletion page promises to delete a member's files within 30 days of a
  request, and a lock longer than that would prevent it.
- For copies, sync the bucket on a schedule to another bucket or provider with a separate read-only
  token (for example `rclone sync`); recovering is copying objects back under the same keys.
- After a database restore, restored rows point at objects that still exist; objects uploaded
  after the restore time remain in the bucket unused.

## Rotate or remove a secret

Secrets live in three places: Worker secrets for each environment (the API's settings, uploaded
from `.env.<environment>` by `npm run deploy:<environment>`), GitHub Actions secrets
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `EXPO_TOKEN`), and the app-signing credentials
EAS keeps. `npx wrangler secret list [--env staging]` shows the names of the Worker's secrets.

To rotate one:

1. Create the new credential at the provider while the old one still works.
2. Put it in `.env.<environment>` and run `npm run deploy:<environment>`, or set just that one with
   `npx wrangler secret put NAME [--env staging]`.
3. Wait for the API to restart with it: the running container keeps the settings it started with,
   and the warm-up restarts it within about 10 minutes between 07:00 and 23:00 UTC (otherwise, when
   it next starts after 30 idle minutes). `npx wrangler tail [--env staging]` shows
   `restarting the API for changed settings`; `/api/v1/capabilities` shows features coming back.
4. Revoke the old credential.

Notes for particular secrets:

- `DATABASE_URL`: resetting a Neon role's password ends it at once, so new database connections fail
  until the API has restarted with the new URL. Do it outside busy hours, or switch to a second
  role first.
- `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`: create a new R2 token scoped to the environment's two
  buckets, switch both values, then delete the old token.
- `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`: Stripe's roll actions can keep the old key or
  signing secret valid for a while, which covers the restart.
- `APPLE_KEY_ID` with `APPLE_PRIVATE_KEY`: create a new Sign in with Apple key, switch both, then
  revoke the old key.
- GitHub secrets: GitHub → Settings → Secrets and variables → Actions; replace, then revoke the old
  token at Cloudflare or Expo.
- Everyone's sessions: deleting the `sessions` rows (Neon SQL editor: `DELETE FROM sessions;`) signs
  every member out; the admin console signs out one member.

To remove a secret, delete its line from `.env.<environment>` **and** run
`npx wrangler secret delete NAME [--env staging]`: deploys never remove secrets, and an empty line
isn't uploaded. Removing the `APPLE_*` secrets, for example, is how Apple sign-in is turned off.

## Roll back a release

- **Worker and web app, at once:** `npx wrangler versions list [--env staging]`, then
  `npx wrangler rollback <version id> [--env staging] -m "<why>"`. That brings back the earlier
  Worker code and the web app exported with it. The API container isn't part of a Worker version
  (its image is rolled out by the deploy), so treat this as reverting the website only.
- **The API too:** deploy the last good commit. The quick way is from a checkout of it:
  `npm run deploy:production` (Docker running). The durable way is to revert the change on `main`
  and push `main:release`, which runs the full CI first.
- **The apps:** in `apps/mobile`, `npx eas-cli@24.14.0 update:rollback` republishes the previous
  update on a channel (or the build's own code); `npx eas-cli@24.14.0 update:list --branch
production` and `update:republish --group <group id>` bring back a particular one. Phones get
  it on their next check. A native build can only be replaced by a newer build.
- **Migrations aren't rolled back.** They only move forward, so the previous API must still work
  with the newer schema; keep migrations additive (CONTRIBUTING.md).
- Then fix `main`: the next push to `release` or `staging` deploys whatever `main` has.

## Release gating

Pushes to `staging` and `release` deploy straight away once CI passes. To require a person's
approval for production and keep the branches safe (GitHub repository settings; nothing in this
repository changes them):

1. **Environments** (Settings → Environments): open `production` (CI creates it on the first
   deploy, or add it), turn on **Required reviewers** and add the people who may approve
   production deploys (with a second maintainer, also **Prevent self-review**). Under **Deployment
   branches and tags** choose **Selected branches and tags** and allow only `release`. Give
   `staging` the same branch rule for `staging`, without reviewers. The production `deploy` job then
   waits for an approval, and `ship-android` waits for it.
2. **Rulesets** (Settings → Rules → Rulesets → New branch ruleset): target `release` and
   `staging`; block deletions and force pushes, require the status checks `verify` and
   `Static analysis and audits`, and restrict who can push (bypass list: the maintainers). A
   commit that already passed on `main` can still be pushed with `git push origin main:release`.
   For `main`, block force pushes and require the same checks; once there are other maintainers,
   require pull requests with a review from code owners (`.github/CODEOWNERS`).
3. **Security** (Settings → Advanced Security): turn on private vulnerability reporting
   ([SECURITY.md](../SECURITY.md)), Dependabot alerts and security updates (version updates are
   configured in `.github/dependabot.yml`).
