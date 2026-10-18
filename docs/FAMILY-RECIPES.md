# Family recipes in their own voice

A family can turn a relative talking through a dish, or a handwritten card, into a recipe that
cooking mode plays in that person's own recorded voice. These are recipes that exist nowhere else,
so they stay private, can be shared with the household, and the recordings are kept twice and
come with the member's export.

**No voice cloning (decided October 17, 2026).** Nothing in Savorly ever speaks in a relative's
voice. A step plays only the stretch of the recording in which they said it. Where the recipe
changes (a translation, an edited step, scaled amounts), the step shows the new text and normal
[narration](COOKING-NARRATION.md) reads it, with the recorded clip still there to play.

## Using it

- **Record a family recipe** is one of the ways into **Add a recipe** (the + tab, or Create recipe
  on a desktop). The member says who is speaking ("Grandma"), records while the relative talks
  (while they cook or from memory, up to half an hour), and taps **Write it down**. A recording
  already on the device (a voice memo, a message someone sent) can be chosen instead. The sheet
  shows the upload, then "Writing it down…", and opens the recipe when it's ready, usually within
  a minute. It can be closed meanwhile: the recipe lands in My recipes.
- **Use a handwritten card** instead takes a photo of the card (or one from the library). The recipe
  is written from it, and the card becomes its cover.
- Recordings that weren't written down (AI was off, the plan's allowance was used, it failed, or
  the recipe was deleted) wait under **Not written down yet** in the same sheet, to be written down
  again (from the transcript already heard: no second transcription) or deleted for good.
- On the recipe page a voiced step has a quiet "Grandma's voice" link on its last line. In cooking
  mode the step has a play button beside read-aloud, labelled "Play Grandma's voice"; steps
  without a clip have narration only. The clip and narration never play over each other, and
  hands-free listening pauses while either plays.
- Family recipes are private. **Publishing** one asks "Did Grandma agree?": the member confirms the
  person agreed to share their voice with everyone, or keeps it private. The server refuses to
  publish a recipe with recordings nobody agreed to.
- **Share with my household** on a cookbook (Saved → the cookbook → Edit) opens it, and the
  owner's private recipes in it, to everyone in their [household](API.md#households). Others'
  shared cookbooks show in Saved, marked with the household icon. A member can now keep their own
  private recipes in a cookbook (the recipe page's Cookbook button), which is how a family
  cookbook is made.

## How it works

1. **Upload.** The app records mono AAC at 64 kb/s (`expo-audio`; WebM in browsers that record
   it), so half an hour is about 15 MB, and uploads it through the [direct upload](STORAGE.md#direct-uploads)
   path with `kind: "audio"` (M4A, WebM or MP3, up to 25 MB, what speech-to-text takes in one
   request). The bytes are checked as a recording.
2. **Keep.** `POST /recordings` copies the upload into the private source bucket
   (`recordings/<user-id>/<id>.<ext>`) and keeps a row in `recordings`
   (`037_family_recipes.sql`): who is speaking, both copies, its length, and later the transcript.
3. **Write down.** It queues an ordinary import job (`kind: "recipe"`, reserved from the
   member's sous-chef allowance and the AI budgets like any import; a job that brings no recipe
   never counts against them). The worker reads the private copy and sends it to OpenRouter's
   speech-to-text endpoint (`POST /audio/transcriptions`, `openai/whisper-large-v3` by default,
   `OPENROUTER_TRANSCRIPTION_MODEL` to change it) for timed segments, which are kept on the row.
   The agent model then writes the transcript down in the importer's recipe schema, the speaker's
   own words tidied into steps, each step naming the first and last segment that say it. The
   transcript is sent as numbered data, never as instructions.
4. **Clips.** A step's clip is a stretch of the one stored recording: `steps[].voice` is
   `{ "recording", "startMs", "endMs" }`, the segments' times widened by 300 ms either side and
   kept within the recording. The API image has no ffmpeg to cut compressed audio, and a stretch
   needs nothing cut: the player seeks to its start and stops at its end. Steps the model had to
   add have no clip.
5. **Save.** The recipe is saved as the member's private, AI-assisted recipe with no media but the
   card's photo, and the job completes with `{ "recipeId", "title" }`, settled to what OpenRouter
   reported.

A card is read the same way, by the agent model from the photo, with the photo kept as the
recipe's cover and as the job's `source`.

**Cost.** Whisper large v3 is $0.0075–$0.031 per 1,000 seconds of audio on OpenRouter (October
17, 2026), and writing a transcript down a cent or two, so a ten-minute recording comes to about
$0.01–0.03. The reservation (`ai.RecordingEstimate`) follows the recording's length; a card's
(`ai.CardEstimate`) is about a cent.

## Edits, consent and households

- Editing a family recipe keeps each step's clip the way step photos are kept: a step that doesn't
  name `voice` (older apps, the sous-chef) keeps the clip of the saved step with the same text, or
  else of the step in the same place with the same title; `voice: null` removes it. A step plays
  only its own recipe's recordings: any other `voice` is dropped, and one is fitted within the
  recording or dropped when less than a second is left.
- Publishing (`PUT /recipes/:id` with `published: true`, and the sous-chef's publish) is refused
  with `409` until `POST /recipes/:id/recording-consent { "agreed": true }` records that the
  author confirmed the people recorded agreed (`consent_by`, `consent_at`).
- A cookbook with `household: true` opens for every member of its owner's household: the
  cookbook page, and each private recipe of the owner's in it (the recipe, its narration and
  translation, cooking mode, hands-free questions, planning it and shopping for it). Sharing never
  makes anything public: a public family cookbook shows strangers only its published recipes. It
  ends when either leaves the household.

## Storage, deletion and the export

Each recording is kept twice: the copy the app plays in the public media bucket (an unguessable
upload address), and a private copy in the source bucket, which only the API reads and which
transcription prefers. The media janitor keeps the public copy while the recording exists.

- Deleting a recipe leaves its recordings to the member (they return to Not written down yet).
- `DELETE /recordings/:id` deletes the recording and both copies (a trigger queues the public copy
  for the media janitor and the private one in `source_deletions`), and takes its clips off the
  recipe's steps. Deleting the account does the same for all of them.
- The JSON export (`GET /me/export`) lists every recording with its speaker, the address of its
  audio, its type, size, length, language, transcript, recipe and consent.

## Configure

Nothing new beyond the [AI](PROVIDERS.md) and [storage](STORAGE.md) settings: family recipes need
`OPENROUTER_API_KEY` and object storage with the private source bucket. `GET /capabilities` says
`familyRecipes: true` when both are there; the app shows Record a family recipe only then.
`OPENROUTER_TRANSCRIPTION_MODEL` picks another speech-to-text model with timed segments.

The app needs no new native code: recording uses `expo-audio` (already in the app, with its
microphone permission), and choosing a recording uses `expo-file-system`'s file picker
(`audioFile.ts`; the web uses the browser's file chooser, `audioFile.web.ts`).

## Verification

`services/api/internal/ai/family_test.go` covers the transcription and write-down requests against
a local mock. `services/api/internal/app/family_test.go`, against an isolated database and an
in-memory object store, uploads a recording, keeps both copies, writes it down into a private
recipe with clips, keeps clips through edits, refuses publishing without consent, writes it down
again without a second transcription, lists it in the export, deletes both copies, reads a card
into a recipe with the card as its cover, and shares a cookbook with a household. The app's unit
tests cover a step's clip, consent, waiting for the recipe, the web clip player and recording
uploads; `apps/mobile/tests/family-recipes.spec.ts` records with the browser's fake microphone,
cooks with the clip, publishes with consent and shares a cookbook, at desktop and phone width.
Native recording and playback need checking on a device.
