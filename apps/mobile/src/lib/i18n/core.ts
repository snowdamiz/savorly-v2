export const languages = [
  { code: 'en', name: 'English', locale: 'en-US' },
  { code: 'fr', name: 'Français', locale: 'fr-FR' },
  { code: 'de', name: 'Deutsch', locale: 'de-DE' },
  { code: 'ru', name: 'Русский', locale: 'ru-RU' },
  { code: 'es', name: 'Español', locale: 'es-ES' },
  { code: 'it', name: 'Italiano', locale: 'it-IT' },
  { code: 'pt', name: 'Português', locale: 'pt-BR' },
  { code: 'zh', name: '简体中文', locale: 'zh-CN' },
  { code: 'ja', name: '日本語', locale: 'ja-JP' },
] as const;
export type Language = (typeof languages)[number]['code'];
export type LanguagePreference = Language | 'system';
export type Messages = Record<string, string>;
export type Variables = Record<string, string | number>;
export const LANGUAGE_STORAGE_KEY = 'savorly.language';
export function isLanguage(value: unknown): value is Language {
  return languages.some((language) => language.code === value);
}
export function resolveLocale(preference: LanguagePreference, preferred: readonly string[]) {
  const normalized = preferred.flatMap((tag) => {
    try {
      return [Intl.getCanonicalLocales(tag.replace(/_/g, '-'))[0]];
    } catch {
      return [];
    }
  });
  for (const locale of normalized) {
    const base = locale.split('-')[0];
    // This catalog uses simplified Chinese; traditional locales do not silently get mislabeled.
    if (base === 'zh' && /-(Hant|TW|HK|MO)(-|$)/i.test(locale)) continue;
    if (isLanguage(base) && (preference === 'system' || preference === base)) {
      return { language: base, locale };
    }
  }
  const language = preference === 'system' ? 'en' : preference;
  return { language, locale: languages.find((item) => item.code === language)!.locale };
}
export function translator(
  language: Language,
  locale: string,
  messages: Messages,
  english: Messages,
) {
  // API messages and custom tags can be arbitrary strings, including object property names.
  const translations = new Map(Object.entries(messages));
  const fallback = new Map(Object.entries(english));
  const plural = new Intl.PluralRules(language);
  const numbers = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  return (key: string, variables: Variables = {}) => {
    const category = typeof variables.count === 'number' ? plural.select(variables.count) : '';
    const template =
      (category && translations.get(`${key}_${category}`)) ||
      translations.get(key) ||
      (category && fallback.get(`${key}_${category}`)) ||
      fallback.get(key) ||
      key;
    return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
      const value = variables[name];
      return value === undefined
        ? match
        : typeof value === 'number'
          ? numbers.format(value)
          : value;
    });
  };
}
