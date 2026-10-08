import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActivityIndicator, AppState, Platform, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales, useLocales } from 'expo-localization';
import {
  isLanguage,
  LANGUAGE_STORAGE_KEY,
  LanguagePreference,
  resolveLocale,
  translator,
} from './core';
import en from './locales/en.json';
import fr from './locales/fr.json';
import de from './locales/de.json';
import ru from './locales/ru.json';
import es from './locales/es.json';
import it from './locales/it.json';
import pt from './locales/pt.json';
import zh from './locales/zh.json';
import ja from './locales/ja.json';
export { languages } from './core';
export type { Language, LanguagePreference } from './core';
const catalogs = { en, fr, de, ru, es, it, pt, zh, ja };
function useLanguageState() {
  // Subscribe to live changes, and reread when returning from Android settings.
  useLocales();
  const [, setForegroundVersion] = useState(0);
  const foregroundLocales = getLocales();
  const [preference, setPreference] = useState<LanguagePreference>('system');
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const writes = useRef(Promise.resolve());
  const version = useRef(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') setForegroundVersion((value) => value + 1);
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(LANGUAGE_STORAGE_KEY)
      .then((saved) => {
        if (active && isLanguage(saved)) setPreference(saved);
      })
      .catch(() => {
        if (active) setStorageError(true);
      })
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);
  const setLanguage = useCallback((next: LanguagePreference) => {
    setPreference(next);
    setStorageError(false);
    const request = ++version.current;
    // Serialize writes so rapid changes cannot restore an older selection on the next launch.
    writes.current = writes.current
      .then(() => AsyncStorage.setItem(LANGUAGE_STORAGE_KEY, next))
      .then(() => {
        if (request === version.current) setStorageError(false);
      })
      .catch(() => {
        if (request === version.current) setStorageError(true);
      });
  }, []);
  const tags = foregroundLocales.map((item) => item.languageTag);
  const { language, locale } = resolveLocale(preference, tags);
  const detected = resolveLocale('system', tags).language;
  const t = useMemo(() => translator(language, locale, catalogs[language], en), [language, locale]);
  const number = useCallback(
    (value: number, options?: Intl.NumberFormatOptions) =>
      new Intl.NumberFormat(locale, { maximumFractionDigits: 2, ...options }).format(value),
    [locale],
  );
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.lang = locale;
      document.documentElement.dir = 'ltr';
    }
  }, [locale]);
  return { preference, language, locale, detected, setLanguage, ready, storageError, t, number };
}
const Context = createContext<ReturnType<typeof useLanguageState> | null>(null);
export function I18nProvider({ children }: { children: React.ReactNode }) {
  const value = useLanguageState();
  return (
    <Context.Provider value={value}>
      {value.ready ? (
        children
      ) : (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator />
        </View>
      )}
    </Context.Provider>
  );
}
export function useI18n() {
  const value = useContext(Context);
  if (!value) throw new Error('I18nProvider missing');
  return value;
}
