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
import { RecipeInput, Screen, StudioMode } from '../lib/types';
import { useApp } from '../lib/store';
import { importError, importRecipe, postPlatform, recipeLink } from '../lib/recipeImport';
import { MAX_BATCH, recipeLinks, useImports } from '../lib/imports';
import { track } from '../lib/telemetry';
import { color, font, radius, s } from '../lib/theme';
import { ImportProgress } from './ImportProgress';
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
    text: 'Paste a link to a recipe page or a cooking video. We’ll bring it in for you to edit.',
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
  onOpenRecipe,
  onPage,
}: {
  visible: boolean;
  onClose: () => void;
  onStart: (mode: StudioMode | 'write') => void;
  /** A recipe brought in from a link, ready for the editor; nothing is saved yet. */
  onImported: (recipe: RecipeInput) => void;
  /** One of several links brought in at once, saved as a private draft. */
  onOpenRecipe: (id: string) => void;
  /** The pages that bring many recipes over: from Mealime, or from the cook's own site. */
  onPage: (screen: Screen) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [importing, setImporting] = useState(false);
  const [link, setLink] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [stage, setStage] = useState<'idle' | 'opening' | 'reading'>('idle');
  const [error, setError] = useState('');
  // Several links pasted at once are read on the server, as a batch of drafts (lib/imports.ts).
  const imports = useImports('links', visible && importing);
  const [batchId, setBatchId] = useState('');
  const batch = imports.batches?.find((b) => b.id === batchId);
  const links = recipeLinks(link);
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
      setBatchId('');
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
    setBatchId('');
  };
  const type = (text: string) => {
    setInvalid(false);
    // Several links stay as they are, to be brought in together.
    if (recipeLinks(text).length > 1) return setLink(text);
    // Pasting a whole message ("Try this! https://…") keeps just the link.
    const pasted = recipeLink(text);
    setLink(pasted && text.length - link.length > 1 && pasted !== text.trim() ? pasted : text);
  };
  const submit = async () => {
    if (stage !== 'idle') return;
    if (links.length > 1) return importMany();
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
  const importMany = async () => {
    if (!app.requireUser()) return;
    if (links.length > MAX_BATCH) return setError('Import up to 50 recipes at a time.');
    setError('');
    setStage('opening');
    try {
      const started = await imports.start({ urls: links });
      setBatchId(started.id);
      setLink('');
    } catch (e) {
      // A batch's refusals say what to change, in the catalogs' words.
      setError((e as Error).message);
    } finally {
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
      {importing && batch ? (
        <>
          <ImportProgress
            batch={batch}
            onOpen={(id) => {
              onClose();
              onOpenRecipe(id);
            }}
            onStop={() => void app.act(() => imports.stop(batch.id))}
          />
          <Button
            title={tr('Import more links')}
            variant="secondary"
            onPress={() => setBatchId('')}
          />
        </>
      ) : importing ? (
        <>
          <Text style={[s.muted, { marginTop: -8 }]}>
            {tr(
              'Paste the address of a recipe page, or of a video on TikTok, Instagram, YouTube, Facebook or Pinterest. We’ll bring the recipe into the editor for you to check.',
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
                <Text style={s.h3}>
                  {postPlatform(recipeLink(link))
                    ? tr('The sous-chef is reading the post…')
                    : tr('The sous-chef is reading the page…')}
                </Text>
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
            title={
              links.length > 1 ? tr('importLinks', { count: links.length }) : tr('Import recipe')
            }
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
          <View style={[s.row, { gap: 4, flexWrap: 'wrap', marginTop: -4 }]}>
            <Text style={s.small}>{tr('Many at once:')}</Text>
            {(
              [
                ['mealime', 'From Mealime'],
                ['own-site', 'From your own site'],
              ] as const
            ).map(([page, title]) => (
              <Press
                key={page}
                accessibilityRole="link"
                accessibilityLabel={tr(title)}
                onPress={() => {
                  onClose();
                  onPage(page);
                }}
                style={{ minHeight: 36, justifyContent: 'center', paddingHorizontal: 4 }}
              >
                <Text style={[s.small, { color: color.ink, textDecorationLine: 'underline' }]}>
                  {tr(title)}
                </Text>
              </Press>
            ))}
          </View>
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
