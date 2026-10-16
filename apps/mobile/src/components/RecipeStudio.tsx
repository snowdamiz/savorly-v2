import { useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  Platform,
  ScrollView,
  StyleSheet,
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
  ChevronDown,
  ChevronRight,
  Eye,
  History,
  ImagePlus,
  Mic,
  MicOff,
  Send,
  Sparkles,
  Square,
  SquarePen,
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
import { color, radius, s, shadow } from '../lib/theme';
import { useKeyboardLift } from '../lib/keyboard';
import { Button, FoodImage, IconButton, Pill, Press, animate, useChrome } from './ui';
import { RecipeCamera } from './RecipeCamera';
import { fileForm } from '../lib/photos';
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
// The sous-chef's corner: its launcher sits here, and the panel pops out of it over the page.
export function useSousChefDock() {
  const { compact, width, height, insets } = useChrome();
  const bar = Math.min(width - 32, 400);
  const right = compact ? (width - bar) / 2 : 28;
  // Phones keep it above the tab bar.
  const bottom = compact ? Math.max(16, insets.bottom) + 82 : 28;
  const panelWidth = compact ? Math.min(width - 32, 440) : 400;
  // Desktop clears the header; phones keep the top of the page in view above the panel.
  const room = compact ? height - insets.top - 12 - bottom : height - 100 - bottom;
  return {
    right,
    bottom,
    panel: {
      right: Math.min(right, width - 16 - panelWidth),
      width: panelWidth,
      height: compact
        ? Math.min(room, 600, Math.max(320, Math.round(room * 0.72)))
        : Math.min(room, 680),
    },
  };
}
// The sous-chef: one conversation for anything in the app, typed, spoken live, or from a photo. It
// floats beside the page rather than over it, so the page stays usable while it follows along.
export function RecipeStudio({
  start,
  hidden,
  onHide,
  onLive,
  context,
  onAction,
  onChanged,
  onClose,
  onRecipe,
}: {
  /** Each explicit start (Speak, Scan, the launcher) asks for its mode, even while already open. */
  start: { mode: StudioMode; n: number };
  /** Minimized to the launcher, or to a pill while a live voice conversation keeps going. */
  hidden: boolean;
  onHide: (hidden: boolean) => void;
  /** Whether a live voice conversation is running, so the app can make room for its pill. */
  onLive: (live: boolean) => void;
  context: StudioContext;
  onAction: (action: AppAction) => void;
  /** A reply arrived that may have changed lists, cookbooks or the open recipe. */
  onChanged: () => void;
  onClose: () => void;
  onRecipe: (recipe: Recipe) => void;
}) {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  const { compact, desktop, insets, height } = useChrome();
  const dock = useSousChefDock();
  const lift = useKeyboardLift();
  const [project, setProject] = useState<StudioProject | null>(null);
  const [events, setEvents] = useState<StudioEvent[]>([]);
  const [history, setHistory] = useState<StudioProject[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(start.mode === 'photo');
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
  const panel = useRef<View>(null);
  const pending = useRef<{ key: string; text: string; images: string[] } | null>(null);
  const voiceAsked = useRef(0);
  const renewal = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Screen actions run only for replies that arrive while open, never for old history.
  const loaded = useRef(false);
  const contextSent = useRef<Promise<void> | null>(null);
  const handlers = useRef<{ changed: () => void; act: (action: AppAction) => void }>({
    changed: () => {},
    act: () => {},
  });
  const runningVoice = voiceState !== 'off';
  // Out of sight, it only keeps up with a live conversation or a reply on its way.
  const attending = !hidden || runningVoice;
  const watching = attending || !!project?.busy;
  useEffect(() => {
    onLive(runningVoice);
  }, [onLive, runningVoice]);
  useEffect(() => () => onLive(false), [onLive]);
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
      setBrowsing(false);
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
    if (!project?.id || !watching) return;
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
  }, [project?.id, refresh, watching]);
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
    if (!project?.id || !attending) return;
    contextSent.current = api(`/recipe-studio/${project.id}/context`, {
      method: 'PUT',
      body: { screen, recipeId: viewing || '', cookingStep: cookingStep || 0, timeZone },
    }).catch(() => {});
  }, [project?.id, screen, viewing, cookingStep, attending]);
  // On a desktop the panel stays beside whatever changed; on phones it covers much of the screen, so
  // it steps aside to show it, and a live conversation carries on from its pill.
  const stepAside = () => {
    if (compact) onHide(true);
  };
  useEffect(() => {
    handlers.current = {
      changed: onChanged,
      act: (action) => {
        if (action.type !== 'set_language') stepAside();
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
    if (!projectRef.current || attempt.current || connection.current) return;
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
  // Scan opens the camera, even in a sous-chef that was already open.
  const [started, setStarted] = useState(start);
  if (start !== started) {
    setStarted(start);
    if (start.mode === 'photo') {
      setBrowsing(false);
      setCamera(true);
    }
  }
  useEffect(() => {
    if (start.mode === 'voice' && project && voiceAsked.current !== start.n) {
      voiceAsked.current = start.n;
      void startVoice();
    }
    // One automatic start per explicit Speak action; switching conversations doesn't restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, project?.id]);
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
      const form = await fileForm(result.uri, 'recipe.jpg');
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
  // Pops out of the launcher's corner, and back into it.
  const [pop] = useState(() => new Animated.Value(0));
  const [shown, setShown] = useState(!hidden);
  if (!hidden && !shown) setShown(true);
  useEffect(() => {
    if (!hidden) animate(pop, 1, 320).start();
    else animate(pop, 0, 160).start(({ finished }) => finished && setShown(false));
  }, [hidden, pop]);
  const exit = () => {
    void stop();
    void Promise.all([app.refreshPrivate(), app.refreshRecipes()]);
    animate(pop, 0, 160).start(() => onClose());
  };
  const minimize = () => onHide(true);
  // Escape (from inside the panel) and Android's back button tuck it away, as a sheet's would.
  const keys = useRef(minimize);
  useEffect(() => {
    keys.current = minimize;
  });
  useEffect(() => {
    if (hidden) return;
    if (Platform.OS === 'android') {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        keys.current();
        return true;
      });
      return () => sub.remove();
    }
    if (Platform.OS !== 'web') return;
    // Captured, since text fields stop their keys from bubbling; and kept from cooking mode's Escape.
    const onKey = (e: KeyboardEvent) => {
      const node = panel.current as unknown as HTMLElement | null;
      if (e.key !== 'Escape' || !node?.contains(document.activeElement)) return;
      e.stopPropagation();
      keys.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [hidden]);
  const openRecipe = async (id: string) => {
    try {
      const recipe = await api<Recipe>(`/recipes/${encodeURIComponent(id)}`);
      stepAside();
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
  const earlier = history.filter((p) => p.id !== project?.id);
  const chatting = !camera && !browsing;
  // On phones it rises above the keyboard and gives up height to it.
  const bottom = lift ? Math.max(dock.bottom, insets.bottom + lift + 8) : dock.bottom;
  const panelHeight = Math.min(dock.panel.height, height - insets.top - 12 - bottom);
  const day = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
        new Date(iso),
      );
    } catch {
      return '';
    }
  };
  return (
    <>
      {hidden && runningVoice && (
        <View
          style={{
            position: 'absolute',
            right: dock.right,
            bottom: dock.bottom,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            padding: 5,
            paddingLeft: 6,
            borderRadius: radius.pill,
            backgroundColor: color.ink,
            borderWidth: 1,
            borderColor: color.glassBorder,
            boxShadow: shadow.float,
          }}
        >
          <Press
            accessibilityRole="button"
            accessibilityLabel={tr('Back to conversation')}
            onPress={() => onHide(false)}
            style={[s.row, { gap: 9, paddingHorizontal: 10, height: 44 }]}
          >
            {muted ? (
              <MicOff size={18} color={color.white} />
            ) : (
              <Mic size={18} color={color.white} />
            )}
            <Text style={{ ...s.h3, color: color.white }}>{tr('Listening…')}</Text>
          </Press>
          <IconButton icon={X} dark size={40} label={tr('End voice')} onPress={() => void stop()} />
        </View>
      )}
      {shown && (
        <Animated.View
          ref={panel}
          role="dialog"
          aria-label={tr('Sous-chef')}
          style={{
            position: 'absolute',
            right: dock.panel.right,
            bottom,
            width: dock.panel.width,
            height: panelHeight,
            backgroundColor: color.bg,
            borderRadius: radius.lg,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: color.line,
            boxShadow: shadow.float,
            overflow: 'hidden',
            opacity: pop,
            transformOrigin: 'bottom right',
            transform: [
              { translateY: pop.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) },
              { scale: pop.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
            ],
          }}
        >
          <View
            style={[
              s.row,
              {
                gap: 2,
                height: 60,
                paddingLeft: 14,
                paddingRight: 8,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderColor: color.line,
              },
            ]}
          >
            <View
              style={{
                width: 32,
                height: 32,
                borderRadius: 16,
                marginRight: 8,
                backgroundColor: color.ink,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Sparkles size={15} color={color.white} strokeWidth={2.2} />
            </View>
            <Text accessibilityRole="header" numberOfLines={1} style={[s.h3, { flex: 1 }]}>
              {camera
                ? tr('Take a photo')
                : browsing
                  ? tr('Earlier conversations')
                  : tr('Sous-chef')}
            </Text>
            {earlier.length > 0 && (
              <IconButton
                icon={History}
                plain
                size={36}
                label={tr('Earlier conversations')}
                onPress={() => {
                  setCamera(false);
                  setBrowsing((b) => !b);
                }}
              />
            )}
            <IconButton
              icon={SquarePen}
              plain
              size={36}
              label={tr('New chat')}
              disabled={busy || runningVoice}
              onPress={() => void create()}
            />
            <IconButton
              icon={ChevronDown}
              plain
              size={36}
              label={
                runningVoice ? tr('Keep talking while you browse') : tr('Minimize the sous-chef')
              }
              onPress={minimize}
            />
            <IconButton icon={X} plain size={36} label={tr('Close the sous-chef')} onPress={exit} />
          </View>
          {runningVoice && !camera && (
            <View
              style={{
                margin: 12,
                marginBottom: 0,
                borderRadius: radius.md,
                backgroundColor: color.ink,
                padding: 16,
                gap: 12,
              }}
            >
              <View style={[s.row, { gap: 12 }]}>
                <View
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 24,
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
                    <MicOff size={22} color={color.white} />
                  ) : (
                    <Mic size={22} color={color.white} strokeWidth={1.5} />
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
              {!!caption && (
                <Text numberOfLines={3} style={{ ...s.body, color: color.white }}>
                  {caption}
                </Text>
              )}
              <View style={[s.row, { gap: 12 }]}>
                <IconButton
                  icon={muted ? Mic : MicOff}
                  label={muted ? tr('Resume microphone') : tr('Mute microphone')}
                  disabled={voiceState === 'connecting'}
                  size={40}
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
                <Text style={{ ...s.small, color: color.onInk, flex: 1, textAlign: 'right' }}>
                  {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
                </Text>
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
                      .catch(() => setError('Audio playback is blocked in your browser settings.'))
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
            keyboardShouldPersistTaps="handled"
            style={{ flex: 1 }}
            onContentSizeChange={() => {
              if (chatting) list.current?.scrollToEnd({ animated: true });
            }}
            // A conversation sits on the composer, as in any chat.
            contentContainerStyle={{
              flexGrow: 1,
              justifyContent: chatting ? 'flex-end' : 'flex-start',
              padding: 14,
              gap: 12,
            }}
          >
            {camera ? (
              <RecipeCamera onPhoto={(uri) => void upload(uri)} onCancel={() => setCamera(false)} />
            ) : browsing ? (
              <>
                <View style={[s.card, { paddingVertical: 4, paddingHorizontal: 16 }]}>
                  {earlier.map((p, n) => (
                    <Press
                      key={p.id}
                      accessibilityRole="button"
                      scale={0.98}
                      onPress={() => void selectProject(p).catch((e) => setError(e.message))}
                      style={[
                        s.row,
                        { gap: 12, paddingVertical: 13 },
                        n > 0 && {
                          borderTopWidth: StyleSheet.hairlineWidth,
                          borderColor: color.line,
                        },
                      ]}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text numberOfLines={1} style={[s.h3, { fontSize: 15 }]}>
                          {p.recipe?.title || p.title || tr('Earlier conversation')}
                        </Text>
                        <Text style={s.small}>{day(p.updatedAt)}</Text>
                      </View>
                      <ChevronRight size={16} color={color.soft} />
                    </Press>
                  ))}
                </View>
                <Text style={s.small}>{tr('Your conversation saves automatically.')}</Text>
              </>
            ) : (
              <>
                {!groups.length && !runningVoice && (
                  <View style={{ paddingVertical: 6, gap: 10 }}>
                    <ChefHat size={28} color={color.ink} />
                    <Text style={s.h2}>{tr('How can I help in the kitchen?')}</Text>
                    <Text style={s.muted}>
                      {tr(
                        'Find recipes, plan meals, sort out your shopping, or create a recipe together. Type, add a photo, or talk live.',
                      )}
                    </Text>
                    <View style={[s.wrap, { gap: 8 }]}>
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
                    <Text style={s.small}>{tr('Your conversation saves automatically.')}</Text>
                  </View>
                )}
                {groups.map((event) => (
                  <View
                    key={event.seq}
                    style={{
                      alignSelf: event.role === 'user' ? 'flex-end' : 'flex-start',
                      maxWidth: '92%',
                      padding: 14,
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
                      {event.imageCount
                        ? tr(' · {{v0}} recipe photo', { v0: event.imageCount })
                        : ''}
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
                            style={{ width: 140, gap: 6 }}
                          >
                            <FoodImage
                              uri={r.image}
                              style={{ width: 140, height: 100, borderRadius: radius.sm }}
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
                {busy && <ActivityIndicator color={color.ink} />}
                {project?.recipe && (
                  <View style={[s.card, { gap: 14, padding: 16 }]}>
                    <View style={[s.row, { gap: 14 }]}>
                      {!!project.recipe.image && (
                        <FoodImage
                          uri={project.recipe.image}
                          style={{ width: 68, height: 80, borderRadius: radius.md }}
                        />
                      )}
                      <View style={{ flex: 1, gap: 6 }}>
                        <Pill
                          title={
                            project.recipe.published ? tr('Published') : tr('Private draft saved')
                          }
                          icon={Check}
                        />
                        <Text style={s.h3}>{project.recipe.title}</Text>
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
                        {asset.status === 'failed' && (
                          <Text style={s.muted}>{tr(asset.error)}</Text>
                        )}
                      </View>
                    ))}
                    <View style={[s.row, { gap: 8 }]}>
                      <Button
                        title={tr('Open recipe')}
                        small
                        onPress={() => {
                          stepAside();
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
              </>
            )}
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
          </ScrollView>
          {chatting && (
            <View
              style={{
                gap: 10,
                paddingHorizontal: 12,
                paddingTop: 10,
                paddingBottom: 12,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderColor: color.line,
              }}
            >
              {attachment && (
                <View style={[s.row, { gap: 12 }]}>
                  <FoodImage
                    uri={attachment.uri}
                    style={{ width: 48, height: 60, borderRadius: radius.sm }}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={s.h3}>{tr('Recipe photo attached')}</Text>
                    <Text style={s.small}>{tr('Add a note or send it as it is.')}</Text>
                  </View>
                  <IconButton
                    icon={X}
                    label={tr('Remove attached recipe photo')}
                    size={40}
                    onPress={() => setAttachment(null)}
                  />
                </View>
              )}
              {/* It follows what's open, so "this" means the page or recipe in front of you. */}
              <View style={[s.row, { gap: 6, paddingHorizontal: 6 }]}>
                <Eye size={15} color={color.muted} />
                <Text numberOfLines={1} style={[s.small, { flex: 1 }]}>
                  {context.recipe
                    ? context.cookingStep
                      ? tr('Cooking {{v0}} · step {{v1}}', {
                          v0: context.recipe.title,
                          v1: context.cookingStep,
                        })
                      : tr('Viewing {{v0}}', { v0: context.recipe.title })
                    : tr('Viewing {{v0}}', { v0: context.title })}
                </Text>
              </View>
              {!!nearby.length && !runningVoice && (
                <ScrollView
                  horizontal
                  keyboardShouldPersistTaps="handled"
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
                {/* A tight pair, so they read as one set of photo tools. */}
                <View style={[s.row, { height: 40 }]}>
                  <IconButton
                    icon={Camera}
                    label={tr('Take a photo')}
                    plain
                    size={34}
                    onPress={() => {
                      setBrowsing(false);
                      setCamera(true);
                    }}
                    disabled={!project || busy}
                  />
                  <IconButton
                    icon={ImagePlus}
                    label={tr('Add a photo')}
                    plain
                    size={34}
                    onPress={() => void pick()}
                    disabled={!project || busy}
                  />
                </View>
                <TextInput
                  accessibilityLabel={tr('Message your sous-chef')}
                  placeholder={attachment ? tr('Add a note (optional)…') : tr('Ask anything…')}
                  placeholderTextColor={color.soft}
                  value={text}
                  onChangeText={setText}
                  // A desktop browser types straight in; phones wait for a tap, not the keyboard.
                  autoFocus={Platform.OS === 'web' && desktop}
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
                <View style={[s.row, { gap: 4 }]}>
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
          )}
        </Animated.View>
      )}
    </>
  );
}
