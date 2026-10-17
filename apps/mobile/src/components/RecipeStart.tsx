import { useI18n } from '../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import {
  ArrowRight,
  Camera,
  ChevronLeft,
  ChevronRight,
  Link2,
  MessageCircle,
  Mic,
  PenLine,
} from './icons';
import { RecipeInput, StudioMode } from '../lib/types';
import { useApp } from '../lib/store';
import { importError, importRecipe, recipeLink } from '../lib/recipeImport';
import { track } from '../lib/telemetry';
import { color, font, radius, s } from '../lib/theme';
import { Button, Dialog, Field, IconButton, Press } from './ui';
const options = [
  {
    mode: 'voice',
    title: 'Speak it',
    text: 'Talk it through, like you would to a friend.',
    label: 'Speak a recipe',
    icon: Mic,
  },
  {
    mode: 'photo',
    title: 'Scan it',
    text: 'Snap a recipe card, cookbook page or screenshot.',
    label: 'Scan a recipe',
    icon: Camera,
  },
  {
    mode: 'chat',
    title: 'Chat it',
    text: 'Type it out. We’ll ask about anything missing.',
    label: 'Chat to create a recipe',
    icon: MessageCircle,
  },
  {
    mode: 'link',
    title: 'Import from a link',
    text: 'Paste a recipe’s web address. We’ll bring it in for you to edit.',
    label: 'Import a recipe from a link',
    icon: Link2,
  },
  {
    mode: 'write',
    title: 'Write it yourself',
    text: 'Fill in the ingredients and steps by hand.',
    label: 'Write a recipe yourself',
    icon: PenLine,
  },
] as const;
// The one way into adding a recipe: the + tab, the desktop Create button and empty states all open it.
export function RecipeStart({
  visible,
  onClose,
  onStart,
  onImported,
}: {
  visible: boolean;
  onClose: () => void;
  onStart: (mode: StudioMode | 'write') => void;
  /** A recipe brought in from a link, ready for the editor; nothing is saved yet. */
  onImported: (recipe: RecipeInput) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [importing, setImporting] = useState(false);
  const [link, setLink] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [stage, setStage] = useState<'idle' | 'opening' | 'reading'>('idle');
  const [error, setError] = useState('');
  // Each import is numbered; going back, closing or starting another one leaves the old one behind.
  const attempt = useRef(0);
  // Each opening starts from the menu.
  const [opened, setOpened] = useState(visible);
  if (opened !== visible) {
    setOpened(visible);
    if (visible) {
      setImporting(false);
      setLink('');
      setInvalid(false);
      setStage('idle');
      setError('');
    }
  }
  useEffect(() => {
    if (!visible) attempt.current++;
  }, [visible]);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  const back = () => {
    attempt.current++;
    setStage('idle');
    setError('');
    setInvalid(false);
    setImporting(false);
  };
  const type = (text: string) => {
    setInvalid(false);
    // Pasting a whole message ("Try this! https://…") keeps just the link.
    const pasted = recipeLink(text);
    setLink(pasted && text.length - link.length > 1 && pasted !== text.trim() ? pasted : text);
  };
  const submit = async () => {
    if (stage !== 'idle') return;
    const url = recipeLink(link);
    if (!url) {
      setInvalid(true);
      return;
    }
    if (!app.requireUser()) return;
    const n = ++attempt.current;
    const current = () => attempt.current === n;
    setError('');
    setStage('opening');
    try {
      const result = await importRecipe(url, {
        live: current,
        onReading: () => current() && setStage('reading'),
      });
      if (!result || !current()) return;
      track('import', { method: result.method });
      setStage('idle');
      onClose();
      onImported(result.recipe);
    } catch (e) {
      if (!current()) return;
      setError(importError(e));
      setStage('idle');
    }
  };
  const busy = stage !== 'idle';
  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={importing ? tr('Import from a link') : tr('Add a recipe')}
      leading={
        importing ? (
          <IconButton icon={ChevronLeft} label={tr('Back')} onPress={back} size={38} glass />
        ) : undefined
      }
    >
      {importing ? (
        <>
          <Text style={[s.muted, { marginTop: -8 }]}>
            {tr(
              'Paste the address of a recipe page. We’ll bring the recipe into the editor for you to check.',
            )}
          </Text>
          <View style={{ gap: 8 }}>
            <Field
              label={tr('Recipe link')}
              value={link}
              onChangeText={type}
              onSubmitEditing={() => void submit()}
              placeholder="https://…"
              keyboardType="url"
              inputMode="url"
              textContentType="URL"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="go"
              editable={!busy}
              maxLength={2000}
            />
            {invalid && (
              <Text accessibilityRole="alert" style={[s.small, { color: color.error }]}>
                {tr('Enter the full address of a web page, like https://example.com/recipe.')}
              </Text>
            )}
          </View>
          {stage === 'reading' && (
            <View
              accessibilityLiveRegion="polite"
              style={[s.card, s.row, { gap: 14, alignItems: 'flex-start' }]}
            >
              <ActivityIndicator color={color.ink} style={{ marginTop: 2 }} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={s.h3}>{tr('The sous-chef is reading the page…')}</Text>
                <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17 }]}>
                  {tr(
                    'This can take a minute. You can close this: the recipe will be in your sous-chef history when it’s ready.',
                  )}
                </Text>
              </View>
            </View>
          )}
          {!!error && (
            <View style={{ backgroundColor: color.errorBg, borderRadius: radius.md, padding: 16 }}>
              <Text accessibilityRole="alert" style={[s.body, { color: color.error }]}>
                {tr(error)}
              </Text>
            </View>
          )}
          <Button
            title={tr('Import recipe')}
            icon={ArrowRight}
            large
            busy={busy}
            disabled={!link.trim()}
            onPress={() => void submit()}
          />
          <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17 }]}>
            {tr(
              'Imported recipes stay private until you share them, and credit the original page.',
            )}
          </Text>
        </>
      ) : (
        <>
          <Text style={[s.muted, { marginTop: -8 }]}>
            {tr('However it’s easiest. We’ll turn it into a recipe you can edit.')}
          </Text>
          <View style={{ gap: 10 }}>
            {options.map(({ mode, title, text, label, icon: Icon }) => {
              const manual = mode === 'write' || mode === 'link';
              return (
                <Press
                  key={mode}
                  accessibilityRole="button"
                  accessibilityLabel={tr(label)}
                  onPress={() => (mode === 'link' ? setImporting(true) : onStart(mode))}
                  scale={0.98}
                  style={[s.card, s.row, { gap: 14, padding: 14 }]}
                >
                  <View
                    style={{
                      width: 46,
                      height: 46,
                      borderRadius: 23,
                      backgroundColor: manual ? color.bg : color.ink,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Icon size={20} color={manual ? color.ink : color.white} strokeWidth={1.9} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={s.h3}>{tr(title)}</Text>
                    <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17 }]}>
                      {tr(text)}
                    </Text>
                  </View>
                  <ChevronRight size={18} color={color.soft} />
                </Press>
              );
            })}
          </View>
        </>
      )}
    </Dialog>
  );
}
