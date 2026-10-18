# Switching to Savorly

People ask whether an app will keep their recipes: Yummly closed in December 2024, and Mealime closes on October 21, 2026 and deletes its members' data. So Savorly makes switching safe both ways. Members bring many recipes at once (the page for Mealime's members, several links from Add a recipe, a creator's own site), and every member can take everything out again as files they can open without Savorly.

Code: `services/api/internal/app/import_batches.go` (bulk imports, the import loop, similar recipes), `import_pasted.go` (recipes pasted as text), `export_files.go` (the export as files), migration `035_import_batches.sql`. App: `src/lib/imports.ts`, `src/components/ImportProgress.tsx`, `src/screens/Switching.tsx` (the Mealime and own-site pages), `src/components/RecipeStart.tsx` (Add a recipe), `src/components/DataExport.tsx` and `src/lib/dataExport.ts` / `.web.ts`, `src/lib/textFile.ts` / `.web.ts` (choosing a file on the web). The routes are in [API.md](API.md#bulk-imports).

## The page for Mealime's members

The page is at `/?page=mealime`, the address to share with Mealime's members; Add a recipe → Import from a link links to it too ("Many at once: From Mealime"). Mealime's closing page (mealime.com/closing, read on October 17, 2026) says the app closes on October 21, 2026, deletes all personal data then, and moves Mealime's own recipes to Albertsons' Meals Hub; it offers no export. So Savorly takes what members can copy out of the app themselves:

- **Recipes they saved from other sites**, as links. Each is read from its original page, like a single import, and credits it (`sourceUrl`, shown on the recipe page as "From blog.example").
- **Recipes they wrote**, pasted as text. Text laid out the usual way (a title, an Ingredients line, a Method line, in any of the app's languages) is read for free; anything else goes to the recipe model, told the text is data. These credit no source.
- **Mealime's own recipes** belong to Mealime, so a link to `mealime.com` is refused at once and never fetched. Its row names the recipe from its address ("Lemony chicken orzo") with a search button, and the page has a search box for any Mealime recipe's name: both open Savorly recipes like it (`POST /imports/similar`, the ordinary search, no AI).

The page reads as one path: what comes over and what doesn't, one box to paste into (or, on the web, a file to upload), then each batch's progress. A visitor without a kitchen sees the same explanation and the similar-recipe search, with **Create my free kitchen** in place of the box, and a phone's first-launch welcome doesn't cover the page.

What the box takes (`readPaste` in `lib/imports.ts`): parts between lines of dashes (`---`) are read one at a time; a part that is a list of links (with headings between them) gives its links, and any other part is a recipe the member wrote, or several, cut at each recipe's Ingredients line (with the title above it). A line or two without a link is a note and is left out. An uploaded file (2 MB at most) is added to the box: a bookmarks, spreadsheet or JSON file brings just its links, and notes come as they are. The phones have no file picker without a new native build, so there members paste. Long lists go 50 at a time, of which at most 10 recipes, in as many batches as the server takes (three unfinished at once); whatever it refuses stays in the box with its reason.

Each batch shows a line of how far it has got and a row for each link or recipe: waiting, being read, a private draft (the row opens it), or why it brought nothing. Members can leave the page: the server keeps reading, the drafts land in My kitchen as they arrive, and the page shows the latest batches when it's opened again. **Stop** leaves what still waits unread.

## Several links from Add a recipe

Pasting two or more links into Add a recipe → Import from a link changes its button to **Import N recipes**, which sends them as one batch (`purpose: "links"`) rather than opening the editor; the sheet shows the batch's progress, and each finished row opens its draft.

## A creator's own site

Founding creators are offered an import of the recipes they already published (`/?page=own-site`, also My kitchen → **Import from my site**, and Add a recipe → "From your own site"). The creator pastes the links of their recipe pages: one site at a time (`www.` aside), so links on other sites wait in the box for their own import. Before importing they tick the permission statement, shown in their language: the recipes are their own, published on their own site (named), and Savorly may import them into their kitchen, each linking back to its page. The batch keeps the English statement naming the site, and when they agreed; it stays as long as the account does (the janitor leaves own-site batches alone) and is in their data export (`imports[].permission`).

Their recipes come in like any import, with two differences. The page's recipe photo (the recipe data's `image`, else `og:image`) is copied into the creator's own storage, since they confirmed it's theirs; an ordinary import keeps only photos a recipe may show from where they are, which in production leaves out the page's own site. And every recipe links back to its page through `sourceUrl`, which the recipe page shows ("From cook.example", opening the page) and printing credits. The drafts stay private until the creator checks and publishes them; while the creator fund is on, the page says that every verified cook of a published recipe earns them a share. Step photos aren't copied.

## How the server reads a batch

`POST /imports` checks the batch at once (links that are addresses, own-site rules, sizes) and keeps it: at most 50 items, 10 of them pasted recipes of up to 12,000 characters, three unfinished batches per member, 200 items a day and 10 batches an hour. The worker's import loop (`runImports`, woken by `NOTIFY imports` on `savorly_work` and every 30 seconds while idle) reads them:

- **One link of a batch at a time**, so no site gets every link at once, and **batches take turns**: each claim takes the waiting batch read longest ago (`read_at`, a new batch first), up to four batches at once in a process; the batch's row lock keeps two replicas from reading one batch at once.
- **Each item goes through the link importer** (`POST /recipes/import`'s, video and photo posts included) with 30 seconds to read. Recipe data, or pasted text laid out as a recipe, is saved as a private draft at once. Anything else becomes an ordinary `recipe` job keyed `import-batch-<batch>-<n>`, under the member's allowances like a single import, and is saved when the job finishes (finishing wakes the loop). Without text AI those items fail instead, saying so (for pasted text, how to lay it out to be read).
- **A reader that stopped without a word** (a server going down mid-read) leaves its item `reading`; after two minutes it goes back in line, and after three tries it fails.
- **An item that brings no recipe never counts against the member**: an item that fails before a job reserves nothing, a job whose model found no recipe is released by `failImport`, and `releaseImportJob` releases one the stalled-job sweep failed, or whose recipe couldn't be saved. What the model may have cost moves to the shared `ai_usage` ledger (`unread_import`), so the day's budgets still see it.
- A batch's jobs stay out of `GET /ai/jobs` (the sous-chef history): their recipes are saved drafts already.

Finished batches other than own-site ones are deleted after 90 days (`janitor.go`); an item keeps its draft's id while the draft exists. Deleting the account deletes its batches.

## The export as files

My kitchen → **Download my data** offers **Download as files** beside the JSON file. It's one ZIP (`GET /me/export/files`, or a single-use link from `POST /me/export-link` with `{ "format": "files" }`, which the apps and the web both open so the browser saves it itself), written while it downloads and never held whole in memory:

- `savorly-export.json`: the JSON export as it is (everything the account holds), indented.
- `recipes/001-lemon-pasta/`: a folder for each of the member's recipes, drafts included, with `recipe.md` (title, photo, facts, source, ingredients, equipment, method with timers, to read or print), `recipe.json`, and the cover, gallery photos, video, step photos and step clips copied from storage.
- `cookbooks.md` (each cookbook with the recipes saved in it), and CSV files in UTF-8 for cookbooks, saved recipes, the meal plan, the grocery list, the pantry, reviews, review replies, comments, "I cooked this" notes, cooking sessions, cooks followed, and creator earnings and payouts; a list with nothing in it has no file.
- `cooked-photos/` and `profile-photo.jpg`, and `README.txt`, saying what each file is and listing every file not included, with its address: one kept somewhere other than the member's storage, or one storage couldn't give.

Only the member's own files are copied (`MediaStore.Own`). A member downloads one archive at a time (`429` meanwhile, leaving a link unspent), a process writes four at once (`503` past that), each for at most two hours; each write moves the connection's deadline on, so a large download continues while data flows. A new key in the JSON export is in `savorly-export.json` at once; a line in `exportTables` gives it a CSV file, and one in `exportFolders` a folder of the files it names (family recordings, when they're merged).

## Tests

`import_batches_test.go` covers a Mealime batch end to end (recipe data, laid-out text, the model, refusals, Mealime's links never fetched, what counts, the history, scoping, the export), batches without the model, every limit and refusal, stopping and recovery, batches taking turns, released jobs, an own site's photos, permission, retention and deletion, similar recipes, pasted text in several languages, and the loop waking for new batches. `export_files_test.go` unzips the archive (photos copied, the README's list, the Markdown, CSV files, cookbooks), the single-use link, one download at a time, storage missing, and a download over a real connection. In the app, `src/lib/__tests__/imports.test.ts` covers reading what's pasted, batches and Mealime's links, and `tests/switching.spec.ts` the two pages, Add a recipe's links and the download, saving screenshots at desktop and phone width under `test-results/switching/`.
