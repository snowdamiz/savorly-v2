import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Check, Languages, Sparkles } from './icons';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { color, font, radius, s } from '../lib/theme';
import type { useRecipeTranslation } from '../lib/useRecipeTranslation';
import { Button } from './ui';

type Translate = ReturnType<typeof useI18n>['t'];

// Whole sentences per language, since a language's name changes with the sentence around it in
// many of the app's languages ("aus dem Französischen", "с французского").
const writtenIn = (tr: Translate, code: string) =>
  ({
    en: tr('Written in English'),
    fr: tr('Written in French'),
    de: tr('Written in German'),
    ru: tr('Written in Russian'),
    es: tr('Written in Spanish'),
    it: tr('Written in Italian'),
    pt: tr('Written in Portuguese'),
    zh: tr('Written in Chinese'),
    ja: tr('Written in Japanese'),
  })[code] ?? '';
const translatedFrom = (tr: Translate, code: string) =>
  ({
    en: tr('Translated from English by AI'),
    fr: tr('Translated from French by AI'),
    de: tr('Translated from German by AI'),
    ru: tr('Translated from Russian by AI'),
    es: tr('Translated from Spanish by AI'),
    it: tr('Translated from Italian by AI'),
    pt: tr('Translated from Portuguese by AI'),
    zh: tr('Translated from Chinese by AI'),
    ja: tr('Translated from Japanese by AI'),
  })[code] ?? tr('Translated by AI');

/**
 * A calm line on a recipe written in another language: what it's written in and a tap to read it
 * in the app's language, or, translated, that AI translated it and a way back to the original.
 * "Always translate recipes" shows once the cook has seen a translation, and while it's on.
 */
export function TranslationBar({
  language,
  translation: t,
}: {
  /** The recipe's own language. */
  language: string;
  translation: ReturnType<typeof useRecipeTranslation>;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  if (!t.available) return null;
  const done = t.status === 'translated';
  const Icon = done ? Sparkles : Languages;
  return (
    <View
      accessibilityRole="summary"
      style={{
        backgroundColor: color.white,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: color.border,
        paddingVertical: 10,
        paddingLeft: 14,
        paddingRight: 10,
        gap: 8,
      }}
    >
      <View style={[s.row, { gap: 10, flexWrap: 'wrap' }]}>
        <Icon size={18} color={color.ink} strokeWidth={1.9} />
        <Text style={[s.body, { flex: 1, minWidth: 140, fontSize: 14, lineHeight: 20 }]}>
          {done
            ? translatedFrom(tr, language)
            : t.status === 'loading'
              ? tr('Translating to English…')
              : writtenIn(tr, language)}
        </Text>
        {done ? (
          <Button title={tr('Show original')} variant="secondary" small onPress={t.showOriginal} />
        ) : (
          <Button
            title={t.status === 'failed' ? tr('Try again') : tr('Translate')}
            label={tr('Translate to English')}
            variant="secondary"
            small
            busy={t.status === 'loading'}
            onPress={t.translate}
          />
        )}
      </View>
      {t.status === 'failed' && (
        <View style={[s.row, { gap: 10, flexWrap: 'wrap' }]}>
          <Text accessibilityRole="alert" style={[s.small, { flex: 1, color: color.error }]}>
            {tr(t.error)}
          </Text>
          {t.signIn && (
            <Button
              title={tr('Sign in')}
              variant="ghost"
              small
              onPress={() => app.setAuthOpen(true)}
            />
          )}
        </View>
      )}
      {(done || t.always) && (
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel={tr('Always translate recipes')}
          accessibilityHint={tr('Recipes in other languages open in yours, translated by AI.')}
          accessibilityState={{ checked: t.always }}
          aria-checked={t.always}
          onPress={() => t.setAlways(!t.always)}
          hitSlop={6}
          style={[s.row, { gap: 8, alignSelf: 'flex-start' }]}
        >
          <View
            style={{
              width: 18,
              height: 18,
              borderRadius: 6,
              borderWidth: 1.5,
              borderColor: color.ink,
              backgroundColor: t.always ? color.ink : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {t.always && <Check size={12} color={color.white} strokeWidth={3} />}
          </View>
          <Text style={[s.small, { color: color.ink, fontFamily: font.semibold }]}>
            {tr('Always translate recipes')}
          </Text>
        </Pressable>
      )}
    </View>
  );
}
