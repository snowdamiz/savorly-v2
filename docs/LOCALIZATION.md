# Localization

Savorly shares its translations across web, iOS and Android. The interface supports English, French, German, Russian, Spanish, Italian, Portuguese (Brazilian wording), Simplified Chinese and Japanese.

## Choosing a language

Open **My kitchen → Language**. This works without signing in. The default, **Use device language**, chooses the first supported language from the browser/device's ordered preferences. Regional variants such as `fr-CA`, `de-AT` and `pt-PT` retain their regional date and number formatting. If none match, the app uses English. Traditional Chinese locales are not treated as Simplified Chinese; the next supported preference, or English, is used.

An explicit selection takes priority over the system and is stored locally in AsyncStorage under `savorly.language`. It survives reloads, app restarts and sign-out on this device. Choose automatic again to follow the system. Browser language changes and returning from native settings refresh detection. Failed storage access does not block the interface; a failed write explains that the choice could not be saved.

Recipes show as written, with an offer to read them in the app's language ([below](#recipes-in-your-language)). Creator names, reviews, comments, user-written cookbook names and conversation content remain in their original language. Canonical cuisine, difficulty, dietary and meal identifiers remain unchanged in API requests and saved data. Only their displayed labels are translated. Unknown server error messages fall back to their original text; common authentication, connection, camera and voice errors have catalog entries.

## Recipes in your language

A recipe whose `language` is one of the nine and differs from the app's shows a calm bar under its description: "Written in French", and **Translate**. One tap shows its title, description, ingredient names, steps and listed equipment in the app's language, with "Translated from French by AI" and **Show original**; cooking mode then shows the translated steps under "Translated by AI", and reads them aloud in the app's language ([cooking narration](COOKING-NARRATION.md#translated-recipes)). Amounts, units, timers, step photos and clips, tags and cuisine stay the recipe's own, so servings, metric/imperial conversion and timers work as before, and the ingredient checklist keeps its checks across both. Once a translation shows, **Always translate recipes** opens every such recipe translated; it is saved with a signed-in cook (`preferences.translateRecipes`, so it follows them to other devices) and lasts the visit for a guest. Recipes without a language, or in the app's, show no bar.

The API translates a recipe into each language once, with AI, and keeps it for every later reader (`GET /recipes/:id/translation`, [API](API.md#recipe-translations)); editing the recipe's text has it translated again for the next reader. Starting a translation needs a signed-in member; a guest reads the ones members started and is otherwise asked to sign in. A failed translation says so under the bar with **Try again**, and is never asked for again on its own. The app keeps the translations of the last 30 recipes read translated (`savorly.offline.translations` in AsyncStorage, localStorage on the web; published recipes only), so a recipe kept for cooking offline still reads translated without a connection, and a kept translation shows at once while the API is asked. Comments, reviews and cook notes aren't translated yet.

`src/lib/translation.ts` has the pure parts (which recipes are offered a translation, laying one over a recipe, the device's copies), `src/lib/useRecipeTranslation.ts` the page's state and the preference, and `src/components/TranslationBar.tsx` the bar. Language names in the bar are whole sentences per source language ("Written in French", "Translated from French by AI"), because a language's name changes with the sentence around it in several of the app's languages.

## Maintaining translations

- `apps/mobile/src/lib/i18n/core.ts` defines supported languages, locale matching, interpolation and plural selection.
- `apps/mobile/src/lib/i18n/index.tsx` owns detection, persistence and the React context. The app waits for preference restoration before rendering its interface.
- `apps/mobile/src/lib/i18n/locales/*.json` contains the message catalogs. Each catalog has the same keys. Most keys are English source strings; plural messages use a shared key with `_one`, `_few`, `_many`, `_other` variants selected by `Intl.PluralRules`.
- Use `useI18n().t` for UI messages, preserving every `{{variable}}` in each translation. Interpolate complete messages rather than translating sentence fragments. Pass original user content only as interpolation values, not as keys.
- Use the selected `locale` for dates and `number` for numeric displays. Ingredient amount fields accept either decimal commas or dots and still submit JSON numbers. ISO date input and API date values remain `YYYY-MM-DD`.
- Add new languages to the language registry, provider imports, all catalogs, the Expo localization plugin's `supportedLocales`, and `apps/mobile/locales/` for iOS permission prompts.

The native permission descriptions follow the operating system's app language. Android permission dialogs are system-provided. The in-app language override controls Savorly's interface; it does not change the OS language.

## Verification

Run Expo on port 8081, then:

```sh
npm --prefix apps/mobile run test:e2e -- localization.spec.ts
npm run typecheck
npm --prefix apps/mobile run lint
npm run build
```

Localization browser tests mock the API and do not need a database or paid AI provider. They verify all nine languages, catalog/placeholder parity, locale negotiation, Russian plural forms, saved overrides, live system changes, storage failures, canonical API values, preserved user content, localized dates and decimal input, and mobile layout. `recipe-translation.spec.ts` covers the translation bar, translated cooking mode and read-aloud, "Always translate recipes", guests, failures and the device's copies offline; `src/lib/__tests__/translation.test.ts` the pure parts; the Go tests (`internal/ai/translate_test.go`, `internal/app/translations_test.go`) the prompt contract, validation, caching, staleness, visibility, budgets and the janitor against a mock provider.

Adding `expo-localization` and native locale resources requires a new native development/production build. Existing native binaries must be rebuilt; a JavaScript-only update cannot register the new native module or permission resources. No `ios/` or `android/` source folders need to be edited manually.
