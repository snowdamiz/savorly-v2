# Localization

Savorly shares its translations across web, iOS and Android. The interface supports English, French, German, Russian, Spanish, Italian, Portuguese (Brazilian wording), Simplified Chinese and Japanese.

## Choosing a language

Open **My kitchen → Language**. This works without signing in. The default, **Use device language**, chooses the first supported language from the browser/device's ordered preferences. Regional variants such as `fr-CA`, `de-AT` and `pt-PT` retain their regional date and number formatting. If none match, the app uses English. Traditional Chinese locales are not treated as Simplified Chinese; the next supported preference, or English, is used.

An explicit selection takes priority over the system and is stored locally in AsyncStorage under `savorly.language`. It survives reloads, app restarts and sign-out on this device. Choose automatic again to follow the system. Browser language changes and returning from native settings refresh detection. Failed storage access does not block the interface; a failed write explains that the choice could not be saved.

Recipe titles, instructions, descriptions, creator names, reviews, user-written cookbook names and conversation content remain in their original language. Canonical cuisine, difficulty, dietary and meal identifiers remain unchanged in API requests and saved data. Only their displayed labels are translated. Unknown server error messages fall back to their original text; common authentication, connection, camera and voice errors have catalog entries.

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

Localization browser tests mock the API and do not need a database or paid AI provider. They verify all nine languages, catalog/placeholder parity, locale negotiation, Russian plural forms, saved overrides, live system changes, storage failures, canonical API values, preserved user content, localized dates and decimal input, and mobile layout.

Adding `expo-localization` and native locale resources requires a new native development/production build. Existing native binaries must be rebuilt; a JavaScript-only update cannot register the new native module or permission resources. No `ios/` or `android/` source folders need to be edited manually.
