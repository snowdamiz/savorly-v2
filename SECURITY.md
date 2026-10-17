# Security policy

## Reporting a vulnerability

Please report security problems privately through GitHub:
[report a vulnerability](https://github.com/snowdamiz/savorly-v2/security/advisories/new) (the
**Security** tab → **Report a vulnerability**). Don't open a public issue, pull request or
discussion about it. If the form isn't available, open an issue that only asks for a private
contact, without details.

Include what you found, the steps to reproduce it, the affected URL, endpoint or app version (the
app shows its version in **My kitchen → App updates**), what an attacker could do with it, and how
to reach you.

## Scope

- The code in this repository: the Expo app (`apps/mobile`), the Go API (`services/api`), the
  Cloudflare Worker (`infra/cloudflare`) and the scripts and CI that build and deploy them.
- What it runs: [savorly.cooking](https://savorly.cooking), its `/api`, and
  [staging.savorly.cooking](https://staging.savorly.cooking), and the Savorly apps for iOS and
  Android.

Out of scope: vulnerabilities in the services Savorly uses (Cloudflare, Neon, OpenRouter, OpenAI,
reAPI, Stripe, Apple, Google, Expo; please report those to them), denial-of-service and volume
testing, spam and social engineering, and scanner output or missing headers without a
demonstrated impact. Advisories in development tooling that are already tracked in
[docs/VERIFICATION.md](docs/VERIFICATION.md) are known.

## Testing

Use accounts you created for testing, preferably on staging. Don't access, change or delete other
people's data, don't degrade the service, and avoid running up AI usage: the sous-chef, images,
videos and narration cost real money per request.

## What to expect

Savorly is a small project. You should get an acknowledgement within 5 days and an assessment
within 14. Fixes reach the website and API with the next deploy and the apps as an over-the-air
update or a new build. Only the current deployment and the current app builds are supported. We'll
agree a disclosure date with you, and credit you in the advisory if you'd like; please allow up to
90 days before publishing details.
