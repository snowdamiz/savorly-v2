import { useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Platform,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import {
  AudioLines,
  Camera,
  Check,
  ChefHat,
  Eye,
  ImagePlus,
  Mic,
  MicOff,
  Minimize2,
  Plus,
  Send,
  Square,
  Video,
  Volume2,
  X,
} from 'lucide-react-native';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import {
  AppAction,
  Recipe,
  StudioContext,
  StudioEvent,
  StudioMode,
  StudioProject,
} from '../lib/types';
import { color, radius, s } from '../lib/theme';
import { Button, Dialog, FoodImage, IconButton, Pill, Press, useChrome } from './ui';
import { RecipeCamera } from './RecipeCamera';
import { openVoice } from '../lib/voice/transport';
import { VoiceConnection, VoiceEvent } from '../lib/voice/connection';

function requestKey() {
  return (
    globalThis.crypto?.randomUUID?.() ||
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      return (c === 'x' ? r : (r & 3) | 8).toString(16);
    })
  );
}
function mergeEvents(events: StudioEvent[]) {
  const groups: StudioEvent[] = [];
  for (const event of events) {
    const prev = groups[groups.length - 1];
    if (prev?.role === event.role && !event.imageCount && !prev.imageCount) {
      prev.content += event.content;
      if (event.recipes?.length) prev.recipes = [...(prev.recipes || []), ...event.recipes];
    } else groups.push({ ...event });
  }
  return groups;
}
const suggestions = [
  'Find me a quick dinner',
  'Plan my dinners for this week',
  'What can I make with my pantry?',
  'Help me create a recipe',
];
// What's on screen suggests what to ask.
const recipeSuggestions = [
  'Make this vegetarian',
  'Add this to my grocery list',
  'What should I serve with it?',
  'Can I make it ahead?',
];
const cookingSuggestions = [
  'How do I know this step is done?',
  'I don’t have the right pan',
  'Something went wrong — can I fix it?',
];
// A conversation this recent is picked up again; older ones stay in the history row.
const RESUME_MS = 6 * 60 * 60 * 1000;
const timeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
})();
// The sous-chef: one conversation for anything in the app, typed, spoken live, or from a photo.
export function RecipeStudio({
  initialMode,
  hidden,
  onHide,
  context,
  onAction,
  onChanged,
  onClose,
  onRecipe,
}: {
  initialMode: StudioMode;
  /** Minimized: the sheet is away but a live voice conversation keeps going. */
  hidden: boolean;
  onHide: (hidden: boolean) => void;
  context: StudioContext;
  onAction: (action: AppAction) => void;
  /** A reply arrived that may have changed lists, cookbooks or the open recipe. */
  onChanged: () => void;
  onClose: () => void;
  onRecipe: (recipe: Recipe) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const { compact, insets, width } = useChrome();
  const [project, setProject] = useState<StudioProject | null>(null);
  const [events, setEvents] = useState<StudioEvent[]>([]);
  const [history, setHistory] = useState<StudioProject[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(initialMode === 'photo');
  const [attachment, setAttachment] = useState<{ id: string; uri: string } | null>(null);
  const [voiceState, setVoiceState] = useState<
    'off' | 'connecting' | 'listening' | 'working' | 'paused'
  >('off');
  const [muted, setMuted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [caption, setCaption] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [inputHeight, setInputHeight] = useState(40);
  const connection = useRef<VoiceConnection | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const live = useRef(true);
  const projectRef = useRef<StudioProject | null>(null);
  const cursor = useRef(0);
  const list = useRef<ScrollView>(null);
  const pending = useRef<{ key: string; text: string; images: string[] } | null>(null);
  const autoStarted = useRef(false);
  const renewal = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Screen actions run only for replies that arrive while open, never for old history.
  const loaded = useRef(false);
  const contextSent = useRef<Promise<void> | null>(null);
  const handlers = useRef<{ changed: () => void; act: (action: AppAction) => void }>({
    changed: () => {},
    act: () => {},
  });
  const runningVoice = voiceState !== 'off';
  useEffect(() => {
    if (!runningVoice) return;
    const tag = 'savorly-voice-' + requestKey();
    let active = true;
    void activateKeepAwakeAsync(tag)
      .then(() => {
        if (!active) void deactivateKeepAwake(tag).catch(() => {});
      })
      .catch(() => {});
    return () => {
      active = false;
      void deactivateKeepAwake(tag).catch(() => {});
    };
  }, [runningVoice]);
  const stop = useCallback(async () => {
    clearTimeout(renewal.current);
    attempt.current?.abort();
    attempt.current = null;
    const current = connection.current;
    connection.current = null;
    setVoiceState('off');
    setMuted(false);
    await current?.close();
  }, []);
  const refresh = useCallback(async (id: string) => {
    const [next, incoming] = await Promise.all([
      api<StudioProject>(`/recipe-studio/${id}`),
      api<StudioEvent[]>(`/recipe-studio/${id}/events?after=${cursor.current}`),
    ]);
    if (!live.current || projectRef.current?.id !== id) return;
    projectRef.current = next;
    setProject(next);
    if (incoming.length) {
      cursor.current = incoming[incoming.length - 1].seq;
      setEvents((old) => [...old, ...incoming.filter((e) => !old.some((p) => p.seq === e.seq))]);
      const replies = incoming.filter((e) => e.role === 'assistant');
      if (replies.length) handlers.current.changed();
      if (loaded.current) replies.forEach((e) => e.actions?.forEach(handlers.current.act));
    }
    // A full page means older history is still draining.
    if (incoming.length < 1000) loaded.current = true;
  }, []);
  const selectProject = useCallback(
    async (next: StudioProject) => {
      await stop();
      cursor.current = 0;
      setEvents([]);
      setAttachment(null);
      setCaption('');
      setError('');
      setText('');
      pending.current = null;
      loaded.current = false;
      projectRef.current = next;
      setProject(next);
      await refresh(next.id);
    },
    [refresh, stop],
  );
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const next = await api<StudioProject>('/recipe-studio', {
        method: 'POST',
        headers: { 'Idempotency-Key': requestKey() },
      });
      await selectProject(next);
      setHistory((old) => [next, ...old]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    live.current = true;
    void api<StudioProject[]>('/recipe-studio')
      .then(async (items) => {
        if (!live.current) return;
        setHistory(items);
        const resumable = items.find((p) => Date.now() - Date.parse(p.updatedAt) < RESUME_MS);
        if (resumable) await selectProject(resumable);
        else {
          const next = await api<StudioProject>('/recipe-studio', {
            method: 'POST',
            headers: { 'Idempotency-Key': requestKey() },
          });
          if (live.current) await selectProject(next);
        }
      })
      .catch((e) => {
        if (live.current) setError(e.message);
      });
    return () => {
      live.current = false;
      clearTimeout(renewal.current);
      attempt.current?.abort();
      void connection.current?.close();
    };
  }, [selectProject]);
  useEffect(() => {
    if (!project?.id) return;
    let done = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh(project.id);
      } catch (e) {
        if (!done) setError((e as Error).message);
      } finally {
        if (!done) timeout = setTimeout(() => void poll(), 1800);
      }
    };
    timeout = setTimeout(() => void poll(), 1200);
    return () => {
      done = true;
      clearTimeout(timeout);
    };
  }, [project?.id, refresh]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') {
        void stop();
        setCamera(false);
      }
    });
    const hidden = () => {
      if (document.hidden) {
        void stop();
        setCamera(false);
      }
    };
    if (Platform.OS === 'web') document.addEventListener('visibilitychange', hidden);
    return () => {
      sub.remove();
      if (Platform.OS === 'web') document.removeEventListener('visibilitychange', hidden);
    };
  }, [stop]);
  // The conversation follows what the user has open, and their clock.
  const { screen, cookingStep } = context;
  const viewing = context.recipe?.id;
  useEffect(() => {
    if (!project?.id) return;
    contextSent.current = api(`/recipe-studio/${project.id}/context`, {
      method: 'PUT',
      body: { screen, recipeId: viewing || '', cookingStep: cookingStep || 0, timeZone },
    }).catch(() => {});
  }, [project?.id, screen, viewing, cookingStep]);
  useEffect(() => {
    handlers.current = {
      changed: onChanged,
      act: (action) => {
        // Live voice keeps talking from a minimized pill; a typed chat steps aside.
        if (action.type !== 'set_language') {
          if (connection.current) onHide(true);
          else {
            void stop();
            onClose();
          }
        }
        onAction(action);
      },
    };
  });
  useEffect(() => {
    if (!runningVoice) return;
    const tick = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(tick);
  }, [runningVoice]);
  useEffect(() => {
    const session = project?.voiceSession;
    if (session?.id === connection.current?.id && session?.status === 'interrupted') {
      setError('The voice connection was interrupted. Resume to continue, or switch to text.');
      void stop();
    }
  }, [project?.voiceSession, stop]);
  const startVoice = async () => {
    if (!projectRef.current || attempt.current) return;
    if (!app.capabilities?.voiceAI) {
      setError(
        'Voice isn’t connected yet. You can use text or photos when the recipe assistant is connected.',
      );
      return;
    }
    setError('');
    setCaption('');
    setSeconds(0);
    setVoiceState('connecting');
    setAudioBlocked(false);
    const controller = new AbortController();
    attempt.current = controller;
    const event = (ev: VoiceEvent) => {
      if (!live.current || controller.signal.aborted) return;
      if (ev.type === 'session.started') setVoiceState('listening');
      if (
        ev.type === 'session.input_transcript.delta' ||
        ev.type === 'session.output_transcript.delta'
      ) {
        setCaption((old) => (old + (ev.delta || '')).slice(-320));
        setVoiceState(ev.type.includes('input_') ? 'listening' : 'working');
      }
      if (ev.type === 'connection.failed' || ev.type === 'error') {
        setError(
          'The voice connection was interrupted. Your saved conversation is ready to resume.',
        );
        void stop();
      }
      if (
        ev.type === 'connection.renew' ||
        (ev.type === 'session.closed' && ev.reason === 'expired')
      ) {
        void stop().then(() => {
          if (!live.current) return;
          setCaption('Reconnecting. Hold that thought…');
          // Give the sideband time to finalize the prior lease before the next handshake.
          renewal.current = setTimeout(() => {
            if (live.current) void startVoice();
          }, 600);
        });
      } else if (ev.type === 'session.closed') {
        void stop();
      }
    };
    try {
      const c = await openVoice({
        projectId: projectRef.current.id,
        signal: controller.signal,
        onEvent: event,
        onAudioBlocked: () => setAudioBlocked(true),
      });
      if (controller.signal.aborted) await c.close();
      else connection.current = c;
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(
          (e as Error).name === 'NotAllowedError'
            ? 'Microphone permission wasn’t granted. Enable it in settings, or continue by text.'
            : (e as Error).message,
        );
        await stop();
      }
    }
  };
  useEffect(() => {
    if (initialMode === 'voice' && project && !autoStarted.current) {
      autoStarted.current = true;
      void startVoice();
    }
    // One automatic start from the user's explicit Speak action; subsequent starts are deliberate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);
  const send = async (message = text, image = attachment, fromUpload = false) => {
    if (!project || (busy && !fromUpload) || project.busy || (!message.trim() && !image)) return;
    const value =
      message.trim() ||
      tr(
        'Here’s a photo. If it’s a recipe, make it into a complete recipe and ask about anything unclear. Otherwise, tell me what I could cook with it.',
      );
    const images = image ? [image.id] : [];
    if (
      pending.current?.text !== value ||
      JSON.stringify(pending.current.images) !== JSON.stringify(images)
    )
      pending.current = { key: requestKey(), text: value, images };
    setBusy(true);
    setError('');
    try {
      await contextSent.current;
      await api(`/recipe-studio/${project.id}/messages`, {
        method: 'POST',
        body: { text: value, images },
        headers: { 'Idempotency-Key': pending.current.key },
      });
      setText('');
      setAttachment(null);
      pending.current = null;
      await refresh(project.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const upload = async (uri: string) => {
    if (!project) return;
    setCamera(false);
    setBusy(true);
    setError('');
    try {
      const context = ImageManipulator.manipulate(uri);
      let rendered = await context.renderAsync();
      if (rendered.width > 2048) {
        rendered.release();
        context.resize({ width: 2048 });
        rendered = await context.renderAsync();
      }
      const result = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 });
      rendered.release();
      context.release();
      const form = new FormData();
      if (Platform.OS === 'web')
        form.append('file', await (await fetch(result.uri)).blob(), 'recipe.jpg');
      else
        form.append('file', {
          uri: result.uri,
          name: 'recipe.jpg',
          type: 'image/jpeg',
        } as unknown as Blob);
      const image = await api<{ id: string }>(`/recipe-studio/${project.id}/images`, {
        method: 'POST',
        body: form,
      });
      const attached = { id: image.id, uri: result.uri };
      setAttachment(attached);
      await send(text, attached, true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 1,
      });
      if (!result.canceled) await upload(result.assets[0].uri);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const exit = () => {
    void stop();
    void Promise.all([app.refreshPrivate(), app.refreshRecipes()]);
    onClose();
  };
  const openRecipe = async (id: string) => {
    try {
      const recipe = await api<Recipe>(`/recipes/${encodeURIComponent(id)}`);
      exit();
      onRecipe(recipe);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const ready = !!project && !busy && !project.busy;
  const groups = mergeEvents(events);
  const nearby = context.recipe
    ? context.cookingStep
      ? cookingSuggestions
      : recipeSuggestions
    : [];
  return (
    <>
      {hidden && (
        <View
          style={{
            position: 'absolute',
            right: compact ? (width - Math.min(width - 32, 400)) / 2 : 28,
            bottom: compact ? Math.max(16, insets.bottom) + 82 : 28,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            padding: 5,
            paddingLeft: 6,
            borderRadius: radius.pill,
            backgroundColor: color.ink,
            borderWidth: 1,
            borderColor: color.glassBorder,
            boxShadow: '0px 14px 40px rgba(0,0,0,0.28)',
          }}
        >
          <Press
            accessibilityRole="button"
            accessibilityLabel={tr('Back to conversation')}
            onPress={() => onHide(false)}
            style={[s.row, { gap: 9, paddingHorizontal: 10, height: 44 }]}
          >
            {runningVoice && !muted ? (
              <Mic size={18} color={color.white} />
            ) : (
              <MicOff size={18} color={color.white} />
            )}
            <Text style={{ ...s.h3, color: color.white }}>
              {runningVoice ? tr('Listening…') : tr('Sous-chef')}
            </Text>
          </Press>
          <IconButton
            icon={X}
            dark
            size={40}
            label={runningVoice ? tr('End voice') : tr('Close the sous-chef')}
            onPress={runningVoice ? () => void stop() : exit}
          />
        </View>
      )}
      <Dialog
        visible={!hidden}
        onClose={exit}
        title={camera ? tr('Take a photo') : tr('Sous-chef')}
      >
        {camera ? (
          <RecipeCamera onPhoto={(uri) => void upload(uri)} onCancel={() => setCamera(false)} />
        ) : (
          <>
            {runningVoice && (
              <View
                style={{
                  borderRadius: radius.lg,
                  backgroundColor: color.ink,
                  padding: 20,
                  gap: 14,
                }}
              >
                <View style={[s.row, { gap: 14 }]}>
                  <View
                    style={{
                      width: 56,
                      height: 56,
                      borderRadius: 28,
                      borderWidth: 1,
                      borderColor: color.glassBorder,
                      backgroundColor: color.ink2,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {voiceState === 'connecting' ? (
                      <ActivityIndicator color={color.white} />
                    ) : muted ? (
                      <MicOff size={24} color={color.white} />
                    ) : (
                      <Mic size={24} color={color.white} strokeWidth={1.5} />
                    )}
                  </View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text accessibilityLiveRegion="polite" style={{ ...s.h3, color: color.white }}>
                      {voiceState === 'connecting'
                        ? tr('Connecting your sous-chef…')
                        : muted
                          ? tr('Microphone paused')
                          : tr('I’m listening. Take your time.')}
                    </Text>
                    <Text style={{ ...s.small, color: color.onInk }}>
                      {tr('Talk naturally. Interrupt or correct me anytime.')}
                    </Text>
                  </View>
                </View>
                {!!caption && <Text style={{ ...s.body, color: color.white }}>{caption}</Text>}
                <View style={[s.row, { gap: 12 }]}>
                  <IconButton
                    icon={muted ? Mic : MicOff}
                    label={muted ? tr('Resume microphone') : tr('Mute microphone')}
                    disabled={voiceState === 'connecting'}
                    onPress={() => {
                      connection.current?.mute(!muted);
                      setMuted(!muted);
                    }}
                  />
                  <Button
                    title={tr('End voice')}
                    icon={Square}
                    small
                    variant="secondary"
                    onPress={() => void stop()}
                  />
                  <Text style={{ ...s.small, color: color.onInk, flex: 1 }}>
                    {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
                  </Text>
                  <IconButton
                    icon={Minimize2}
                    label={tr('Keep talking while you browse')}
                    onPress={() => onHide(true)}
                  />
                </View>
                {audioBlocked && (
                  <Button
                    title={tr('Enable assistant audio')}
                    icon={Volume2}
                    small
                    variant="secondary"
                    onPress={() =>
                      void connection.current
                        ?.enableAudio()
                        .then(() => setAudioBlocked(false))
                        .catch(() =>
                          setError('Audio playback is blocked in your browser settings.'),
                        )
                    }
                  />
                )}
                <Text style={{ ...s.small, color: color.onInk }}>
                  {tr('Voice is processed live. We save your transcript, not an audio recording.')}
                </Text>
              </View>
            )}
            <ScrollView
              ref={list}
              nestedScrollEnabled
              style={{ maxHeight: runningVoice ? 220 : 380 }}
              onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
              contentContainerStyle={{ gap: 12 }}
            >
              {!groups.length && !runningVoice && (
                <View style={{ paddingVertical: 14, gap: 10 }}>
                  <ChefHat size={28} color={color.ink} />
                  <Text style={s.h2}>{tr('How can I help in the kitchen?')}</Text>
                  <Text style={s.muted}>
                    {tr(
                      'Find recipes, plan meals, sort out your shopping, or create a recipe together. Type, add a photo, or talk live.',
                    )}
                  </Text>
                  <View style={s.wrap}>
                    {(nearby.length ? [] : suggestions).map((phrase) => (
                      <Button
                        key={phrase}
                        title={tr(phrase)}
                        small
                        variant="secondary"
                        disabled={!ready}
                        onPress={() => void send(tr(phrase), null)}
                      />
                    ))}
                  </View>
                </View>
              )}
              {groups.map((event) => (
                <View
                  key={event.seq}
                  style={{
                    alignSelf: event.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '92%',
                    padding: 15,
                    borderRadius: radius.md,
                    backgroundColor: event.role === 'user' ? color.ink : color.white,
                    gap: 5,
                  }}
                >
                  <Text
                    style={{
                      ...s.small,
                      color: event.role === 'user' ? color.onInk : color.muted,
                    }}
                  >
                    {event.role === 'user' ? tr('You') : tr('Sous-chef')}
                    {event.imageCount ? tr(' · {{v0}} recipe photo', { v0: event.imageCount }) : ''}
                  </Text>
                  <Text
                    selectable
                    style={{ ...s.body, color: event.role === 'user' ? color.white : color.ink }}
                  >
                    {event.content}
                  </Text>
                  {!!event.recipes?.length && (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={{ gap: 10, paddingTop: 6 }}
                    >
                      {event.recipes.map((r) => (
                        <Press
                          key={r.id}
                          accessibilityRole="button"
                          accessibilityLabel={tr('Open {{v0}}', { v0: r.title })}
                          onPress={() => void openRecipe(r.id)}
                          style={{ width: 148, gap: 6 }}
                        >
                          <FoodImage
                            uri={r.image}
                            style={{ width: 148, height: 104, borderRadius: radius.sm }}
                          />
                          <Text numberOfLines={2} style={s.h3}>
                            {r.title}
                          </Text>
                          <Text style={s.small}>{tr('{{v0}} min', { v0: r.minutes })}</Text>
                        </Press>
                      ))}
                    </ScrollView>
                  )}
                </View>
              ))}
              {project?.busy && (
                <View style={[s.row, { gap: 9, padding: 10 }]}>
                  <ActivityIndicator size="small" color={color.ink} />
                  <Text accessibilityLiveRegion="polite" style={s.muted}>
                    {tr('Your sous-chef is working…')}
                  </Text>
                </View>
              )}
            </ScrollView>
            <View style={{ gap: 10 }}>
              {attachment && (
                <View style={[s.row, { gap: 12 }]}>
                  <FoodImage
                    uri={attachment.uri}
                    style={{ width: 60, height: 74, borderRadius: radius.sm }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={s.h3}>{tr('Recipe photo attached')}</Text>
                    <Text style={s.small}>{tr('Add a note or send it as it is.')}</Text>
                  </View>
                  <IconButton
                    icon={X}
                    label={tr('Remove attached recipe photo')}
                    onPress={() => setAttachment(null)}
                  />
                </View>
              )}
              {context.recipe && (
                <View style={{ gap: 8 }}>
                  <View style={[s.row, { gap: 6 }]}>
                    <Eye size={15} color={color.muted} />
                    <Text numberOfLines={1} style={[s.small, { flex: 1 }]}>
                      {context.cookingStep
                        ? tr('Cooking {{v0}} · step {{v1}}', {
                            v0: context.recipe.title,
                            v1: context.cookingStep,
                          })
                        : tr('Viewing {{v0}}', { v0: context.recipe.title })}
                    </Text>
                  </View>
                  {!runningVoice && (
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      contentContainerStyle={{ gap: 8 }}
                    >
                      {nearby.map((phrase) => (
                        <Button
                          key={phrase}
                          title={tr(phrase)}
                          small
                          variant="secondary"
                          disabled={!ready}
                          onPress={() => void send(tr(phrase), null)}
                        />
                      ))}
                    </ScrollView>
                  )}
                </View>
              )}
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'flex-end',
                  gap: 2,
                  padding: 6,
                  backgroundColor: color.white,
                  borderRadius: 26,
                  borderWidth: 1,
                  borderColor: color.border,
                }}
              >
                <IconButton
                  icon={Camera}
                  label={tr('Take a photo')}
                  plain
                  size={40}
                  onPress={() => setCamera(true)}
                  disabled={!project || busy}
                />
                <IconButton
                  icon={ImagePlus}
                  label={tr('Add a photo')}
                  plain
                  size={40}
                  onPress={() => void pick()}
                  disabled={!project || busy}
                />
                <TextInput
                  accessibilityLabel={tr('Message your sous-chef')}
                  placeholder={attachment ? tr('Add a note (optional)…') : tr('Ask anything…')}
                  placeholderTextColor={color.soft}
                  value={text}
                  onChangeText={setText}
                  multiline
                  // One line until it needs more; the web textarea doesn't grow on its own.
                  numberOfLines={1}
                  onContentSizeChange={(e) =>
                    setInputHeight(Math.ceil(e.nativeEvent.contentSize.height))
                  }
                  maxLength={24000}
                  style={{
                    ...s.body,
                    flex: 1,
                    minHeight: 40,
                    maxHeight: 132,
                    height:
                      Platform.OS === 'web' ? Math.min(132, Math.max(40, inputHeight)) : undefined,
                    paddingHorizontal: 6,
                    paddingVertical: 10,
                    lineHeight: 20,
                  }}
                />
                {text.trim() || attachment || runningVoice ? (
                  <IconButton
                    icon={Send}
                    label={tr('Send message')}
                    selected
                    size={40}
                    disabled={!ready || (!text.trim() && !attachment)}
                    onPress={() => void send()}
                  />
                ) : (
                  <Button
                    title={tr('Talk')}
                    label={tr('Start live conversation')}
                    icon={AudioLines}
                    small
                    disabled={!project}
                    onPress={() => void startVoice()}
                  />
                )}
              </View>
              {project?.recipe && (
                <View style={s.wrap}>
                  {['Read it back', 'Publish'].map((phrase) => (
                    <Button
                      key={phrase}
                      title={tr(phrase)}
                      small
                      variant="ghost"
                      disabled={!ready}
                      onPress={() => void send(tr(phrase), null)}
                    />
                  ))}
                </View>
              )}
            </View>
            {!!error && (
              <Text accessibilityRole="alert" style={{ ...s.muted, color: color.error }}>
                {tr(error)}
              </Text>
            )}
            {!!project?.error && project.error !== error && (
              <Text accessibilityRole="alert" style={{ ...s.muted, color: color.error }}>
                {tr(project.error)}
              </Text>
            )}
            {busy && <ActivityIndicator color={color.ink} />}
            {project?.recipe && (
              <View style={[s.card, { gap: 14 }]}>
                <View style={[s.row, { gap: 14 }]}>
                  {!!project.recipe.image && (
                    <FoodImage
                      uri={project.recipe.image}
                      style={{ width: 76, height: 88, borderRadius: radius.md }}
                    />
                  )}
                  <View style={{ flex: 1, gap: 6 }}>
                    <Pill
                      title={project.recipe.published ? tr('Published') : tr('Private draft saved')}
                      icon={Check}
                    />
                    <Text style={s.h2}>{project.recipe.title}</Text>
                    <Text style={s.small}>
                      {tr('{{v0}} min · {{v1}} servings · {{v2}} ingredients', {
                        v0: project.recipe.minutes,
                        v1: project.recipe.servings,
                        v2: project.recipe.ingredients.length,
                      })}
                    </Text>
                  </View>
                </View>
                {project.assets.map((asset) => (
                  <View key={asset.kind} style={{ gap: 4 }}>
                    <View style={[s.row, { gap: 8 }]}>
                      {asset.kind === 'image' ? (
                        <ImagePlus size={17} color={color.ink} />
                      ) : (
                        <Video size={17} color={color.ink} />
                      )}
                      <Text style={[s.body, { flex: 1 }]}>
                        {asset.kind === 'image' ? tr('AI cover photo') : tr('AI recipe video')}
                      </Text>
                      <Text style={s.small}>
                        {asset.status === 'completed'
                          ? tr('Ready')
                          : asset.status === 'failed'
                            ? tr('Needs attention')
                            : tr('Creating…')}
                      </Text>
                    </View>
                    {asset.status === 'failed' && <Text style={s.muted}>{tr(asset.error)}</Text>}
                  </View>
                ))}
                <View style={[s.row, { gap: 8 }]}>
                  <Button
                    title={tr('Open recipe')}
                    small
                    onPress={() => {
                      exit();
                      onRecipe(project.recipe!);
                    }}
                  />
                  {project.assets.some((a) => a.status === 'failed') && (
                    <Button
                      title={tr('Retry media')}
                      small
                      variant="secondary"
                      disabled={project.busy || busy}
                      onPress={() =>
                        void send(
                          tr(
                            'Retry the failed media generation. I understand it may incur a new generation charge.',
                          ),
                          null,
                        )
                      }
                    />
                  )}
                </View>
                <Text style={s.small}>
                  {tr('Media keeps creating when you close this conversation.')}
                </Text>
              </View>
            )}
            <View style={[s.between, { gap: 8 }]}>
              <Text style={[s.small, { flex: 1 }]}>
                {tr('Your conversation saves automatically.')}
              </Text>
              <Button
                title={tr('New chat')}
                icon={Plus}
                small
                variant="ghost"
                disabled={busy || runningVoice}
                onPress={() => void create()}
              />
            </View>
            {history.filter((p) => p.id !== project?.id).length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 8 }}
              >
                {history
                  .filter((p) => p.id !== project?.id)
                  .map((p) => (
                    <Button
                      key={p.id}
                      title={p.recipe?.title || p.title || tr('Earlier conversation')}
                      small
                      variant="secondary"
                      onPress={() => void selectProject(p).catch((e) => setError(e.message))}
                    />
                  ))}
              </ScrollView>
            )}
          </>
        )}
      </Dialog>
    </>
  );
}
