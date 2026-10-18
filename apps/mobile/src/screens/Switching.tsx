import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { ArrowRight, Check, FileUp, Search, X } from '../components/icons';
import { ImportProgress } from '../components/ImportProgress';
import { RecipeRow } from '../components/RecipeCard';
import { ErrorNote } from '../components/SettingsRow';
import { Button, Dialog, Field, IconButton, PageHeading } from '../components/ui';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import {
  MAX_BATCH,
  batchesOf,
  readPaste,
  recipeLinks,
  siteOf,
  useImports,
  type ImportPurpose,
} from '../lib/imports';
import { useApp } from '../lib/store';
import { pickTextFile } from '../lib/textFile';
import { color, font, s } from '../lib/theme';
import type { Recipe } from '../lib/types';

// Switching to Savorly safely (docs/SWITCHING.md): the page for Mealime's members (/?page=mealime),
// who bring the recipes they wrote or saved from other sites before Mealime closes, and a
// creator's import of the recipes on their own site (/?page=own-site). Both send bulk imports
// (lib/imports.ts), which the server reads into private drafts while the cook does something else.

type Props = { onOpen: (recipe: Recipe) => void };

/** Opens one of the cook's drafts by its id. */
function useOpenDraft(onOpen: Props['onOpen']) {
  const app = useApp();
  return (id: string) =>
    void app.act(async () => onOpen(await api<Recipe>(`/recipes/${encodeURIComponent(id)}`)));
}

/** In place of a form, for a visitor without a kitchen: the imports go into one. */
function JoinFirst() {
  const { t: tr } = useI18n();
  const app = useApp();
  return (
    <View style={{ gap: 10 }}>
      <Button
        title={tr('Create my free kitchen')}
        icon={ArrowRight}
        onPress={() => app.setAuthOpen(true, 'register')}
      />
      <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17 }]}>
        {tr(
          'Your recipes go into your Savorly kitchen, so create it first. Saving, lists and planning are free.',
        )}
      </Text>
    </View>
  );
}

/** The batches a page started, newest first: the three latest. */
function Progress({
  purpose,
  imports,
  onOpen,
  onSimilar,
}: {
  purpose: ImportPurpose;
  imports: ReturnType<typeof useImports>;
  onOpen: (id: string) => void;
  onSimilar?: (name: string) => void;
}) {
  const app = useApp();
  return (
    <>
      {(imports.batches ?? [])
        .filter((b) => b.purpose === purpose)
        .slice(0, 3)
        .map((batch) => (
          <ImportProgress
            key={batch.id}
            batch={batch}
            onOpen={onOpen}
            onSimilar={onSimilar}
            onStop={() => void app.act(() => imports.stop(batch.id))}
          />
        ))}
    </>
  );
}

/** A line of what comes over and what doesn't. */
function Point({ kept, text }: { kept: boolean; text: string }) {
  return (
    <View style={[s.row, { gap: 12, alignItems: 'flex-start' }]}>
      <View style={{ paddingTop: 3 }}>
        {kept ? (
          <Check size={16} color={color.success} strokeWidth={2.6} />
        ) : (
          <X size={16} color={color.muted} strokeWidth={2.4} />
        )}
      </View>
      <Text style={[s.body, { flex: 1 }]}>{text}</Text>
    </View>
  );
}

/** The page for Mealime's members, who are invited to make a kitchen first if they have none. */
export function MealimePage({ onOpen }: Props) {
  const { t: tr } = useI18n();
  const app = useApp();
  const imports = useImports('mealime');
  const openDraft = useOpenDraft(onOpen);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [similar, setSimilar] = useState<string | null>(null);
  const [name, setName] = useState('');
  const found = readPaste(text);
  const count = found.links.length + found.texts.length;
  const upload = async () => {
    if (!pickTextFile) return;
    setError('');
    try {
      const file = await pickTextFile();
      if (!file) return;
      // A bookmarks or spreadsheet file brings its links; notes bring their text as it is.
      const added = /\.(html?|csv|json)$/i.test(file.name)
        ? recipeLinks(file.text).join('\n')
        : file.text.trim();
      if (!added) return setError('We couldn’t find links or recipes in that file.');
      setText((old) => (old.trim() ? `${old.trim()}\n---\n${added}` : added));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const start = async () => {
    setBusy(true);
    setError('');
    let sent = { links: 0, texts: 0 };
    try {
      for (const batch of batchesOf(found)) {
        await imports.start(batch);
        sent = { links: sent.links + batch.urls.length, texts: sent.texts + batch.texts.length };
      }
      setText('');
    } catch (e) {
      setError((e as Error).message);
      // What didn't go stays in the box, to send once the first batches are read.
      if (sent.links || sent.texts)
        setText(
          [...found.links.slice(sent.links), ...found.texts.slice(sent.texts)].join('\n---\n'),
        );
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 28, width: '100%', maxWidth: 640 }}>
      <PageHeading
        eyebrow={tr('Moving from Mealime')}
        title={tr('Bring your recipes to Savorly')}
        subtitle={tr(
          'Mealime closes on October 21 and deletes its members’ data. Here’s how to keep your recipes.',
        )}
      />
      <View style={{ gap: 12 }}>
        <Point
          kept
          text={tr(
            'Recipes you saved from other sites come over from their original pages, credited to them.',
          )}
        />
        <Point kept text={tr('Recipes you wrote yourself come over as you wrote them.')} />
        <Point
          kept={false}
          text={tr('Mealime’s own recipes stay with Mealime, so we’ll find similar ones here.')}
        />
      </View>
      {app.user ? (
        <View style={{ gap: 10 }}>
          <Field
            label={tr('Your recipes')}
            value={text}
            onChangeText={setText}
            multiline
            placeholder="https://…"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />
          <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17 }]}>
            {tr(
              'Paste links to the recipes you saved, or the recipes you wrote, as many as you like. Mealime has no export, so copy them from the app.',
            )}
          </Text>
          {!!error && <ErrorNote message={tr(error)} />}
          <View style={[s.row, { gap: 10, marginTop: 6 }]}>
            <Button
              title={count ? tr('bringOver', { count }) : tr('Bring them over')}
              icon={ArrowRight}
              busy={busy}
              disabled={!count}
              onPress={() => void start()}
              style={{ flex: 1 }}
            />
            {pickTextFile && (
              <IconButton
                icon={FileUp}
                label={tr('Upload a file')}
                onPress={() => void upload()}
                size={52}
              />
            )}
          </View>
          {count > MAX_BATCH && (
            <Text style={[s.small, { fontFamily: font.medium }]}>
              {tr('They come over 50 at a time, one batch after another.')}
            </Text>
          )}
        </View>
      ) : (
        <JoinFirst />
      )}
      <Progress purpose="mealime" imports={imports} onOpen={openDraft} onSimilar={setSimilar} />
      <View style={{ gap: 10 }}>
        <Text role="heading" aria-level={2} style={s.h3}>
          {tr('Find a Mealime favorite on Savorly')}
        </Text>
        <View style={[s.row, { gap: 10 }]}>
          <Field
            value={name}
            onChangeText={setName}
            placeholder={tr('A Mealime recipe’s name')}
            returnKeyType="search"
            onSubmitEditing={() => name.trim() && setSimilar(name.trim())}
          />
          <IconButton
            icon={Search}
            label={tr('Find similar recipes')}
            disabled={!name.trim()}
            onPress={() => setSimilar(name.trim())}
            size={52}
          />
        </View>
      </View>
      <Similar
        name={similar}
        onClose={() => setSimilar(null)}
        onOpen={(recipe) => {
          setSimilar(null);
          onOpen(recipe);
        }}
      />
    </View>
  );
}

/** Savorly's recipes like one of Mealime's own, by its name (POST /imports/similar). */
function Similar({
  name,
  onClose,
  onOpen,
}: {
  name: string | null;
  onClose: () => void;
  onOpen: (recipe: Recipe) => void;
}) {
  const { t: tr } = useI18n();
  const [found, setFound] = useState<{ name: string; recipes: Recipe[]; error: string } | null>(
    null,
  );
  useEffect(() => {
    if (!name) return;
    let live = true;
    api<{ name: string; recipes: Recipe[] }[]>('/imports/similar', {
      method: 'POST',
      body: { names: [name] },
    })
      .then((list) => live && setFound({ name, recipes: list[0]?.recipes ?? [], error: '' }))
      .catch((e: Error) => live && setFound({ name, recipes: [], error: e.message }));
    return () => {
      live = false;
    };
  }, [name]);
  const ready = found && found.name === name ? found : null;
  return (
    <Dialog
      visible={!!name}
      onClose={onClose}
      title={tr('Like “{{v0}}”', { v0: name ?? found?.name ?? '' })}
    >
      {!ready ? (
        <ActivityIndicator color={color.ink} style={{ paddingVertical: 24 }} />
      ) : ready.error ? (
        <ErrorNote message={tr(ready.error)} />
      ) : ready.recipes.length ? (
        ready.recipes.map((recipe) => <RecipeRow key={recipe.id} recipe={recipe} onOpen={onOpen} />)
      ) : (
        <Text style={s.muted}>
          {tr('Nothing close yet. Try a shorter name, like its main ingredient.')}
        </Text>
      )}
    </Dialog>
  );
}

/** A creator's import of the recipes they published on their own site, with their permission. */
export function OwnSitePage({ onOpen }: Props) {
  const { t: tr } = useI18n();
  const app = useApp();
  const imports = useImports('own_site');
  const openDraft = useOpenDraft(onOpen);
  const [text, setText] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const links = recipeLinks(text);
  const site = links.length ? siteOf(links[0]) : '';
  const onSite = links.filter((link) => siteOf(link) === site);
  const own = onSite.slice(0, MAX_BATCH);
  const elsewhere = links.length - onSite.length;
  const start = async () => {
    setBusy(true);
    setError('');
    try {
      await imports.start({ urls: own, ownRecipes: true });
      setText(links.filter((link) => !own.includes(link)).join('\n'));
      setAgreed(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const statement = tr(
    'These recipes are my own and published on my own site, {{site}}. I give Savorly permission to import them into my Savorly kitchen, each linking back to its page.',
    { site },
  );
  return (
    <View style={{ gap: 28, width: '100%', maxWidth: 640 }}>
      <PageHeading
        eyebrow={tr('For creators')}
        title={tr('Bring your recipes from your own site')}
        subtitle={tr(
          'Savorly brings in the recipes you published on your blog or website, with their photos, as private drafts for you to check and publish. Each one links back to its page on your site.',
        )}
      />
      {app.user ? (
        <View style={{ gap: 10 }}>
          <Field
            label={tr('Links to your recipes')}
            value={text}
            onChangeText={(v) => {
              setText(v);
              setAgreed(false);
            }}
            multiline
            placeholder="https://…"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
          />
          <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17 }]}>
            {site
              ? elsewhere
                ? tr('ownSiteLeftOut', { count: elsewhere, site })
                : onSite.length > MAX_BATCH
                  ? tr('They come over 50 at a time, one batch after another.')
                  : tr('ownSiteLinks', { count: own.length, site })
              : tr(
                  'Paste the address of each recipe page, one per line. Up to 50 at a time, 200 a day.',
                )}
          </Text>
          {!!site && (
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: agreed }}
              aria-checked={agreed}
              accessibilityLabel={statement}
              onPress={() => setAgreed((v) => !v)}
              style={[s.row, { gap: 12, alignItems: 'flex-start', paddingVertical: 8 }]}
            >
              <View
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 12,
                  borderWidth: 1.5,
                  borderColor: agreed ? color.ink : color.line,
                  backgroundColor: agreed ? color.ink : color.white,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {agreed && <Check size={14} color={color.white} strokeWidth={3} />}
              </View>
              <Text style={[s.body, { flex: 1 }]}>{statement}</Text>
            </Pressable>
          )}
          {!!error && <ErrorNote message={tr(error)} />}
          <Button
            title={tr('Import my recipes')}
            icon={ArrowRight}
            busy={busy}
            disabled={!own.length || !agreed}
            onPress={() => void start()}
            style={{ marginTop: 6 }}
          />
          {app.capabilities?.creatorFund && (
            <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17 }]}>
              {tr(
                'Every verified cook of a recipe you publish earns you a share of the creator fund.',
              )}
            </Text>
          )}
        </View>
      ) : (
        <JoinFirst />
      )}
      <Progress purpose="own_site" imports={imports} onOpen={openDraft} />
    </View>
  );
}
