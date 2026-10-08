# Sous-chef: chat, live voice, and camera

The sous-chef is one assistant for anything the app does. The floating button on every screen opens it, as do **Ask** on a recipe page and the sparkle button in cooking mode; **Create a recipe → Speak / Scan / Chat** opens the same conversation in live voice, the camera, or text. Typed messages, live speech, and photos share one history, draft, and background image/video pipeline.

## What it can do

- Find recipes (text, ingredients, cuisine, tag, cook, time) and cooks, read reviews, and show tappable recipe cards in the reply.
- Read any published recipe or the user's own; answer cooking questions, swaps, and scaling.
- Save and unsave recipes, create and delete cookbooks, follow and unfollow cooks, review and report recipes.
- Plan meals, add groceries or a whole recipe's ingredients, check items off, keep the pantry, and remove plan/grocery/pantry entries.
- Create recipes (below), and edit, publish, unpublish, or delete the user's existing recipes. Edits keep the recipe's photos; it can also make a new AI cover photo or video on request.
- Update the user's name, bio, diets, and allergies.
- Act on screen: open a recipe, start cooking mode at a step, move between steps, start the step timer, open a page, or change the interface language.

It cannot change email, password, or sign-in, or delete the account; those stay in My kitchen. Several steps run in one turn ("plan three quick dinners and add their groceries"). After each reply the app refreshes the planner, lists, cookbooks, and the open recipe. Every action goes through the same HTTP handlers as the app (an in-process router that registers only the assistant's routes), so validation and ownership checks are identical.

**What it sees.** While the sheet is open (or minimized), the app reports the open page, the open recipe, the cooking-mode step, and the device time zone (`PUT /:id/context`). The server allowlists the page, shows the recipe only if the owner may see it, and validates the time zone, so "this recipe", "next step", and "tomorrow" resolve in the user's own day, not the server's.

**Confirmation.** Deleting a recipe, publishing one, changing a published recipe, and posting a review return a server-written description instead of acting ("Update your published recipe “Lasagna”: servings 4 → 6; adds basil."). The app stores the exact action; `confirm_action` runs it only after a later user message, and the proposal lapses if the next turn does anything else. A draft created in the conversation keeps its own read-back gate.

**Live voice while browsing.** Opening a recipe or cooking mode from a live conversation minimizes the sheet to a pill above the tab bar, and the conversation keeps listening; the pill returns to the chat or ends the call. A typed chat closes instead.

## Recipe flow

- **Talk:** the **Talk** button in the composer (or **Speak it**) requests microphone permission and starts a GPT-Live conversation. Dictate naturally, including pauses and corrections. Say “make it” or “that's everything” when finished. The assistant asks essential missing details aloud, one at a time. Say “read it back,” “publish,” “retry the media,” or “save and finish.” Publishing requires a review and explicit affirmation of the current revision.
- **Photo:** use the in-app camera (preview, switch camera, capture, retake) or upload an image. The app normalizes the photo to JPEG, scales large images to 2048px width, and submits it automatically. The vision model reads the recipe, asks about illegible or missing details in chat, and creates the same draft/media bundle. You can switch to voice to answer.
- **Chat:** ask for anything, or describe a recipe or rough idea, answer questions, request changes, and review/publish conversationally. A single message supports up to 24,000 characters. A conversation can contain multiple messages and images.
- The recipe is saved privately before media is queued. The cover image and short Seedance dish video run independently. Their results attach automatically. Media continues after closing the sheet or microphone. The video is a generated dish clip, not a verified video of every cooking step.
- A conversation active in the last six hours resumes when the sheet opens; older ones are in the history row, and **New chat** starts fresh. One conversation holds one draft at a time; starting a different recipe waits until the current draft's media has attached.
- Recent conversations resume across devices. Corrections invalidate publication approval and old media revisions; manually editing the recipe also prevents an older AI image/video from replacing those edits. Failed media can be retried explicitly, with a new generation charge. Photos and transcripts are not automatically published.

## Configure

Add to the repository `.env` (never an Expo public environment variable):

```dotenv
OPENAI_API_KEY=...
OPENAI_PROJECT_ID=
OPENAI_LIVE_MODEL=gpt-live-1
OPENAI_LIVE_VOICE=gleam
OPENROUTER_API_KEY=...
OPENROUTER_AGENT_MODEL=openai/gpt-6-luna
OPENROUTER_IMAGE_MODEL=openai/gpt-image-2.5-flare
REAPI_API_KEY=...
AI_DAILY_BUDGET_USD=10
S3_SOURCE_BUCKET=savorly-sources
```

The OpenAI project must have access to `gpt-live-1`. `OPENAI_LIVE_MODEL` selects the direct OpenAI audio model; `OPENROUTER_AGENT_MODEL` selects the backend reasoning/vision agent for both text chat and Live delegations. The legacy `OPENROUTER_VOICE_MODEL` name remains a fallback for older deployments but does not select audio. GPT-6 Luna runs with low reasoning effort and latency-prioritized routing; tool round trips preserve the provider's required reasoning metadata. Images use GPT Image 2.5 Flare through OpenRouter; videos use the existing Seedance 2.5 reAPI adapter. Cooking step narration uses ElevenLabs v4 Turbo through the same OpenRouter account and key, separately from the live conversation audio. The model/voice selection is server controlled and the selected models are visible through `/v1/capabilities`. See [all model choices and prices](PROVIDERS.md).

GPT-Live currently costs $0.05 per connected minute, including listening and waiting; recipe reasoning, image generation, and video generation are additional. Each plan includes live voice minutes per rolling 30 days (see [pricing](PRICING.md)). The application reserves up to 30-minute segments against the member's allowance and AI spend ceiling; a smaller remaining allowance reserves only that time. Confirmed provider finalization releases the unused reservation; interrupted/ambiguous calls keep their conservative reservation. Provider hard spending caps remain necessary because estimated costs are not invoices. Three minutes without user speech pauses the connection. There is no 60-second recording limit or silent transcript truncation; session renewal and explicit resume retain history. A reconnect can briefly interrupt capture, and the UI indicates reconnection. Plan allowances still apply.

For local development, restart SeaweedFS after updating `infra/seaweedfs/s3.json`. The authenticated app creates `savorly-sources` on first import. Anonymous access to this bucket is denied. Public recipe covers/videos remain in `savorly-media`.

For R2, provision a **separate private bucket** named by `S3_SOURCE_BUCKET`, leave `r2.dev` disabled, and do not attach a public custom domain. Grant the backend credentials access to both buckets. The source bucket is not automatically provisioned in production. Source photos are read through authenticated S3 and sent to the vision model as data URLs, so local SeaweedFS does not need to be publicly reachable. Do not make the source bucket public.

Restart the API after changing its environment. Migrations `004_voice_recipes.sql` through `006_studio_confirmation.sql`, `009_assistant_cards.sql`, and `010_assistant_context.sql` run automatically. No provider calls are made during migrations or ordinary browsing.

## Expo and Cloudflare

Web uses browser WebRTC for bidirectional audio. `react-native-webrtc` provides the native adapter; native voice requires a new development/production build, not Expo Go. Camera and image import use Expo Camera, ImagePicker, and ImageManipulator. Native audio mode enables recording/speaker playback and avoids background recording. An active voice conversation keeps the screen awake where supported, so device auto-lock does not interrupt hands-free dictation. Closing the sheet, switching modes, or backgrounding the app stops microphone tracks and closes the provider session. Browser autoplay restrictions expose an “Enable assistant audio” button.

Configure `EXPO_PUBLIC_API_URL` for physical devices to reach the API. Run `eas build --profile development` after native dependencies/config plugins change. The web app must be on HTTPS or localhost. Cloudflare now allows same-origin camera and microphone access and runs the Worker for static responses as well as API requests, so the headers are applied consistently.

## Backend and persistence

- `/v1/recipe-studio`: list/create conversations. Creation accepts a UUID `Idempotency-Key`.
- `/:id`: read/delete an owned conversation. Deleting history retains its separately saved recipe. End voice before deleting.
- `/:id/events?after=…`: paginated transcript events, 1,000 per request, monotonically increasing cursor. The app drains pages without discarding earlier transcript text. Assistant events carry `recipes` (cards it chose to show, filtered to recipes the owner can see) and `actions` (screen actions, run only for replies that arrive while the sheet is open).
- `/:id/context` (PUT): the page, open recipe, cooking step, and IANA time zone the assistant should assume.
- `/:id/messages`: enqueue text plus optional owned image IDs; requires `Idempotency-Key`. Replayed keys cannot create duplicate work or carry different input.
- `/:id/images`: authenticated multipart photo upload; returns an opaque source ID, not a public URL. JPEG/PNG/WebP, at most 10 MB each, four attachments per message, twenty per conversation.
- `/:id/voice`: exchange a WebRTC SDP offer for an answer. Only the server uses the OpenAI key. A server sideband attaches before the answer is returned, persists transcript fragments, and accepts model delegations.
- `/voice/:session`: request a graceful close of an owned voice connection.

The sideband ignores reflected audio payloads. OpenAI session storage is disabled (`store:false`); Savorly persists text transcripts, not raw microphone recordings. Provider retention policies still apply. Source deletion uses a durable outbox so deleting a conversation or account also removes its private source objects from storage; the worker must be running for cleanup to finish.

Each message or voice delegation runs one bounded tool loop (at most six model calls, the last forced to answer in text). The reservation assumes every round resends the conversation; after a completed turn it is settled to the cost OpenRouter reports (`usage.cost`), and a failed turn keeps its reservation. A failed turn that already changed data says so, so the next turn checks before repeating.

The application, not the model, enforces ownership, validates recipe shape, writes SQL, checks current revisions, gates publishing, reserves cost, and enqueues media. Delegations have stable IDs and database uniqueness. The media worker uses bounded parallel execution, `SKIP LOCKED` claims, and durable states. Interrupted ambiguous paid submissions are not blindly replayed. A recovery pass handles a crash between draft creation and media enqueueing.

## Verification and limits

Automated checks cover structured clarification/build, media attachment, stale revision rejection, manual-edit protection, publish review gating, long transcript preservation, message idempotency, owned photo references, budget exhaustion without losing a recipe, recovery, private SeaweedFS source reads/deletion, and the Live WebRTC/sideband contract. Browser tests use mocked provider responses and synthetic camera/microphone devices; they exercise real Expo camera capture/retake and JPEG upload handling.

No funded OpenAI, OpenRouter, or reAPI requests have been made. No physical iOS/Android microphone/camera test, native binary build, or cloud deployment is implied by JavaScript bundle exports. Verify these with the configured accounts and a device before launch. Full-duplex voice quality, real provider event ordering, model extraction accuracy, and latency need that live validation. There is no claim of unlimited provider context or zero-gap reconnection.

## Primary references

- [GPT-Live model and pricing](https://developers.openai.com/api/docs/models/gpt-live-1)
- [OpenAI WebRTC session creation](https://developers.openai.com/api/docs/guides/voice-webrtc)
- [Live client delegation](https://developers.openai.com/api/docs/guides/live-delegation)
- [Server sideband controls](https://developers.openai.com/api/docs/guides/voice-server-controls)
- [OpenRouter model catalog](https://openrouter.ai/api/v1/models)
- [Expo SDK 57 Camera](https://docs.expo.dev/versions/v57.0.0/sdk/camera/)
