import { languages, useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';
import {
  ArrowRight,
  Camera,
  Check,
  ChevronDown,
  ExternalLink,
  Film,
  GitFork,
  ImagePlus,
  Images,
  Languages,
  Link2,
  LucideIcon,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  X,
} from '../components/icons';
import { Recipe, RecipeInput, AIRequest, emptyRecipe } from '../lib/types';
import { api, ApiError } from '../lib/api';
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
  Press,
  Segmented,
  useChrome,
} from '../components/ui';
import { StepClip, VideoPlayer } from '../components/VideoPlayer';
import { foodIcon } from '../lib/icons';
import { LocalMedia, pickPhoto, preparePhoto, uploadMedia } from '../lib/photos';
import { CuisineIcon } from '../components/CuisineIcon';
import { CuisinePicker } from '../components/CuisinePicker';
import { PhotoTouchUp } from '../components/PhotoTouchUp';
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
// What the cook wrote, in a fixed shape and order, so a device draft and the copy it came from
// compare as text. Newer fields join only when set, so drafts kept before them still match; a
// step photo or clip the cook removed stays as '', so a restored draft removes it again.
const draftOf = (r: RecipeInput) =>
  JSON.stringify({
    title: r.title,
    description: r.description,
    cuisine: r.cuisine,
    minutes: r.minutes,
    servings: r.servings,
    difficulty: r.difficulty,
    image: r.image || '',
    photos: r.photos || [],
    video: r.video || '',
    ingredients: r.ingredients.map(({ name, amount, unit, category }) => ({
      name,
      amount,
      unit,
      category,
    })),
    steps: r.steps.map(({ title, text, seconds, image, video }) => ({
      title,
      text,
      seconds,
      ...(typeof image === 'string' ? { image } : {}),
      ...(typeof video === 'string' ? { video } : {}),
    })),
    tags: r.tags || [],
    calories: r.calories || 0,
    aiGenerated: !!r.aiGenerated,
    ...(r.language ? { language: r.language } : {}),
    ...(r.sourceUrl ? { sourceUrl: r.sourceUrl } : {}),
    ...(typeof r.derivedFrom === 'string' && r.derivedFrom ? { derivedFrom: r.derivedFrom } : {}),
  });
function readDraft(value: string | null): Partial<RecipeInput> | null {
  try {
    const draft = value ? JSON.parse(value) : null;
    return Array.isArray(draft?.ingredients) && Array.isArray(draft?.steps) ? draft : null;
  } catch {
    return null;
  }
}
// A short name for a recipe's contents (FNV-1a), so each sous-chef result keeps a draft of its own.
function fingerprint(text: string) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(36);
}
// Step clips are short, and the editor says so. The system picker is asked for no more than this
// many seconds; it holds to that where it records or trims a video, and passes a clip chosen from
// the library through as it is.
const CLIP_SECONDS = 30;
// Only a whole web address is worth a player; anything less would load and fail.
const playable = (url: string) => /^https?:\/\/[^\s/?#]+\S*$/i.test(url);
// The site an imported recipe came from, as people say it: "example.com".
const siteOf = (url: string) =>
  playable(url) ? /^https?:\/\/(?:www\.)?([^\s/?#:]+)/i.exec(url)?.[1] || '' : '';
/** How far an upload has got, with a way to stop it. */
function UploadProgress({ progress, onCancel }: { progress: number; onCancel: () => void }) {
  const { t: tr, number } = useI18n();
  const percent = Math.round(progress * 100);
  return (
    <View style={[s.row, { gap: 6 }]}>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={tr('Upload progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        style={{ flex: 1, gap: 8 }}
      >
        <Text style={s.small}>
          {tr('Uploading… {{v0}}', {
            v0: number(progress, { style: 'percent', maximumFractionDigits: 0 }),
          })}
        </Text>
        <View style={styles.track}>
          <View style={[styles.bar, { width: `${percent}%` }]} />
        </View>
      </View>
      <IconButton icon={X} plain label={tr('Cancel upload')} onPress={onCancel} />
    </View>
  );
}
// Minutes as typed, so "1." and "1,5" survive editing, kept as whole seconds. Seconds show as
// minutes to two places, which still come back to the same seconds.
const toMinutes = (seconds: number) => Math.round((seconds / 60) * 100) / 100;
function MinutesField({
  seconds,
  onChange,
}: {
  seconds: number;
  onChange: (seconds: number) => void;
}) {
  const { t: tr } = useI18n();
  const [minutes, setMinutes] = useState(() => toMinutes(seconds));
  // Follows changes from elsewhere (a restored draft, a removed step), and keeps what was typed
  // while it still comes to the same seconds.
  if (Math.round(minutes * 60) !== seconds) setMinutes(toMinutes(seconds));
  return (
    <NumberField
      label={tr('Timer in minutes (optional)')}
      value={minutes}
      placeholder="0"
      style={inset}
      onChange={(next) => {
        setMinutes(next);
        onChange(Math.round(next * 60));
      }}
    />
  );
}
// A small button on a gallery thumbnail: it looks small and answers to a 44 pt touch.
function ThumbButton({
  icon: Icon,
  label,
  onPress,
}: {
  icon: LucideIcon;
  label: string;
  onPress: () => void;
}) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={9}
      scale={0.9}
      style={styles.thumbButton}
    >
      <Icon size={11} color={color.ink} strokeWidth={1.9} />
    </Press>
  );
}
type EditorProps = {
  initial?: Recipe | RecipeInput;
  onPublished: (r: Recipe) => void;
  onAI: (r: AIRequest) => void;
};
export function Editor(props: EditorProps) {
  const { user } = useApp();
  const id = props.initial && 'id' in props.initial ? props.initial.id : 'new';
  return <EditorForm key={`${user?.id || 'guest'}.${id}`} {...props} />;
}
// A step's photo is `step n`, its clip `clip n`, n counting from 0.
type UploadTarget = 'cover' | 'gallery' | 'video' | `step ${number}` | `clip ${number}`;
function EditorForm({ initial, onPublished, onAI }: EditorProps) {
  const { t: tr, language: appLanguage } = useI18n();
  const app = useApp();
  const { desktop, compact } = useChrome();
  const id = initial && 'id' in initial ? initial.id : undefined;
  // What the editor starts from. A new recipe is in the app's language until the cook says
  // otherwise. A recipe from the server names its original, which only a new adaptation sends.
  const [start] = useState<RecipeInput>(() => {
    const opening = initial || emptyRecipe();
    const derivedFrom = typeof opening.derivedFrom === 'string' ? opening.derivedFrom : undefined;
    return {
      ...opening,
      derivedFrom,
      language: opening.language || (id ? '' : appLanguage),
    };
  });
  const [r, setR] = useState<RecipeInput>(start);
  const [busy, setBusy] = useState(false);
  // The upload under way and where it shows: picking (no progress yet), then sending.
  const [upload, setUpload] = useState<{ target: UploadTarget; progress: number | null } | null>(
    null,
  );
  const uploading = upload !== null;
  const transfer = useRef<AbortController | null>(null);
  // The photo being touched up: the cover, or an extra photo by its place in the gallery.
  const [touching, setTouching] = useState<'cover' | number | null>(null);
  const [error, setError] = useState('');
  const [draftReady, setDraftReady] = useState(false);
  // A device draft that differs from the recipe opened here, until the cook restores or discards it.
  const [stored, setStored] = useState<Partial<RecipeInput> | null>(null);
  const [remove, setRemove] = useState(false);
  const [choosingCuisine, setChoosingCuisine] = useState(false);
  const [choosingLanguage, setChoosingLanguage] = useState(false);
  // The step whose photo is coming from the camera or the library, on phones.
  const [stepSource, setStepSource] = useState<number | null>(null);
  const saved = useRef(false);
  // What was opened, to tell real changes from none. Each recipe being edited, each sous-chef
  // result and the one recipe started by hand keep a device draft of their own, so none of them
  // overwrites another.
  const [{ opened, name }] = useState(() => {
    const given = draftOf(initial || emptyRecipe());
    return { opened: draftOf(start), name: id || (initial ? `ai-${fingerprint(given)}` : 'new') };
  });
  const draftKey = `savorly.draft.${app.user?.id || 'guest'}.${name}`;
  const seeded = !!initial;
  useEffect(() => {
    let alive = true;
    AsyncStorage.getItem(draftKey)
      .then((value) => {
        if (!alive) return;
        const draft = readDraft(value);
        if (draft && draftOf({ ...start, ...draft }) !== opened) {
          // A recipe started by hand simply carries on; anything else asks first.
          if (seeded) setStored(draft);
          else setR((old) => ({ ...old, ...draft }));
        }
        setDraftReady(true);
      })
      .catch(() => {
        if (alive) setDraftReady(true);
      });
    return () => {
      alive = false;
    };
  }, [draftKey, seeded, start, opened]);
  // Who an adaptation credits: named by recipes from the server, looked up for a new one.
  const [origin, setOrigin] = useState(() =>
    initial?.derivedFrom && typeof initial.derivedFrom === 'object'
      ? { title: initial.derivedFrom.title, author: initial.derivedFrom.author?.name || '' }
      : null,
  );
  // An original that's gone (or private) can't be credited, so the save leaves it out.
  const [originGone, setOriginGone] = useState(false);
  const adapts = typeof r.derivedFrom === 'string' ? r.derivedFrom : '';
  useEffect(() => {
    if (!adapts) return;
    let alive = true;
    api<Recipe>(`/recipes/${encodeURIComponent(adapts)}`)
      .then((original) => {
        if (!alive) return;
        setOrigin({ title: original.title, author: original.author?.name || '' });
        setOriginGone(false);
      })
      .catch((e) => {
        if (alive && e instanceof ApiError && e.status === 404) setOriginGone(true);
      });
    return () => {
      alive = false;
    };
  }, [adapts]);
  // An upload still going when the editor closes stops there.
  useEffect(() => () => transfer.current?.abort(), []);
  // Writes wait for a pause in typing. Whatever is still waiting is written straight away when the
  // editor closes or the app goes to the background. No changes means no draft.
  const pending = useRef<{ key: string; value: string | null } | null>(null);
  const flush = useCallback(() => {
    const next = pending.current;
    pending.current = null;
    if (!next || saved.current) return;
    void (
      next.value === null
        ? AsyncStorage.removeItem(next.key)
        : AsyncStorage.setItem(next.key, next.value)
    ).catch(() =>
      setError(
        'This device could not save your local draft. You can still save it to your account.',
      ),
    );
  }, []);
  useEffect(() => {
    if (!draftReady || stored || !app.user) return;
    const value = draftOf(r);
    pending.current = { key: draftKey, value: value === opened ? null : value };
    const t = setTimeout(flush, 650);
    return () => clearTimeout(t);
  }, [r, draftReady, stored, draftKey, opened, app.user, flush]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') flush();
    });
    return () => {
      sub.remove();
      flush();
    };
  }, [flush]);
  const restore = () => {
    if (stored) setR((old) => ({ ...old, ...stored }));
    setStored(null);
  };
  const discard = () => {
    setStored(null);
    void AsyncStorage.removeItem(draftKey).catch(() => {});
  };
  // What's typed as a video address; the recipe and its preview take it on blur or return, so a
  // half-typed address never mounts a player.
  const [videoEntry, setVideoEntry] = useState({ value: r.video, text: r.video });
  if (videoEntry.value !== r.video) setVideoEntry({ value: r.video, text: r.video });
  const commitVideo = () => {
    const video = videoEntry.text.trim();
    if (video !== r.video) setR((old) => ({ ...old, video }));
  };
  const update = <K extends keyof RecipeInput>(key: K, value: RecipeInput[K]) =>
    setR((old) => ({ ...old, [key]: value }));
  const dish = r.title ? `Dish: ${r.title}. ${r.description}`.slice(0, 1500) : undefined;
  // One upload at a time: pick, prepare, then send with progress shown where it was asked for.
  const media = async (
    type: 'images' | 'videos',
    target: UploadTarget,
    apply: (url: string) => void,
    from: 'library' | 'camera' = 'library',
  ) => {
    // The ref answers at once, so a quick second tap can't start a second upload.
    if (transfer.current || !app.requireUser()) return;
    const controller = new AbortController();
    transfer.current = controller;
    setUpload({ target, progress: null });
    setError('');
    try {
      let picked: LocalMedia | null = null;
      if (from === 'camera') {
        const uri = await pickPhoto('camera');
        picked = uri ? { uri } : null;
      } else {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: type === 'images' ? ['images'] : ['videos'],
          quality: 1,
          ...(target.startsWith('clip') ? { videoMaxDuration: CLIP_SECONDS } : {}),
        });
        picked = result.canceled ? null : (result.assets[0] ?? null);
      }
      if (!picked || controller.signal.aborted) return;
      // Photos go up as JPEGs at most 2048 pixels on the long side, not as the camera took them.
      const file = type === 'images' ? await preparePhoto(picked.uri, { max: 2048 }) : picked;
      const url = await uploadMedia(file, type === 'images' ? 'image' : 'video', {
        signal: controller.signal,
        onProgress: (progress) =>
          setUpload((now) => (now?.target === target ? { target, progress } : now)),
      });
      apply(url);
    } catch (e) {
      // A cancelled upload, or an editor that closed, has nothing to report.
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      if (transfer.current === controller) {
        transfer.current = null;
        setUpload(null);
      }
    }
  };
  const cancelUpload = () => transfer.current?.abort();
  const progressFor = (target: UploadTarget) =>
    upload?.target === target && upload.progress !== null ? (
      <UploadProgress progress={upload.progress} onCancel={cancelUpload} />
    ) : null;
  const setStepPhoto = (n: number, image: string) =>
    setR((old) => ({
      ...old,
      steps: old.steps.map((x, k) => (k === n ? { ...x, image } : x)),
    }));
  // Phones choose between the camera and the library; a browser's file picker offers both.
  const addStepPhoto = (n: number) => {
    if (uploading) return;
    if (Platform.OS === 'web') void media('images', `step ${n}`, (url) => setStepPhoto(n, url));
    else setStepSource(n);
  };
  const stepPhotoFrom = (from: 'library' | 'camera') => {
    const n = stepSource;
    setStepSource(null);
    if (n !== null) void media('images', `step ${n}`, (url) => setStepPhoto(n, url), from);
  };
  const setStepClip = (n: number, video: string) =>
    setR((old) => ({
      ...old,
      steps: old.steps.map((x, k) => (k === n ? { ...x, video } : x)),
    }));
  // A clip comes from the library, as the recipe's video does.
  const addStepClip = (n: number) => {
    if (!uploading) void media('videos', `clip ${n}`, (url) => setStepClip(n, url));
  };
  // A step's photo or clip on its way lands by position, so the steps hold still meanwhile.
  const stepUpload = !!upload && /^(step|clip) /.test(upload.target);
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
      // A video address still being typed counts.
      const video = videoEntry.text.trim();
      // Only a new adaptation names its original; an edit leaves the saved link as it is.
      const { derivedFrom, ...rest } = r;
      const credit = !id && typeof derivedFrom === 'string' && derivedFrom && !originGone;
      const recipe = await api<Recipe>(id ? `/recipes/${id}` : '/recipes', {
        method: id ? 'PUT' : 'POST',
        body: { ...rest, video, published, ...(credit ? { derivedFrom } : {}) },
      });
      saved.current = true;
      await AsyncStorage.removeItem(draftKey).catch(() => {});
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
  const cover = () => void media('images', 'cover', (url) => update('image', url));
  const photos = r.photos || [];
  const canTouchUp = !!app.capabilities?.imageAI;
  // An imported recipe credits the page it came from, and links back to it.
  const sourceUrl = r.sourceUrl || '';
  const source = siteOf(sourceUrl);
  // Languages go by their own names, as in the language settings.
  const languageName =
    languages.find((option) => option.code === r.language)?.name ?? tr('Not set');
  // A touched-up photo is AI-edited media, so the recipe discloses AI help as generated ones do.
  const touchedUp = (url: string) =>
    setR((old) =>
      touching === 'cover'
        ? { ...old, image: url, aiGenerated: true }
        : {
            ...old,
            photos: (old.photos || []).map((p, k) => (k === touching ? url : p)),
            aiGenerated: true,
          },
    );
  const addPhoto = () =>
    void media('images', 'gallery', (url) =>
      setR((old) => ({ ...old, photos: [...(old.photos || []), url] })),
    );
  const photo = (
    <Section
      title={tr('Photos')}
      hint="The first is the cover; swipe-through extras follow it. JPEG, PNG or WebP you have permission to share."
    >
      <View>
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
                borderColor: color.outline,
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
        {/* Beside the cover rather than inside it: browsers don't allow a button in a button. */}
        {!!r.image && canTouchUp && (
          <Press
            accessibilityRole="button"
            accessibilityLabel={tr('Touch up the cover photo')}
            onPress={() => setTouching('cover')}
            scale={0.95}
            hitSlop={4}
            style={[s.row, styles.touch]}
          >
            <Sparkles size={15} color={color.white} strokeWidth={2.2} />
            <Text style={styles.touchText}>{tr('Touch up')}</Text>
          </Press>
        )}
      </View>
      <View style={[s.row, { gap: 8 }]}>
        <Button
          title={tr('Upload')}
          label={tr('Upload a photo')}
          icon={ImagePlus}
          variant="secondary"
          busy={upload?.target === 'cover'}
          disabled={uploading}
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
      {progressFor('cover')}
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
                  <ThumbButton
                    icon={X}
                    label={tr('Remove photo {{v0}}', { v0: n + 2 })}
                    onPress={() =>
                      update(
                        'photos',
                        photos.filter((_, k) => k !== n),
                      )
                    }
                  />
                </View>
                {canTouchUp && (
                  <View style={{ position: 'absolute', bottom: -6, right: -6 }}>
                    <ThumbButton
                      icon={Sparkles}
                      label={tr('Touch up photo {{v0}}', { v0: n + 2 })}
                      onPress={() => setTouching(n)}
                    />
                  </View>
                )}
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
                  borderColor: color.outline,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: uploading ? 0.5 : 1,
                }}
              >
                <Plus size={20} color={color.muted} strokeWidth={1.8} />
              </Pressable>
            )}
          </View>
          {progressFor('gallery')}
        </View>
      )}
    </Section>
  );
  const video = (
    <Section title={tr('Video')} hint="Optional. MP4 or WebM up to 50 MB, or a direct video link.">
      {playable(r.video) && <VideoPlayer uri={r.video} />}
      <View style={[s.row, { gap: 8 }]}>
        <Button
          title={tr('Upload')}
          label={tr('Upload a recipe video')}
          icon={Film}
          variant="secondary"
          busy={upload?.target === 'video'}
          disabled={uploading}
          style={{ flex: 1 }}
          onPress={() => void media('videos', 'video', (url) => update('video', url))}
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
      {progressFor('video')}
      <Field
        label={tr('Or use a direct video URL')}
        value={videoEntry.text}
        onChangeText={(text) => setVideoEntry({ value: r.video, text })}
        onBlur={commitVideo}
        onSubmitEditing={commitVideo}
        returnKeyType="done"
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
          {!!stored && (
            <View style={[s.card, { gap: 14 }]}>
              <View style={{ gap: 4 }}>
                <Text accessibilityRole="header" style={s.h3}>
                  {tr('Restore unsaved changes?')}
                </Text>
                <Text style={s.small}>
                  {tr('This device has changes to this recipe that weren’t saved to your account.')}
                </Text>
              </View>
              <View style={[s.row, { gap: 10 }]}>
                <Button
                  title={tr('Restore')}
                  icon={RotateCcw}
                  small
                  style={{ flex: 1 }}
                  onPress={restore}
                />
                <Button
                  title={tr('Discard')}
                  variant="secondary"
                  small
                  style={{ flex: 1 }}
                  onPress={discard}
                />
              </View>
            </View>
          )}
          {(!!source || (!!origin && !originGone)) && (
            <View style={[s.card, { paddingVertical: 6, gap: 0 }]}>
              {!!source && (
                <Press
                  accessibilityRole="link"
                  accessibilityLabel={tr('Imported from {{v0}}', { v0: source })}
                  onPress={() => void Linking.openURL(sourceUrl).catch(() => {})}
                  scale={0.98}
                  style={[s.row, { gap: 12, minHeight: 44 }]}
                >
                  <Link2 size={18} color={color.ink} strokeWidth={2} />
                  <Text style={[s.body, { flex: 1 }]} numberOfLines={2}>
                    {tr('Imported from {{v0}}', { v0: source })}
                  </Text>
                  <ExternalLink size={16} color={color.muted} strokeWidth={2} />
                </Press>
              )}
              {!!origin && !originGone && (
                <View style={[s.row, { gap: 12, minHeight: 44 }]}>
                  <GitFork size={18} color={color.ink} strokeWidth={2} />
                  <Text style={[s.body, { flex: 1 }]} numberOfLines={2}>
                    {origin.author
                      ? tr('Adapted from {{v0}} by {{v1}}', { v0: origin.title, v1: origin.author })
                      : tr('Adapted from {{v0}}', { v0: origin.title })}
                  </Text>
                </View>
              )}
            </View>
          )}
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
                <Text style={s.label}>{tr('Recipe language')}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={tr('Choose the recipe’s language, currently {{v0}}', {
                    v0: languageName,
                  })}
                  onPress={() => setChoosingLanguage(true)}
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
                  <View style={styles.languageIcon}>
                    <Languages size={18} color={color.ink} strokeWidth={1.9} />
                  </View>
                  <Text style={[s.body, { flex: 1, fontFamily: font.semibold }]}>
                    {languageName}
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
                          size={44}
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
              <Section
                title={tr('Method')}
                hint="Each step can have a photo and a short clip of up to 30 seconds."
              >
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
                        disabled={stepUpload}
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
                    <View style={[s.wrap, { gap: 14 }]}>
                      <View style={{ gap: 8 }}>
                        <Text style={styles.fieldLabel}>{tr('Step photo (optional)')}</Text>
                        {step.image ? (
                          <View style={{ alignSelf: 'flex-start' }}>
                            <FoodImage
                              uri={step.image}
                              label={tr('Photo for step {{v0}}', { v0: n + 1 })}
                              style={styles.stepPhoto}
                            />
                            <View style={{ position: 'absolute', top: -6, right: -6 }}>
                              <ThumbButton
                                icon={X}
                                label={tr('Remove the photo for step {{v0}}', { v0: n + 1 })}
                                onPress={() => setStepPhoto(n, '')}
                              />
                            </View>
                            <View style={{ position: 'absolute', bottom: -6, right: -6 }}>
                              <ThumbButton
                                icon={RefreshCw}
                                label={tr('Replace the photo for step {{v0}}', { v0: n + 1 })}
                                onPress={() => addStepPhoto(n)}
                              />
                            </View>
                          </View>
                        ) : (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={tr('Add a photo for step {{v0}}', { v0: n + 1 })}
                            accessibilityState={{
                              disabled: uploading,
                              busy: upload?.target === `step ${n}`,
                            }}
                            disabled={uploading}
                            onPress={() => addStepPhoto(n)}
                            style={[
                              styles.stepPhoto,
                              styles.emptyPhoto,
                              { opacity: uploading && upload?.target !== `step ${n}` ? 0.5 : 1 },
                            ]}
                          >
                            {upload?.target === `step ${n}` ? (
                              <ActivityIndicator color={color.ink} />
                            ) : (
                              <>
                                <ImagePlus size={20} color={color.muted} strokeWidth={1.8} />
                                <Text style={s.small}>{tr('Add a photo')}</Text>
                              </>
                            )}
                          </Pressable>
                        )}
                      </View>
                      <View style={{ gap: 8 }}>
                        <Text style={styles.fieldLabel}>{tr('Step clip (optional)')}</Text>
                        {step.video ? (
                          <View style={{ alignSelf: 'flex-start' }}>
                            <StepClip
                              key={step.video}
                              uri={step.video}
                              step={n + 1}
                              fit="cover"
                              style={styles.stepPhoto}
                            />
                            <View style={{ position: 'absolute', top: -6, right: -6 }}>
                              <ThumbButton
                                icon={X}
                                label={tr('Remove the clip for step {{v0}}', { v0: n + 1 })}
                                onPress={() => setStepClip(n, '')}
                              />
                            </View>
                            <View style={{ position: 'absolute', bottom: -6, right: -6 }}>
                              <ThumbButton
                                icon={RefreshCw}
                                label={tr('Replace the clip for step {{v0}}', { v0: n + 1 })}
                                onPress={() => addStepClip(n)}
                              />
                            </View>
                          </View>
                        ) : (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={tr('Add a clip to step {{v0}}', { v0: n + 1 })}
                            accessibilityState={{
                              disabled: uploading,
                              busy: upload?.target === `clip ${n}`,
                            }}
                            disabled={uploading}
                            onPress={() => addStepClip(n)}
                            style={[
                              styles.stepPhoto,
                              styles.emptyPhoto,
                              { opacity: uploading && upload?.target !== `clip ${n}` ? 0.5 : 1 },
                            ]}
                          >
                            {upload?.target === `clip ${n}` ? (
                              <ActivityIndicator color={color.ink} />
                            ) : (
                              <>
                                <Film size={20} color={color.muted} strokeWidth={1.8} />
                                <Text style={s.small}>{tr('Add a clip')}</Text>
                              </>
                            )}
                          </Pressable>
                        )}
                      </View>
                    </View>
                    {progressFor(`step ${n}`)}
                    {progressFor(`clip ${n}`)}
                    <MinutesField
                      seconds={step.seconds}
                      onChange={(seconds) => setStep(n, { seconds })}
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
                aria-checked={r.aiGenerated}
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
                    borderColor: r.aiGenerated ? color.ink : color.outline,
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
      <Dialog
        visible={choosingLanguage}
        onClose={() => setChoosingLanguage(false)}
        title={tr('Recipe language')}
      >
        <Text style={s.muted}>
          {tr('The language this recipe is written in. Cooking mode reads its steps aloud in it.')}
        </Text>
        {languages.map((option) => {
          const chosen = r.language === option.code;
          return (
            <Press
              key={option.code}
              accessibilityRole="radio"
              aria-checked={chosen}
              accessibilityLabel={option.name}
              accessibilityState={{ checked: chosen }}
              onPress={() => {
                update('language', option.code);
                setChoosingLanguage(false);
              }}
              style={[
                s.row,
                styles.languageOption,
                { backgroundColor: chosen ? color.subtle : color.white },
              ]}
            >
              <Text style={[s.body, { flex: 1 }]}>{option.name}</Text>
              {chosen && <Check size={20} color={color.ink} />}
            </Press>
          );
        })}
      </Dialog>
      <Dialog
        visible={stepSource !== null}
        onClose={() => setStepSource(null)}
        title={tr('Photo for step {{v0}}', { v0: (stepSource ?? 0) + 1 })}
      >
        <View style={[s.row, { gap: 10 }]}>
          <Button
            title={tr('Take a photo')}
            icon={Camera}
            variant="secondary"
            style={{ flex: 1 }}
            onPress={() => stepPhotoFrom('camera')}
          />
          <Button
            title={tr('Choose a photo')}
            icon={Images}
            variant="secondary"
            style={{ flex: 1 }}
            onPress={() => stepPhotoFrom('library')}
          />
        </View>
      </Dialog>
      <PhotoTouchUp
        uri={touching === null ? null : touching === 'cover' ? r.image : photos[touching] || null}
        onClose={() => setTouching(null)}
        onUse={touchedUp}
      />
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
                derivedFrom: null,
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
const styles = StyleSheet.create({
  touch: {
    position: 'absolute',
    right: 12,
    bottom: 12,
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(13,13,13,0.72)',
  },
  touchText: { color: color.white, fontFamily: font.bold, fontSize: 13 },
  thumbButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: color.outline,
    backgroundColor: color.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fieldLabel: { fontFamily: font.semibold, fontSize: 13, color: color.muted },
  stepPhoto: { width: 128, height: 96, borderRadius: radius.sm },
  emptyPhoto: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: color.outline,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  track: { height: 4, borderRadius: 2, backgroundColor: color.subtle, overflow: 'hidden' },
  bar: { height: '100%', backgroundColor: color.ink },
  languageIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  languageOption: { gap: 12, padding: 14, minHeight: 52, borderRadius: 16 },
});
