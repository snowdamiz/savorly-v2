import { useI18n } from '../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import {
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  Film,
  ImagePlus,
  Plus,
  Save,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react-native';
import { Recipe, RecipeInput, AIRequest, emptyRecipe } from '../lib/types';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { color, font, radius, s } from '../lib/theme';
import {
  Button,
  Chip,
  Dialog,
  Field,
  FoodImage,
  IconButton,
  NumberField,
  PageHeading,
  Segmented,
  useChrome,
} from '../components/ui';
import { VideoPlayer } from '../components/VideoPlayer';
import { foodIcon } from '../lib/icons';
import { CuisineIcon } from '../components/CuisineIcon';
import { CuisinePicker } from '../components/CuisinePicker';
import { DangerButton, SignInKitchen } from './Kitchen';
const tagOptions = [
  'Vegetarian',
  'Vegan',
  'Gluten free',
  'High protein',
  'Quick & easy',
  'Breakfast',
  'Comfort food',
  'Baking',
  'Dessert',
  'One pot',
  'Meal prep',
];
function Section({
  title,
  children,
  hint,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  const { t: tr } = useI18n();
  return (
    <View style={[s.card, { gap: 16 }]}>
      <View style={{ gap: 2 }}>
        <Text style={s.h2}>{title}</Text>
        {hint && <Text style={s.small}>{tr(hint)}</Text>}
      </View>
      {children}
    </View>
  );
}
const inset = { backgroundColor: color.bg, borderColor: color.bg };
export function Editor({
  initial,
  onPublished,
  onAI,
}: {
  initial?: Recipe | RecipeInput;
  onPublished: (r: Recipe) => void;
  onAI: (r: AIRequest) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const { desktop, compact } = useChrome();
  const [r, setR] = useState<RecipeInput>(initial || emptyRecipe());
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  const [remove, setRemove] = useState(false);
  const [choosingCuisine, setChoosingCuisine] = useState(false);
  const saved = useRef(false);
  const id = initial && 'id' in initial ? initial.id : undefined;
  const draftKey = `savorly.draft.${app.user?.id || 'guest'}.${id || 'new'}`;
  useEffect(() => {
    let alive = true;
    if (initial) {
      setR(initial);
      setDraftReady(true);
      return;
    }
    AsyncStorage.getItem(draftKey)
      .then((value) => {
        if (!alive) return;
        if (value) {
          try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed.ingredients) && Array.isArray(parsed.steps)) setR(parsed);
          } catch {}
        }
        setDraftReady(true);
      })
      .catch(() => {
        if (alive) setDraftReady(true);
      });
    return () => {
      alive = false;
    };
  }, [draftKey, initial]);
  useEffect(() => {
    if (!draftReady || saved.current || !app.user) return;
    const t = setTimeout(() => {
      void AsyncStorage.setItem(draftKey, JSON.stringify(r)).catch(() =>
        setError(
          'This device could not save your local draft. You can still save it to your account.',
        ),
      );
    }, 650);
    return () => clearTimeout(t);
  }, [r, draftReady, draftKey, app.user]);
  const update = <K extends keyof RecipeInput>(key: K, value: RecipeInput[K]) =>
    setR((old) => ({ ...old, [key]: value }));
  const dish = r.title ? `Dish: ${r.title}. ${r.description}`.slice(0, 1500) : undefined;
  const media = async (type: 'images' | 'videos', apply: (url: string) => void) => {
    if (uploading || !app.requireUser()) return;
    setUploading(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: type === 'images' ? ['images'] : ['videos'],
        quality: 0.85,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (asset.fileSize && asset.fileSize > 50 * 1024 * 1024)
        throw new Error('Choose a file smaller than 50 MB.');
      const data = new FormData();
      if (Platform.OS === 'web') {
        const blob = await (await fetch(asset.uri)).blob();
        data.append(
          'file',
          blob,
          asset.fileName || (type === 'images' ? 'image.jpg' : 'video.mp4'),
        );
      } else {
        data.append('file', {
          uri: asset.uri,
          name: asset.fileName || (type === 'images' ? 'image.jpg' : 'video.mp4'),
          type: asset.mimeType || (type === 'images' ? 'image/jpeg' : 'video/mp4'),
        } as unknown as Blob);
      }
      const response = await api<{ url: string }>('/media', { method: 'POST', body: data });
      apply(response.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  };
  const generate = (kind: 'image' | 'video') =>
    onAI({
      kind,
      title: kind === 'image' ? 'Create a cover photo' : 'Create a short clip',
      context: dish,
      placeholder:
        kind === 'image'
          ? 'Describe the plate, the light and the angle…'
          : 'Describe one moment: steam rising, a sauce being poured…',
      suggestions:
        kind === 'image'
          ? ['Natural light on a rustic table', 'Overhead editorial shot', 'Moody close-up']
          : ['A slow cinematic reveal', 'Steam rising from the bowl', 'The final plating'],
      onMedia: (url) =>
        setR((old) => ({ ...old, [kind === 'image' ? 'image' : 'video']: url, aiGenerated: true })),
    });
  const submit = async (published: boolean) => {
    if (busy || !app.requireUser()) return;
    setBusy(true);
    setError('');
    try {
      const recipe = await api<Recipe>(id ? `/recipes/${id}` : '/recipes', {
        method: id ? 'PUT' : 'POST',
        body: { ...r, published },
      });
      saved.current = true;
      await AsyncStorage.removeItem(draftKey);
      await Promise.all([app.refreshRecipes(), app.refreshPrivate()]);
      app.notify(
        published
          ? 'Your recipe is at the table. Thanks for sharing.'
          : 'Your draft is saved to your account.',
      );
      onPublished(recipe);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setIngredient = (n: number, patch: Partial<RecipeInput['ingredients'][number]>) =>
    update(
      'ingredients',
      r.ingredients.map((x, k) => (k === n ? { ...x, ...patch } : x)),
    );
  const setStep = (n: number, patch: Partial<RecipeInput['steps'][number]>) =>
    update(
      'steps',
      r.steps.map((x, k) => (k === n ? { ...x, ...patch } : x)),
    );
  const cover = () => void media('images', (url) => update('image', url));
  const photos = r.photos || [];
  const addPhoto = () =>
    void media('images', (url) =>
      setR((old) => ({ ...old, photos: [...(old.photos || []), url] })),
    );
  const photo = (
    <Section
      title={tr('Photos')}
      hint="The first is the cover; swipe-through extras follow it. JPEG, PNG or WebP you have permission to share."
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tr('Choose a cover photo')}
        onPress={cover}
      >
        {r.image ? (
          <FoodImage uri={r.image} style={{ height: 240, borderRadius: radius.md }} />
        ) : (
          <View
            style={{
              height: 200,
              borderWidth: 1.5,
              borderStyle: 'dashed',
              borderColor: color.line,
              borderRadius: radius.md,
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              backgroundColor: color.bg,
            }}
          >
            <Camera size={28} strokeWidth={1.6} color={color.muted} />
            <Text style={s.small}>{tr('Tap to add a photo')}</Text>
          </View>
        )}
      </Pressable>
      <View style={[s.row, { gap: 8 }]}>
        <Button
          title={tr('Upload')}
          label={tr('Upload a photo')}
          icon={ImagePlus}
          variant="secondary"
          busy={uploading}
          style={{ flex: 1 }}
          onPress={cover}
        />
        <Button
          title={tr('Generate')}
          label={tr('Generate a photo')}
          icon={Sparkles}
          variant="secondary"
          style={{ flex: 1 }}
          onPress={() => generate('image')}
        />
      </View>
      <Field
        label={tr('Or use an image URL')}
        value={r.image}
        onChangeText={(v) => update('image', v)}
        placeholder="https://…"
        autoCapitalize="none"
        style={inset}
      />
      {!!r.image && (
        <View style={{ gap: 10 }}>
          <Text style={s.small}>{tr('More photos · {{v0}} of 8', { v0: photos.length })}</Text>
          <View style={[s.wrap, { gap: 10 }]}>
            {photos.map((uri, n) => (
              <View key={`${uri}-${n}`}>
                <FoodImage uri={uri} style={{ width: 76, height: 76, borderRadius: radius.sm }} />
                <View style={{ position: 'absolute', top: -6, right: -6 }}>
                  <IconButton
                    icon={X}
                    size={26}
                    label={tr('Remove photo {{v0}}', { v0: n + 2 })}
                    onPress={() =>
                      update(
                        'photos',
                        photos.filter((_, k) => k !== n),
                      )
                    }
                  />
                </View>
              </View>
            ))}
            {photos.length < 8 && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={tr('Add another photo')}
                disabled={uploading}
                onPress={addPhoto}
                style={{
                  width: 76,
                  height: 76,
                  borderRadius: radius.sm,
                  borderWidth: 1.5,
                  borderStyle: 'dashed',
                  borderColor: color.line,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: uploading ? 0.5 : 1,
                }}
              >
                <Plus size={20} color={color.muted} strokeWidth={1.8} />
              </Pressable>
            )}
          </View>
        </View>
      )}
    </Section>
  );
  const video = (
    <Section title={tr('Video')} hint="Optional. MP4 or WebM up to 50 MB, or a direct video link.">
      {!!r.video && <VideoPlayer uri={r.video} />}
      <View style={[s.row, { gap: 8 }]}>
        <Button
          title={tr('Upload')}
          label={tr('Upload a recipe video')}
          icon={Film}
          variant="secondary"
          busy={uploading}
          style={{ flex: 1 }}
          onPress={() => void media('videos', (url) => update('video', url))}
        />
        <Button
          title={tr('Generate')}
          label={tr('Generate a clip')}
          icon={Sparkles}
          variant="secondary"
          style={{ flex: 1 }}
          onPress={() => generate('video')}
        />
      </View>
      <Field
        label={tr('Or use a direct video URL')}
        value={r.video}
        onChangeText={(v) => update('video', v)}
        placeholder="https://…/video.mp4"
        autoCapitalize="none"
        style={inset}
      />
    </Section>
  );
  return (
    <View style={{ gap: 18 }}>
      <PageHeading
        title={id ? tr('Edit recipe') : tr('New recipe')}
        subtitle={
          id
            ? tr('Make a few changes, then publish.')
            : tr('Your family favorite, your latest experiment.')
        }
      />
      {!app.user ? (
        <SignInKitchen
          title={tr('Your kitchen has a story to tell')}
          text={tr('Create an account to share recipes and upload your own photos and videos.')}
        />
      ) : (
        <>
          <View
            style={{ flexDirection: desktop ? 'row' : 'column', gap: 18, alignItems: 'flex-start' }}
          >
            <View style={{ flex: 1.35, gap: 18, alignSelf: 'stretch' }}>
              {!desktop && photo}
              <Section title={tr('The basics')}>
                <Field
                  label={tr('Recipe title')}
                  value={r.title}
                  onChangeText={(v) => update('title', v)}
                  placeholder={tr('Give it a name')}
                  maxLength={120}
                  style={inset}
                />
                <Field
                  label={tr('The story behind it')}
                  value={r.description}
                  onChangeText={(v) => update('description', v)}
                  placeholder={tr('What makes this dish special?')}
                  multiline
                  maxLength={3000}
                  style={inset}
                />
                <View style={[s.row, { gap: 8 }]}>
                  <Field
                    label={tr('Minutes')}
                    keyboardType="number-pad"
                    value={String(r.minutes || '')}
                    onChangeText={(v) => update('minutes', Number(v.replace(/\D/g, '')))}
                    style={inset}
                  />
                  <Field
                    label={tr('Servings')}
                    keyboardType="number-pad"
                    value={String(r.servings || '')}
                    onChangeText={(v) => update('servings', Number(v.replace(/\D/g, '')))}
                    style={inset}
                  />
                  <Field
                    label={tr('kcal / serving')}
                    keyboardType="number-pad"
                    placeholder={tr('Optional')}
                    value={String(r.calories || '')}
                    onChangeText={(v) => update('calories', Number(v.replace(/\D/g, '')))}
                    style={inset}
                  />
                </View>
                <Text style={s.label}>{tr('Cuisine')}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={tr('Choose cuisine, currently {{v0}}', { v0: tr(r.cuisine) })}
                  onPress={() => setChoosingCuisine(true)}
                  style={({ pressed }) => [
                    s.row,
                    {
                      gap: 12,
                      padding: 12,
                      borderRadius: radius.md,
                      backgroundColor: color.bg,
                      opacity: pressed ? 0.7 : 1,
                    },
                  ]}
                >
                  <CuisineIcon name={r.cuisine} size={36} />
                  <Text style={[s.body, { flex: 1, fontFamily: font.semibold }]}>
                    {tr(r.cuisine)}
                  </Text>
                  <ChevronDown size={18} color={color.muted} />
                </Pressable>
                <Text style={s.label}>{tr('Difficulty')}</Text>
                <Segmented
                  value={r.difficulty}
                  onChange={(v) => update('difficulty', v)}
                  options={(['Easy', 'Medium', 'Advanced'] as const).map((v) => ({
                    value: v,
                    label: tr(v),
                  }))}
                />
                <Text style={s.label}>{tr('Tags')}</Text>
                <View style={[s.wrap, { gap: 8 }]}>
                  {tagOptions.map((t) => (
                    <Chip
                      key={t}
                      title={tr(t)}
                      icon={foodIcon(t)}
                      active={r.tags.includes(t)}
                      onPress={() =>
                        update(
                          'tags',
                          r.tags.includes(t) ? r.tags.filter((x) => x !== t) : [...r.tags, t],
                        )
                      }
                    />
                  ))}
                </View>
              </Section>
              <Section title={tr('Ingredients')}>
                {r.ingredients.map((i, n) => (
                  <View
                    key={n}
                    style={[
                      { gap: 10 },
                      n > 0 && {
                        paddingTop: 16,
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderColor: color.line,
                      },
                    ]}
                  >
                    <View style={[s.row, { gap: 8, alignItems: 'flex-end' }]}>
                      <Field
                        label={tr('Ingredient {{v0}}', { v0: n + 1 })}
                        placeholder={tr('Ingredient name')}
                        value={i.name}
                        onChangeText={(v) => setIngredient(n, { name: v })}
                        style={inset}
                      />
                      <View style={{ paddingBottom: 6 }}>
                        <IconButton
                          icon={Trash2}
                          plain
                          size={42}
                          label={tr('Remove ingredient {{v0}}', { v0: n + 1 })}
                          onPress={() =>
                            update(
                              'ingredients',
                              r.ingredients.filter((_, k) => k !== n),
                            )
                          }
                        />
                      </View>
                    </View>
                    <View style={[s.row, { gap: 8 }]}>
                      <NumberField
                        label={tr('Amount')}
                        value={i.amount}
                        placeholder="1"
                        style={inset}
                        onChange={(v) => setIngredient(n, { amount: v })}
                      />
                      <Field
                        label={tr('Unit')}
                        placeholder={tr('g, tbsp…')}
                        value={i.unit}
                        onChangeText={(v) => setIngredient(n, { unit: v })}
                        style={inset}
                      />
                      <Field
                        label={tr('Aisle')}
                        value={i.category}
                        onChangeText={(v) => setIngredient(n, { category: v })}
                        style={inset}
                      />
                    </View>
                  </View>
                ))}
                <Button
                  title={tr('Add an ingredient')}
                  icon={Plus}
                  variant="secondary"
                  disabled={r.ingredients.length >= 80}
                  onPress={() =>
                    update('ingredients', [
                      ...r.ingredients,
                      { name: '', amount: 1, unit: '', category: 'Produce' },
                    ])
                  }
                />
              </Section>
              <Section title={tr('Method')}>
                {r.steps.map((step, n) => (
                  <View
                    key={n}
                    style={[
                      { gap: 10 },
                      n > 0 && {
                        paddingTop: 16,
                        borderTopWidth: StyleSheet.hairlineWidth,
                        borderColor: color.line,
                      },
                    ]}
                  >
                    <View style={s.between}>
                      <View style={[s.row, { gap: 10 }]}>
                        <View
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 14,
                            backgroundColor: color.ink,
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <Text style={{ color: color.white, fontFamily: font.bold, fontSize: 12 }}>
                            {n + 1}
                          </Text>
                        </View>
                        <Text style={s.h3}>{tr('Step {{v0}}', { v0: n + 1 })}</Text>
                      </View>
                      <IconButton
                        icon={Trash2}
                        plain
                        size={38}
                        label={tr('Remove step {{v0}}', { v0: n + 1 })}
                        onPress={() =>
                          update(
                            'steps',
                            r.steps.filter((_, k) => k !== n),
                          )
                        }
                      />
                    </View>
                    <Field
                      label={tr('Step {{v0}} title', { v0: n + 1 })}
                      placeholder={tr('A short, helpful title')}
                      value={step.title}
                      onChangeText={(v) => setStep(n, { title: v })}
                      style={inset}
                    />
                    <Field
                      label={tr('Step {{v0}} instructions', { v0: n + 1 })}
                      multiline
                      placeholder={tr('Explain it like a friend is cooking alongside you…')}
                      value={step.text}
                      onChangeText={(v) => setStep(n, { text: v })}
                      style={inset}
                    />
                    <Field
                      label={tr('Timer in minutes (optional)')}
                      value={step.seconds ? String(step.seconds / 60) : ''}
                      keyboardType="decimal-pad"
                      placeholder="0"
                      onChangeText={(v) =>
                        setStep(n, { seconds: Math.round((Number(v) || 0) * 60) })
                      }
                      style={inset}
                    />
                  </View>
                ))}
                <Button
                  title={tr('Add a step')}
                  icon={Plus}
                  variant="secondary"
                  disabled={r.steps.length >= 40}
                  onPress={() => update('steps', [...r.steps, { title: '', text: '', seconds: 0 }])}
                />
              </Section>
            </View>
            <View style={{ flex: desktop ? 0.85 : undefined, gap: 18, alignSelf: 'stretch' }}>
              {desktop && photo}
              {video}
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: r.aiGenerated }}
                accessibilityLabel={tr('I used AI to create this')}
                onPress={() => update('aiGenerated', !r.aiGenerated)}
                style={[s.card, s.row, { gap: 14 }]}
              >
                <View
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 13,
                    borderWidth: 1.5,
                    borderColor: r.aiGenerated ? color.ink : color.line,
                    backgroundColor: r.aiGenerated ? color.ink : color.white,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {r.aiGenerated && <Check size={15} color={color.white} strokeWidth={3} />}
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[s.h3, { fontSize: 15 }]}>{tr('AI helped with this recipe')}</Text>
                  <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17 }]}>
                    {tr(
                      'Shown on your recipe. Check amounts, timings and allergens before sharing.',
                    )}
                  </Text>
                </View>
              </Pressable>
            </View>
          </View>
          {!!error && (
            <View style={{ backgroundColor: color.errorBg, borderRadius: radius.md, padding: 16 }}>
              <Text accessibilityRole="alert" style={[s.body, { color: color.error }]}>
                {tr(error)}
              </Text>
            </View>
          )}
          <View style={[s.card, { gap: 12 }]}>
            <View style={{ flexDirection: compact ? 'column' : 'row', gap: 10 }}>
              <Button
                title={id ? tr('Publish changes') : tr('Share my recipe')}
                icon={ArrowRight}
                busy={busy}
                large
                style={{ flex: compact ? undefined : 1 }}
                onPress={() => void submit(true)}
              />
              <Button
                title={tr('Save draft')}
                icon={Save}
                variant="secondary"
                busy={busy}
                large
                style={{ flex: compact ? undefined : 1 }}
                onPress={() => void submit(false)}
              />
            </View>
            <Text style={[s.small, { textAlign: 'center', fontFamily: font.medium }]}>
              {tr('Drafts also save on this device as you type.')}
            </Text>
            {id && (
              <Button
                title={tr('Delete this recipe')}
                icon={Trash2}
                variant="ghost"
                small
                onPress={() => setRemove(true)}
              />
            )}
          </View>
        </>
      )}
      <Dialog
        visible={choosingCuisine}
        onClose={() => setChoosingCuisine(false)}
        title={tr('Choose a cuisine')}
      >
        <CuisinePicker
          value={r.cuisine}
          onChange={(cuisine) => {
            update('cuisine', cuisine);
            setChoosingCuisine(false);
          }}
        />
      </Dialog>
      <Dialog visible={remove} onClose={() => setRemove(false)} title={tr('Delete this recipe?')}>
        <Text style={s.body}>
          {tr(
            'This permanently deletes your recipe, its reviews and saves. To hide it instead, save it as a draft.',
          )}
        </Text>
        <DangerButton
          title={tr('Permanently delete recipe')}
          onPress={() =>
            void app.act(async () => {
              await api(`/recipes/${id}`, { method: 'DELETE' });
              await Promise.all([app.refreshRecipes(), app.refreshPrivate()]);
              saved.current = true;
              await AsyncStorage.removeItem(draftKey);
              setRemove(false);
              onPublished({
                ...r,
                id: '',
                author: app.user!,
                rating: 0,
                reviewCount: 0,
                saveCount: 0,
                createdAt: '',
              });
            }, 'Recipe deleted.')
          }
        />
      </Dialog>
    </View>
  );
}
