# Hands-free cooking

Cooking is when voice matters most (wet hands, a knife in one of them), and it is also the longest
voice session a cook has. The sous-chef's live voice costs $0.05 for every connected minute,
silence included, so a plan's 2–40 voice minutes would not last a single cook. Hands-free cooking
is the cheap path: the phone (or browser) listens for short commands and does them itself, for
free, and only a question that starts with the wake word ("Chef, …") reaches the server, as text,
for a short answer that costs a fraction of a cent. It can stay on for a whole cook. The live
sous-chef is still one tap away (the sparkle button) for a real conversation.

## Using it

Cooking mode has a **Hands-free** switch under its header, with a hint of what to say. The first
time, it explains the commands, what a question costs, and where speech is recognized, then
**Start listening** asks for the microphone (and, on iPhones, speech recognition). While it's on,
the switch shows a red dot and **Listening** for as long as the microphone is in use (the dot
pulses, unless the system asks for reduced motion), or why it paused. The **ⓘ** button beside it
brings the explanation back. A recognized command gives a light haptic tap and shows what was
heard with a check; a question shows the question and the answer, which is also read aloud.

| Say                                                   | Does                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| “next step”, “next”, “continue”                       | Next step, and reads it aloud (on the last step, finishes)        |
| “previous step”, “back”                               | Previous step, and reads it aloud                                 |
| “repeat”, “read the step”                             | Reads this step aloud                                             |
| “start the timer” · “pause the timer” · “resume the timer” | The step's timer, confirmed aloud (“Timer started.”)        |
| “stop”, “stop reading”                                | Stops reading and drops a question still waiting for its answer   |
| “ingredients” · “ingredients for this step”           | Reads the recipe's ingredients, or the ones this step names       |
| “done”, “finished”                                    | Done with this step: the Next button's job                        |
| “Chef, how long do I boil it?”                        | Asks the sous-chef; the answer is shown and read aloud            |
| “Chef” (alone)                                        | Answers “Yes?” and takes the next thing said as the question      |

Each of the nine languages has its own phrases and wake word, in the app's language (the
recognizer listens in it, and answers are spoken in it):

| Language   | Next step         | Timer                    | Question          |
| ---------- | ----------------- | ------------------------ | ----------------- |
| English    | next step         | start the timer          | Chef, …           |
| Deutsch    | nächster Schritt  | Timer starten            | Chef, …           |
| Español    | siguiente paso    | inicia el temporizador   | Chef, …           |
| Français   | étape suivante    | lance le minuteur        | Chef, …           |
| Italiano   | passo successivo  | avvia il timer           | Chef, …           |
| Português  | próximo passo     | iniciar o temporizador   | Chef, … / Chefe, … |
| Русский    | следующий шаг     | запусти таймер           | Шеф, …            |
| 日本語     | 次へ              | タイマー開始             | シェフ、…         |
| 简体中文   | 下一步            | 开始计时                 | 厨师，… / 大厨，… |

The full grammar is `apps/mobile/src/lib/handsFree/grammar.ts`. A command is a whole short
utterance, never words inside a longer sentence, so kitchen talk ("I'll do the next step after
this") moves nothing. Matching forgives what recognizers vary on: case, accents, punctuation,
apostrophes, spacing in Japanese and Chinese, and polite words at either end ("next step, please",
"请下一步", "次へ進んでください"). "Chef, next step" is still a free command. Ingredients are read in
the recipe's language after a sentence in the app's.

## Questions and what they cost

A question is `POST /v1/recipes/:id/ask` with `{ "question", "step", "language" }` ([API](API.md#hands-free-cooking)).
The server reads the recipe as the member may see it (published by a cook in good standing, or
their own) and asks GPT-6 Luna (`OPENROUTER_AGENT_MODEL`, low reasoning, at most 300 output
tokens) for one to three short spoken sentences from the recipe and the cook's step. The call has
no tools: it can't move a step, start a timer or change anything, and it is told never to claim it
did, to treat the recipe and the question as data rather than instructions, to give safe internal
temperatures where doneness matters, and never to guarantee allergy safety.

Each question is metered like the sous-chef's other small calls: it reserves its cost against the
member's spend ceiling and the day's budgets (`reserveGeneration`), counting every byte of its
prompt as a token at the fast tier's price (about $0.001 for a typical recipe, at most about
$0.005), records it in the `ai_usage` ledger as `cook_question`, and settles it to the cost
OpenRouter reports, typically $0.0002–0.0005. A failed provider call keeps its reservation, since
it may have been billed. Plans include 30 (Free), 100 (Plus) and 150 (Pro) questions per rolling
30 days ([pricing](PRICING.md)); the plan card shows them as **Cooking questions**. When paid plans
are off (`PAID_PLANS` unset) questions are unlimited, bounded only by the daily budgets. Commands
never touch the server, so they keep working signed out, offline, without an OpenRouter key, or
with the allowance used up; the "Chef" questions then say why, politely, and that commands still
work. `/v1/capabilities` reports `cookingQuestions` (true when OpenRouter is configured).

## Privacy and platforms

Only the words of a "Chef" question leave the device for Savorly, as text; commands and everything
else said in the kitchen don't. Recognition itself happens where the platform does it, and the
explainer says which:

- **iOS** (Apple's Speech framework through `expo-speech-recognition`): on the device whenever the
  iPhone supports it for the language, so audio stays on the phone; otherwise Apple's speech
  service recognizes it.
- **Android** (`SpeechRecognizer`): on the device when the language's on-device model is installed
  (Android 13+); otherwise Google's speech service. Android 13 and later keep one continuous
  session; older versions end a session per phrase (with the system's beep) and the app starts the
  next.
- **Web** (the Web Speech API, `recognizer.web.ts`): Chrome sends audio to Google and Safari to
  Apple. Newer Chrome can recognize some languages on the device (`processLocally`), which the app
  uses when the language is already installed. Firefox and Brave have no recognition; the switch
  then says so, and the steps work by tapping as before.

Listening is continuous: when a platform ends a session (after a silence, a minute, or a phrase)
the next one starts at once, backing off when sessions keep ending immediately or failing, and
giving up with a message after five failures in a row (`listener.ts`). It never hears itself:
recognition stops while the app speaks (answers, confirmations) and while a step is read aloud,
and resumes 0.4 s after. That also means "stop" can't interrupt a reading; the speaker button can.
It also pauses while the app is in the background and while a live sous-chef call has the
microphone, and stops when cooking mode closes, cooking is finished, or the switch is turned off.
A denied permission says how to allow it (with **Open settings** once the phone won't ask again).

## Native build

This adds a native module (`expo-speech-recognition` 57.x, with its config plugin in `app.json`:
the speech-recognition and microphone permission strings, and Android package visibility for the
Google speech services) and new permission strings in `apps/mobile/locales/*.json`
(`NSSpeechRecognitionUsageDescription`, and a microphone string that now mentions hands-free
cooking). The app's fingerprint changes, so the next push to `staging` or `release` queues an EAS
build ([updates](UPDATES.md)). A build without the module (older binaries) reports that
recognition is unavailable instead of crashing; the web app needs nothing new.

## Verification

Unit tests cover the grammar in all nine languages (every phrase, recognizer variations, talk that
must not match, the wake word before a question, alone, and before a command), the listener's
state machine with a fake recognizer (restarts, back-off, holds, permission and error handling),
both recognizer twins against fake native and browser APIs, and the ingredient matching. Go tests
use a mock OpenRouter for the answer contract, recipe visibility, the plan allowance (including
concurrent questions), the spend ceiling and daily budget, failures keeping their reservation,
and settlement; `pricing_test.go` includes questions in every plan's worst case. A browser test
(`tests/hands-free.spec.ts`) scripts `webkitSpeechRecognition` and speech synthesis: saying "next
step" moves and reads the step, kitchen talk is ignored, "start the timer" starts it, and "Chef,
how long do I boil it?" calls `/ask` and shows and speaks the answer.

Not verified: real recognizers on iPhones, Android phones and Safari, their accuracy for each
language's phrases in a noisy kitchen, native audio routing between recognition, read-alouds and
device speech, and real answer quality and cost, which need a device build and an OpenRouter key.
