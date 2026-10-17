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
- With [hands-free cooking](HANDS-FREE.md) on, a step reached by a spoken "next step" or "previous step" is read the same way, and listening pauses while it plays, so the recognizer never hears the narration.
- The mobile screen retains a small window of prepared players for the current cooking session. Separately, the recordings of the last recipes read aloud stay on the device for cooking without a connection (below).

## Offline

A kitchen with poor reception keeps its narration: the app keeps the cloud recording of each step it plays, and cooking mode plays that copy when the API can't be reached, in the same voice, rather than device speech (`apps/mobile/src/lib/narration/cache.ts`).

- **What is kept, and where.** When a step starts playing from the cloud, the app downloads the same recording (`GET …/narration/:key`, with the bearer token on phones and the session cookie on the web) and keeps it: a file per recording in the app's cache directory on iOS and Android (`narration/<key>.mp3`, `audioStore.ts`), and Cache Storage (`savorly-narration`) in browsers (`audioStore.web.ts`). The list of copies is in AsyncStorage (`savorly.offline.narration`; localStorage on the web).
- **Keys.** A copy is kept under the API's own key for the recording, which covers the recipe, the step, its exact text, the voice, the model and the format, and notes the signed-in cook, the recipe's language and the step's text. It plays only for the same cook, recipe, language, step and text, so an edited step or a recipe moved to another language never plays an old recording. When the API names a different key for a step whose text hasn't changed, the server's voice (or model) has changed: every copy kept before is dropped, so an old voice doesn't play either. An edited step's earlier recording is dropped too.
- **Limits.** The copies of the last three recipes read aloud (playing a copy counts), and 15 MB in all; the oldest go first. The system may clear the cache directory to make room; the app then forgets those copies.
- **Playback.** Online, a step plays from the cloud exactly as before. When the narration request can't reach the API (no connection, a timeout, or a 502–504), when the cloud's audio fails, or when it hasn't started after 12 seconds, the device's copy plays instead: the copy of the same recording once the API has named it, otherwise the newest copy of the step as it reads now. The copy has the same controls (Stop, Next, Previous, replay) and the next step is prepared from its own copy, as it would be from the cloud. Only without a copy does device speech read the step. After a launch without a connection, steps go straight to the copies without waiting on the network. A step the API turns down (a changed recipe, a step too long) still goes to device speech.
- **Accounting.** Every online play still sends `POST …/narration` and streams `GET …/narration/:key`, so generation, spending reservations, plan limits and the recording's last use (by which the janitor purges recordings after 60 days) work as before. Keeping a copy is one more `GET` of a recording that has already played; a `GET` never starts a generation. The app doesn't play its copy in place of the stream while online: without that `GET`, a recording the cook keeps cooking from could expire on the server and be generated, and counted against the plan, again.
- **Signing out** removes every copy along with the rest of the kitchen's data (`forgetKitchen` in `offline.ts`), since they can be of the cook's own drafts; so does the session ending without it (a `401`, deleting the account, or a launch that finds no session). Copies also play only for the cook they were kept for.

## Translated recipes

A cook reading a recipe [translated](LOCALIZATION.md#recipes-in-your-language) cooks it translated, and hears it in their language. The app sends the translated step with the translation's language (`POST …/narration` with `{ "text", "language" }`); the server reads that step from the recipe's saved translation, never from the client, and refuses text that isn't it (`409`, for instance after the recipe was edited and before it is translated again), so device speech reads the step instead. The audio path carries the language (`…/narration/:key?language=fr`), and the recording is cached like any other, under a key of its exact text, so the original and each translation have recordings of their own. ElevenLabs v4 Turbo reads the language of the text it is given. Device speech reads a translated step in the app's language rather than the recipe's. On the device, a kept recording notes the language it was read in, so the recordings of the original and of a translation are kept side by side and each plays only for its own text. Older apps send no language and hear the recipe as written.

## Authentication, caching, and limits

`POST /v1/recipes/:id/steps/:step/narration` requires a signed-in user and checks recipe visibility. Its text must exactly match the saved step; arbitrary client text is never synthesized. It returns an authenticated streaming path. `GET` independently checks visibility and the current instruction hash and never starts a paid generation. Web audio sends HttpOnly cookies; native audio sends its existing bearer token.

Complete recordings are listed in PostgreSQL `recipe_narrations`, keyed by recipe, step, exact text, voice, model, and format, and their audio is kept in the private `savorly-sources` bucket (`narration/`, one object per recording; without object storage, and for rows from before that layout, the audio stays in Postgres). A recording unused for 60 days is removed ([storage](STORAGE.md#private-bucket)). Replays and concurrent requests reuse audio. PostgreSQL locks prevent duplicate generation across replicas. A GET routed to a different replica waits for the shared cache; keeping both requests on the same replica enables first-chunk streaming. Deleted recipes cascade-delete their audio. Failed or incomplete recordings are not cached. The OpenRouter model ID and output format produce a new cache key, so old direct-provider recordings are not reused accidentally.

Narration reservations participate in `AI_DAILY_BUDGET_USD`, estimating the regular v4 Turbo rate of **$40 per million characters**. OpenRouter's launch price is $20 per million characters through October 19, 2026; that temporary discount is deliberately excluded from reservations. Provider billing and spending caps remain authoritative. Each member's plan also limits new read-aloud generations (see [pricing](PRICING.md)); there is a 4,000-character step limit, four active generations per API process, a 25-second generation deadline, and an 8 MiB recording limit. Prefetches count as generations. Failed attempts retain their conservative spend reservation and have a short retry cooldown.

## Verification

Provider tests use a local HTTP server to cover OpenRouter authentication and payloads, first-chunk streaming, final MP3 bytes, error statuses, non-audio bodies, empty/truncated/oversized streams, cancellation, and multiple listeners. Configuration tests confirm that only the OpenRouter key enables narration. Database tests use isolated schemas to cover visibility, stale instructions, shared caching across replicas, spending limits, and byte ranges. Browser/controller tests cover real audio playback, prefetching, cancellation, replay, fallback, and autoplay rejection. Unit tests cover the device's copies (keys, the recipe and size limits, signing out, and the file and Cache Storage twins) and the controller playing them offline; a browser test reads a step online, then cooks the recipe with the API out of reach, mid-session and after an offline launch, and hears the kept recording rather than device speech; another signs out and finds the copies gone. These tests do not call OpenRouter or ElevenLabs or spend credits.

Real voice quality, account access, and device/network latency must be checked after a real API key is supplied. Native iOS/Android playback requires device validation.

References: [OpenRouter speech API](https://openrouter.ai/docs/guides/overview/multimodal/tts), [Eleven v4 Turbo model and voices](https://openrouter.ai/elevenlabs/eleven-v4-turbo), [Expo SDK 57 audio](https://docs.expo.dev/versions/v57.0.0/sdk/audio/).
