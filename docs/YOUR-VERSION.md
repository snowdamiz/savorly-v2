# Your version of a recipe

Savorly remembers what each cook changed in a recipe and opens it their way next time, so a member's cookbook becomes a record of how they really cook. The more someone cooks in Savorly, the more it knows their kitchen, and that history doesn't move to another app.

Code: `services/api/internal/app/your_version.go` (changes, kitchen notes, what the sous-chef and hands-free answers hear), the sous-chef's `remember_change` and `remember_kitchen_note` in `agent.go` (with Undo in `agent_effects.go`), migration `040_your_version.sql`. App: `src/lib/yourVersion.ts` (applying changes over a recipe), `src/components/YourVersion.tsx` (the recipe page's line, the list of changes, kitchen notes), cooking mode's "Keep … for next time" in `CookMode.tsx`, and the composer's `mine` mode in `RecipeFixes.tsx`.

## What cooks see

- **Changes kept as they cook.** Told to the sous-chef ("I used half the chilli", "my oven needed 10 more minutes"), it keeps the change and shows a receipt with Undo: "Kept in your version of Tomato sauce". After a cook where a step ran clearly over its timer, "Dinner is served" offers **Keep 12 min for next time** in one tap, with Undo; otherwise **Changed something? Keep it for next time** opens the composer.
- **The composer**, **Change it for yourself**: the same one as [suggesting a fix](RECIPE-FIXES.md), for a step's time, heat or method, a note, an amount or a swap, saved only for the member. A personal version changes steps and ingredients but adds none, so its steps are the recipe's one for one and cooking mode, cook-tested numbers and the sous-chef's step numbers mean the same step.
- **Your version.** Next time, the recipe opens with the changes applied, translated or not, with **Yours** beside each changed step and ingredient and one quiet line under the title: "Your version · 2 changes · Show the original". Cooking mode and printing follow what the page shows; **Add to grocery list** adds the recipe as written.
- **Your changes** (the line's sliders button) lists each change with what the member said, to drop it, to **suggest it to the recipe's cook** as a fix (when they have a verified cook of it), or to add another.
- **Kitchen notes** in Settings → **Your cooking**: short facts that apply to every recipe ("my oven runs hot", "we like it mild"), added there or by telling the sous-chef, beside the switch that keeps a member's cooking out of [cook-tested recipes](COOK-TESTED.md).
- **Answers that know.** The sous-chef (in the chat and live) and hands-free answers hear the member's version of the recipe on screen and their kitchen notes: about 200 tokens a turn, under $0.0001 with the cheap model.

## How it works

1. **One change per part.** `recipe_edits` keeps a member's change to one step or ingredient, named by what it says now (a step by its text, an ingredient by its name, as fixes name them), with the part as it was, as they'd have it, and what they said. A second change to the same part replaces the first (and the sous-chef's Undo puts the first back).
2. **Never a copy.** The recipe itself is never copied: the app applies the changes over the recipe as it is, so the author's later edits and accepted fixes still arrive.
3. **Never applied silently.** When the author changes a step or ingredient a member changed, their change no longer fits: the recipe shows as written there, the line says "1 to look at", and **Your changes** offers **Keep my change** (on the part at its place now) or dropping it.
4. **Limits.** 40 changes a recipe and 30 kitchen notes a member; the same note is kept once.
5. **The member's own.** Nobody else sees any of it, `GET /v1/me/export` has `recipeEdits` and `kitchenNotes`, and deleting the account deletes them.

## API

- `GET /v1/recipes/:id/my-version` answers `{ "edits": [{ "id", "kind", "part", "place", "before", "after", "said", "source", "fits", "updatedAt" }] }` for someone else's published recipe (`404` otherwise). `kind` is `time`, `heat` or `note` (a `step`'s `{ "title", "text", "seconds" }`) or `amount` or `swap` (an `ingredient`'s `{ "name", "amount", "unit" }`); `place` is where its part is now when it `fits`.
- `PUT /v1/recipes/:id/my-version` takes `{ "kind", "step" | "ingredient", "change", "said", "source" }` (`source` `typed`, `cooking` or `sous_chef`) and answers `{ "edit", "replaced" }`, `replaced` being the change to that part it replaced, or `null`. It's `400` for a kind that adds a step, no change, or a recipe the editor wouldn't save, and `409` past 40 changes. 120 an hour per member.
- `PATCH /v1/recipe-edits/:id` with `{ "keep": true }` keeps a change that no longer fits on the part at its place now and answers it (`409` when the part is gone, or already has a change); `DELETE /v1/recipe-edits/:id` drops one (`204`).
- `GET /v1/me/kitchen-notes` answers `{ "notes": [{ "id", "note", "source", "createdAt" }] }`; `POST /v1/me/kitchen-notes` takes `{ "note" }` (2–200 characters; the same note again answers the one kept) and answers `201`, `409` past 30; `DELETE /v1/me/kitchen-notes/:id` answers `204`.

## Verification

`your_version_test.go` covers keeping, replacing and dropping changes, a personal version adding no steps, nobody else seeing them and the recipe staying as written, a change no longer fitting after the author's edit and being kept on the part as it is now, kitchen notes kept once and removed, hands-free answers hearing the member's version and notes (and another member's not), and the sous-chef keeping a change and a note, hearing them next turn, and both undone. `tests/your-version.spec.ts` covers the recipe opening as the member's version and the original a tap away, a change that no longer fits, keeping a step's time after a cook (and Undo), the composer's **Keep in my version**, and kitchen notes.
