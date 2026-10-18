# Recipe fixes from cooks

Cooks who made a recipe can suggest a fix, and its author accepts it with one tap, so recipes get better the way open-source code does. [Cook-tested recipes](COOK-TESTED.md) find where a recipe goes wrong; fixes solve it; the next cooks' numbers show whether the fix worked.

Code: `services/api/internal/app/recipe_fixes.go` (suggestions, votes, answers, versions and undo), the sous-chef's `suggest_fix` in `agent.go`, migration `039_recipe_fixes.sql`. App: `src/lib/recipeFixes.ts`, `src/components/RecipeFixes.tsx` (the recipe page's list, the composer, the author's review, the history), cooking mode's prompt in `CookMode.tsx` and the timing in `src/lib/cookSessions.ts`.

## What cooks see

- **After a cook**, only when something went off: a verified cook whose step took clearly longer than its timer (2 minutes and a quarter of the timer, as cook-tested notes count it, timed on the device) reads "Step 2 took you 12 minutes, not 8. Suggest a change" on "Dinner is served". It opens the composer with the step, the minutes and "It took me 12 minutes, not 8." filled in.
- **Suggest a change** under the recipe's method, for members with a [verified cook](CREATOR-FUND.md#verified-cooks) of it. The composer asks what should change (a step's time, heat or method, a note, a missing step, an amount, or a swap that worked), which step or ingredient, the change, and what happened. Only what another cook can check: taste stays a comment.
- **Suggested by cooks**, under the method: each suggestion a row that says what it changes ("Step 2: 12 min instead of 8", "Lemon: Lemon or lime") and how many cooks agree, opening to the change, why, and who suggested it. Other verified cooks can say **Same for me**; the cook who suggested it can withdraw it.
- **Improved by 3 cooks** beside the recipe's cook-tested line once its author accepted fixes, opening how cooks improved it: each accepted fix, newest first, crediting its cook.
- **The sous-chef** can suggest a fix too (`suggest_fix`), from what the cook tells it, and asks first like other changes made in the member's name.

## What authors see

**Where cooks get stuck** (with the number of suggestions waiting) puts each suggestion under the step it changes, beside that step's cook-tested numbers, and ingredients, new steps and anything that no longer fits in a card first. Each shows the step or ingredient as it is and as suggested, why, who suggested it and how many agree. The author can **Accept** it, edit it first (the pencil), or decline it with a reason (the cross). Accepting saves the recipe as the editor does: its allergens, food index and equipment are read again, its translations are made again the next time they're read, and since a step is known by its text, an edited step starts its cook-tested numbers afresh. Each step keeps its photo and clip.

**How cooks improved it** lists the accepted fixes, and the author can undo the latest one while nothing else changed the recipe since; after that, the editor is the way.

## Rules

- **From verified cooks only**, never the recipe's author, and only on published recipes by authors in good standing. One suggestion waits per cook and part of a recipe (a step, the place a missing step goes, or an ingredient), and a cook may suggest 20 an hour.
- **A part is known by what it says**: a step by its text (the same key as [cook-tested](COOK-TESTED.md) numbers), an ingredient by its name, a missing step by the step it follows. When the recipe changed there since, the suggestion still shows but no longer fits: its author can only decline it.
- **What it leaves must be a recipe the editor would save** (titles, step text of 5 to 3,000 characters, timers up to a day, amounts and units), and it must change something.
- **Moderated like comments.** Suspended cooks' suggestions and votes leave the recipe, the author declines what doesn't belong, and admins remove a suggestion with `DELETE /v1/admin/suggestions/:id` (audited, under the same rank rule as comments).
- **Authors who never answer.** A suggestion waiting 30 days becomes a note: it still shows ("A note from Maya"), and the author can still accept it. Declined and withdrawn suggestions go a year after their answer.
- **The member's data.** `GET /v1/me/export` has the member's `recipeSuggestions`, and deleting the account deletes them and their votes.

Not yet: telling the author when a suggestion arrives, and the cook when theirs is accepted (each a notification kind of its own), and any creator-fund bonus for an accepted fix.

## Verification

`recipe_fixes_test.go` covers who may suggest and agree (verified cooks, never the author or a stranger), the checks on a suggestion, one waiting per cook and part, suspended cooks leaving, withdrawing, accepting as suggested and edited (a step's text and timer, a new step that keeps the other steps' photos, an amount), the credit on the recipe and its history, undoing the latest change only while nothing changed since, a suggestion for a changed step no longer fitting and being declined with a reason, unanswered suggestions becoming notes after 30 days and still accepted, and the sous-chef's suggestion waiting for a yes. `tests/recipe-fixes.spec.ts` covers the recipe page's list, "Same for me", the composer, the credit, the prompt after a step ran long, and the author's accept.
