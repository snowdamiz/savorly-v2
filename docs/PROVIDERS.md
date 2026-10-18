# AI provider choices

GPT-6 Luna capabilities and pricing checked October 7, 2026; ElevenLabs via OpenRouter checked October 7; other model and image capabilities checked October 3, 2026; the image edit model October 15. Prices below are USD and can change. The step-clip comparison was checked October 18.

Savorly routes by workload. These are application choices based on current capabilities and published performance, not a cooking-specific model benchmark.

| Workload                                                                 | Environment setting / default                       | Why                                                                                                       |
| ------------------------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Read a recipe from a page without recipe data (link import)              | `OPENROUTER_RECIPE_MODEL=openai/gpt-6.1-sol`        | More reasoning for quantities, restrictions, and a complete structured recipe; medium effort.             |
| Conversational sous-chef, app tools, photo reading, GPT-Live delegations | `OPENROUTER_AGENT_MODEL=openai/gpt-6-luna`    | Multimodal tool use at interactive speed; low effort. Conversational recipe drafting stays in this agent. |
| Recipes translated for readers in another language                       | `OPENROUTER_TRANSLATION_MODEL=openai/gpt-6-luna` | A short structured rewrite: the agent's fast, inexpensive model with low effort, JSON output; made once per recipe and language and shared ([API](API.md#recipe-translations)). |
| Recipe cover photos                                                      | `OPENROUTER_IMAGE_MODEL=openai/gpt-image-2.5-flare` | Current GPT Image 2.5 speed-focused variant; one medium-quality 4:3 image.                                |
| Photo touch-ups (profile and recipe photos)                              | `OPENROUTER_IMAGE_EDIT_MODEL=openai/gpt-image-2.5-sunburst` | GPT Image 2.5's stronger variant, with its biggest lead on editing; same per-token price as Flare. The photo is sent as a reference; one medium-quality image in its own framing. |
| Full-duplex live conversation                                            | `OPENAI_LIVE_MODEL=gpt-live-1`                      | Direct OpenAI Live WebRTC audio, interruption handling and backend delegation.                            |
| Cooking step read-aloud                                                  | OpenRouter `elevenlabs/eleven-v4-turbo`                        | Streaming narration and reusable audio cache; see [cooking narration](COOKING-NARRATION.md).              |
| Hands-free cooking questions ("Chef, …")                                 | `OPENROUTER_AGENT_MODEL=openai/gpt-6-luna`    | One short spoken answer, no tools, low effort, 300 output tokens; see [hands-free cooking](HANDS-FREE.md). Commands are recognized on the device and cost nothing. |
| AI clips of a recipe's steps, on request                                 | `REAPI_VIDEO_MODEL=doubao-seedance-2.0-eco-mini` | Four silent seconds a step at 720p for the lowest 720p price compared below; a step's photo opens its clip ([step clips](API.md#step-clips)). |

GPT-6 Luna standard inference is $0.10/M input and $0.50/M output tokens; fast endpoints can cost $0.20/M and $1/M. GPT-6.1 Sol standard inference is $2/M input and $10/M output; some fast endpoints cost more. GPT Image 2.5 Flare charges $5/M text input, $8/M image input, and $30/M image output tokens, so the per-image price depends on output tokens. GPT-Live costs $0.05 per connected minute, with backend reasoning billed separately. Reasoning tokens are billed as output.

Agent and image requests prefer low-latency endpoints; recipe import jobs prefer output throughput. Text/tool requests require providers to support the requested parameters. Provider latency statistics are not measured Savorly response times or guarantees. Tool loops and network/queue time add latency. GPT-Live carries the conversation directly and delegates app operations to OpenRouter; ElevenLabs is not inserted into its audio path.

All selections are server-side and reported by `/v1/capabilities`. `OPENROUTER_VOICE_MODEL` is accepted only as a legacy fallback when `OPENROUTER_AGENT_MODEL` is unset; it never selects the speech model. Changing `.env` requires restarting the API. Overrides must support the same JSON/tool/vision or image contract; revisit budget reservations if pricing changes.

Sources: [OpenRouter catalog](https://openrouter.ai/api/v1/models), [GPT-6 Luna](https://openrouter.ai/openai/gpt-6-luna), [GPT-6.1 Sol](https://openrouter.ai/openai/gpt-6.1-sol), [GPT Image 2.5 Flare](https://openrouter.ai/openai/gpt-image-2.5-flare), [GPT Image 2.5 Sunburst](https://openrouter.ai/openai/gpt-image-2.5-sunburst) and its [endpoint record](https://openrouter.ai/api/v1/images/models/openai/gpt-image-2.5-sunburst/endpoints), [Flare vs Sunburst Arena results](https://carat.im/en/curated/gpt-image-2-5-guide), [image endpoint capabilities and pricing](https://openrouter.ai/api/v1/images/models/openai/gpt-image-2.5-flare/endpoints), [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection), [GPT-Live](https://developers.openai.com/api/docs/models/gpt-live-1).

Step clips default to **reAPI Seedance 2.0 Mini Eco at 720p**, the lowest 720p price directly verified in this comparison. A recipe gets one clip per step, so the per-clip price matters more than in the single dish video it replaced (Seedance 2.5 Eco, five seconds, $1.005). This is not a claim that every provider on the market was compared, nor that the tiers have equal quality: reAPI documents potentially lower quality for Mini Eco than standard Mini, and 50–100 s more latency, which clips made in the background can take. No clip has been generated against a funded key yet, so check the quality with a few real ones before relying on it.

| Provider/tier                     | Published rate (720p unless noted) | 4-second clip |
| --------------------------------- | ---------------------------------: | ------------: |
| reAPI Seedance 2.0 Mini Eco       |                    $0.036 / second |        $0.144 |
| reAPI Seedance 2.0 Mini, 480p     |                    $0.036 / second |        $0.144 |
| reAPI Seedance 2.0 Mini           |                    $0.077 / second |        $0.308 |
| reAPI Seedance 2.5 Eco            |                    $0.201 / second |        $0.804 |
| reAPI Seedance 2.5 standard       |                    $0.267 / second |        $1.068 |

Four seconds is the shortest clip these models make. References: [reAPI Seedance 2.0 Mini prices](https://reapi.ai/models/seedance-2-0-mini), [Mini and Mini Eco contract](https://reapi.ai/docs/seedance-2-0-mini), [Seedance 2.0 request body](https://reapi.ai/docs/seedance-2-0), [reAPI Seedance 2.5 prices](https://reapi.ai/models/seedance-2-5).

## Contracts implemented

- OpenRouter: `POST /api/v1/chat/completions`, JSON mode, 3,500 output tokens for quick answers or 8,192 for detailed jobs (including reasoning). Recipes are validated against the application's recipe schema before the job completes. Agent turns use tools with at most six round trips, 6,500 tokens per call, and preserve opaque `reasoning_details` across tool results as [required by reasoning models](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens#preserving-reasoning).
- OpenRouter: `POST /api/v1/images`, one medium-quality 4:3 JPEG, base64 result decoded and stored in local development storage or R2. [Image documentation](https://openrouter.ai/docs/guides/overview/multimodal/image-generation).
- OpenRouter: `POST /api/v1/audio/speech`, ElevenLabs v4 Turbo and streamed MP3 using `OPENROUTER_API_KEY`; voice selected by `OPENROUTER_TTS_VOICE`. See [narration setup](COOKING-NARRATION.md).
- OpenAI: `POST /v1/live/sessions` with `OPENAI_LIVE_MODEL`, WebRTC audio and server sideband. Both the SDP response and capabilities report the configured model. See [live voice setup](RECIPE-STUDIO.md).
- reAPI: `POST /api/v1/videos/generations`, model `doubao-seedance-2.0-eco-mini` (`REAPI_VIDEO_MODEL`), one clip per recipe step: 4 seconds, 720p, 16:9, no audio, moderation and AI watermark enabled, and the step's photo, when it has one, as `image_with_roles` `first_frame`. Poll `GET /api/v1/tasks/{id}`. The MP4 is copied to app media storage using a bounded, SSRF-protected downloader. Mini Eco is $0.036 a second at 720p ($0.144 a clip, checked October 18, 2026); reAPI says its picture may be a little below standard Mini ($0.077 a second) and it takes 50–100 s longer, which suits clips made in the background.
- No live paid generation was performed during development. Provider contracts are covered by mock-server tests; funded credentials are required for a live smoke test.

## Cost and reliability controls

Provider keys never reach Expo. Each member's plan sets 30-day allowances and an AI spend ceiling, and free members share a daily budget funded partly by paying members' revenue (see [pricing](PRICING.md)). Job reservations are $0.05 for quick text, $0.25 for full recipes/adaptations/meal plans, $0.05 per image (a medium 4:3 cover costs about $0.01–0.02), and $0.18 per step clip. Manual generation and assistant-created media share the same estimates. Conversation turns reserve separately based on transcript/photo size and the maximum tool rounds, then settle to OpenRouter's reported cost. These are conservative estimates, not an exact billing ledger or a guarantee of actual spend. **Set hard spending limits on the provider accounts too.** Reassess reservations when changing models.

Jobs use persistent Postgres state and per-user idempotency keys. A worker atomically claims queued jobs; reAPI task IDs are retained before polling. Interrupted submissions are marked failed after ten minutes instead of being automatically re-submitted, which could duplicate paid requests. Polling survives restarts. Output archival failures retain the provider task ID in the database for operator recovery. There is no automatic model fallback; requests can fail over between providers of the selected model. Queued jobs use the worker's configured model when they start, so drain the queue before changing model settings.

AI output is always editable before publishing, recipes/media carry an AI disclosure, nutrition is approximate, and dietary preferences never guarantee allergen safety. Meal-plan AI returns suggestions; the user explicitly adds chosen recipes to the planner.

## Optional email

Password recovery uses [Cloudflare Email Service's send endpoint](https://developers.cloudflare.com/email-service/get-started/send-emails/) with a domain onboarded in the same Cloudflare account; Workers Paid includes 3,000 emails a month. Codes are random, hashed in Postgres, expire in fifteen minutes, and permit five failed attempts. A successful reset invalidates every account session. Recovery is disabled until `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_EMAIL_API_TOKEN` and `EMAIL_FROM` are supplied. No recovery email was sent during development.
