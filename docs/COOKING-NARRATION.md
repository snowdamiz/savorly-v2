# Cooking narration

The cooking screen reads saved recipe steps with ElevenLabs **`elevenlabs/eleven-v4-turbo` through OpenRouter**. Device text-to-speech remains available when OpenRouter is unconfigured, the user is signed out, a recipe is unsaved/stale, the provider fails, or a spending limit is reached. Timer alerts continue to use device speech so they work without a network connection.

## Enable

Add the key to the repository `.env` (or the API server's secret environment) and restart the API:

```dotenv
OPENROUTER_API_KEY=your_existing_openrouter_key
OPENROUTER_TTS_VOICE=sarah
```

Narration reuses the same OpenRouter key as chat and images; no ElevenLabs account or key is required. `sarah` is the default supported voice name. Other accepted names include `george`, `jessica`, and `river`; consult the OpenRouter model catalog before changing it. Direct ElevenLabs voice IDs are not the OpenRouter voice names. Never put the key in an `EXPO_PUBLIC_` variable. Reload the app after restarting the API so it refreshes `/v1/capabilities`.

The existing embedded database migration runs on API startup. This provider change needs no new migration, mobile dependency, storage bucket, or microphone permission. Full-duplex GPT-Live conversations still require the direct OpenAI Live API and `OPENAI_API_KEY`; OpenRouter's speech endpoint synthesizes text and does not replace the Live WebRTC session protocol.

## Playback and latency

- Opening cooking mode makes no paid narration request. The first read-aloud tap prepares the current step. Once playback begins, only the next step is prefetched.
- The server calls OpenRouter's **`POST /api/v1/audio/speech`** with bearer authentication, `model: elevenlabs/eleven-v4-turbo`, the saved instruction as `input`, the configured `voice`, and `response_format: mp3`. The response is raw `audio/mpeg`. Each chunk is forwarded immediately; clean HTTP EOF completes the recording and preserves the final encoder bytes. Empty, non-audio, oversized, or interrupted responses fail without being cached or automatically retried.
- The audio GET streams MP3 chunks while synthesis continues, including for the usual `bytes=0-` request. Fully cached audio supports byte ranges. Players that first request a bounded range such as `bytes=0-1` (including some iOS players) wait for the complete file to obtain its length; preloading removes this wait on subsequent steps.
- Native playback uses `expo-audio`; web playback explicitly handles browser autoplay restrictions. If Safari requires another gesture after the initial download, the screen asks the user to tap again, reusing the prepared recording.
- Stop, Next, Previous, Finish, opening the sous-chef, and closing cooking mode stop playback. Late requests cannot resume an old step. In-flight generation is allowed to finish and populate the cache, since it may already have incurred a provider charge.
- The mobile screen retains a small window of prepared players. This is buffering for the current cooking session, **not a persistent offline-download feature**.

## Authentication, caching, and limits

`POST /v1/recipes/:id/steps/:step/narration` requires a signed-in user and checks recipe visibility. Its text must exactly match the saved step; arbitrary client text is never synthesized. It returns an authenticated streaming path. `GET` independently checks visibility and the current instruction hash and never starts a paid generation. Web audio sends HttpOnly cookies; native audio sends its existing bearer token.

Complete recordings are stored in PostgreSQL `recipe_narrations`, keyed by recipe, step, exact text, voice, model, and format. Replays and concurrent requests reuse audio. PostgreSQL locks prevent duplicate generation across replicas. A GET routed to a different replica waits for the shared cache; keeping both requests on the same replica enables first-chunk streaming. Deleted recipes cascade-delete their audio. Failed or incomplete recordings are not cached. The OpenRouter model ID and output format produce a new cache key, so old direct-provider recordings are not reused accidentally.

Narration reservations participate in `AI_DAILY_BUDGET_USD`, estimating the regular v4 Turbo rate of **$40 per million characters**. OpenRouter's launch price is $20 per million characters through October 19, 2026; that temporary discount is deliberately excluded from reservations. Provider billing and spending caps remain authoritative. Each member's plan also limits new read-aloud generations (see [pricing](PRICING.md)); there is a 4,000-character step limit, four active generations per API process, a 25-second generation deadline, and an 8 MiB recording limit. Prefetches count as generations. Failed attempts retain their conservative spend reservation and have a short retry cooldown.

## Verification

Provider tests use a local HTTP server to cover OpenRouter authentication and payloads, first-chunk streaming, final MP3 bytes, error statuses, non-audio bodies, empty/truncated/oversized streams, cancellation, and multiple listeners. Configuration tests confirm that only the OpenRouter key enables narration. Database tests use isolated schemas to cover visibility, stale instructions, shared caching across replicas, spending limits, and byte ranges. Browser/controller tests cover real audio playback, prefetching, cancellation, replay, fallback, and autoplay rejection. These tests do not call OpenRouter or ElevenLabs or spend credits.

Real voice quality, account access, and device/network latency must be checked after a real API key is supplied. Native iOS/Android playback requires device validation.

References: [OpenRouter speech API](https://openrouter.ai/docs/guides/overview/multimodal/tts), [Eleven v4 Turbo model and voices](https://openrouter.ai/elevenlabs/eleven-v4-turbo), [Expo SDK 57 audio](https://docs.expo.dev/versions/v57.0.0/sdk/audio/).
