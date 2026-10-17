import { useI18n } from '../lib/i18n';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  AppState,
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
  Minimize2,
  PenLine,
  RotateCcw,
  Send,
  Square,
  SquarePen,
  Video,
  Volume2,
  X,
} from './icons';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import {
  AppAction,
  Recipe,
  StudioContext,
  StudioEffect,
  StudioEvent,
  StudioMode,
  StudioProject,
  StudioStart,
} from '../lib/types';
import { color, radius, s, shadow } from '../lib/theme';
import { Button, Dialog, FoodImage, IconButton, Pill, Press, animate, motionReduced } from './ui';
import { RecipeCamera } from './RecipeCamera';
import { VideoPlayer } from './VideoPlayer';
import { Reply, SousChefMark, Thinking, ThinkingCaption, bubble, stepLabels } from './ChatBubbles';
import { Receipts, type Receipt } from './Receipts';
import { useSousChefDock } from './sousChefDock';
import { fileForm } from '../lib/photos';
import { requestKey } from '../lib/utils';
import { openVoice } from '../lib/voice/transport';
import { VoiceConnection, VoiceEvent } from '../lib/voice/connection';

// Consecutive events from one side are one bubble; its receipts remember which event they came
// from, which Undo names.
function mergeEvents(events: StudioEvent[]) {
  const groups: (StudioEvent & { receipts: Receipt[]; seqs: number[] })[] = [];
  for (const event of events) {
    const receipts = (event.effects ?? []).map((effect, index) => ({
      seq: event.seq,
      index,
      effect,
    }));
    const prev = groups[groups.length - 1];
    if (prev?.role === event.role && !event.imageCount && !prev.imageCount) {
      prev.content += event.content;
      if (event.recipes?.length) prev.recipes = [...(prev.recipes || []), ...event.recipes];
      prev.receipts.push(...receipts);
      prev.seqs.push(event.seq);
      prev.failed = prev.failed || event.failed;
    } else groups.push({ ...event, receipts, seqs: [event.seq] });
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
// What Speak it asks for, so a recipe can be told in one go.
const recipeTellings = [
  'What it is, and how many it serves',
  'The ingredients, with amounts if you know them',
  'The steps, in order',
];
// The end of what was just said, from a word boundary, so the newest words stay in view.
function latest(text: string, max = 150) {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(-max);
  const space = cut.indexOf(' ');
  return '…' + (space >= 0 && space < 24 ? cut.slice(space + 1) : cut);
}
// Minutes and seconds, as a call's clock shows them.
function clock(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
// Bars that sway while the microphone is open, and rest while it connects or is muted.
const barHeights = [0.5, 0.9, 0.6, 1, 0.45];
const barBeats = [460, 340, 520, 400, 580];
function VoiceBars({ active }: { active: boolean }) {
  const [bars] = useState(() => barHeights.map((v) => new Animated.Value(v)));
  useEffect(() => {
    if (!active || motionReduced()) {
      bars.forEach((b, i) => b.setValue(active ? barHeights[i] : 0.25));
      return;
    }
    const loops = bars.map((b, i) =>
      Animated.loop(Animated.sequence([animate(b, 1, barBeats[i]), animate(b, 0.3, barBeats[i])])),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [active, bars]);
  return (
    <View style={[s.row, { gap: 3, height: 22 }]}>
      {bars.map((b, i) => (
        <Animated.View
          key={i}
          style={{
            width: 4,
            height: 22,
            borderRadius: 2,
            backgroundColor: color.white,
            transform: [{ scaleY: b }],
          }}
        />
      ))}
    </View>
  );
}
const cookingSuggestions = [
  'How do I know this step is done?',
  'I don’t have the right pan',
  'Something went wrong — can I fix it?',
];
// The start of a reply, short enough for a toast.
const excerpt = (text: string) => {
  const t = text.trim();
  return t.length > 140 ? t.slice(0, 139).trimEnd() + '…' : t;
};
// A conversation this recent is picked up again; older ones stay in the history row.
const RESUME_MS = 6 * 60 * 60 * 1000;
// A new recipe is written in a conversation where nothing's been said yet, or one already
// writing a new recipe that has no draft so far; anything else starts a conversation of its own.
const takesNewRecipe = (p: StudioProject) => !p.recipeId && (!p.title || p.purpose === 'recipe');
const timeZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
})();
// The sous-chef: one conversation for anything in the app, typed, spoken live, or from a photo. In a
// desktop browser it floats beside the page, which stays usable while it follows along; the apps and
// narrow windows open it as a sheet.
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
  /**
   * Each explicit start (Speak, Scan, the launcher) asks for its mode, even while already open; a
   * screen's prompt (the home's ideas, the planner) also brings the message to send, and Create a
   * recipe says it's for writing a new one.
   */
  start: { mode: StudioMode; n: number } & StudioStart;
  /** Minimized: the panel folds into the launcher, or a pill keeps a live conversation going. */
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
  const { t: tr, locale, language: appLanguage } = useI18n();
  const app = useApp();
  const dock = useSousChefDock();
  const floating = !!dock.panel;
  const [project, setProject] = useState<StudioProject | null>(null);
  // The conversation a start from Create a recipe writes its new recipe in, and that start. A
  // conversation opened for a new recipe stays about it, however it's reopened, until the recipe
  // is published.
  const [recipeFor, setRecipeFor] = useState<{ project: string; n: number } | null>(null);
  const writing =
    !!project &&
    project.status !== 'published' &&
    (recipeFor?.project === project.id || project.purpose === 'recipe');
  // The start the sheet opened with.
  const [opening] = useState(start);
  const [events, setEvents] = useState<StudioEvent[]>([]);
  const [history, setHistory] = useState<StudioProject[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [camera, setCamera] = useState(start.mode === 'photo');
  const [attachment, setAttachment] = useState<{ id: string; uri: string } | null>(null);
  const [voiceState, setVoiceState] = useState<'off' | 'connecting' | 'listening' | 'speaking'>(
    'off',
  );
  // A call that ended without the member ending it can be resumed with a tap.
  const [voiceLost, setVoiceLost] = useState(false);
  // The seconds this call has when the plan's voice time runs out with it, else null.
  const [voiceLimit, setVoiceLimit] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  // The newest words and who said them; the conversation above keeps the whole transcript.
  const [caption, setCaption] = useState<{ role: 'user' | 'assistant'; text: string } | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [inputHeight, setInputHeight] = useState(40);
  const connection = useRef<VoiceConnection | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const live = useRef(true);
  const projectRef = useRef<StudioProject | null>(null);
  const cursor = useRef(0);
  const list = useRef<ScrollView>(null);
  const panel = useRef<View>(null);
  const pending = useRef<{ key: string; text: string; images: string[]; answer: string } | null>(
    null,
  );
  const voiceAsked = useRef(0);
  const renewal = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The sous-chef counts as speaking until its words have stopped arriving for a moment.
  const quiet = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Screen actions run only for replies that arrive while open, never for old history.
  const loaded = useRef(false);
  const changedMeanwhile = useRef(false);
  const pollFailed = useRef(false);
  const contextSent = useRef<Promise<void> | null>(null);
  const handlers = useRef<{
    changed: () => void;
    act: (action: AppAction, reply?: string) => void;
  }>({
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
    clearTimeout(quiet.current);
    attempt.current?.abort();
    attempt.current = null;
    const current = connection.current;
    connection.current = null;
    setVoiceState('off');
    setVoiceLimit(null);
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
      // Only a reply whose turn changed something refreshes the app's lists (an older server
      // doesn't say, so all of its replies do), and history counts once it has loaded.
      if (replies.some((e) => e.changed ?? true)) {
        if (loaded.current) handlers.current.changed();
        else changedMeanwhile.current = true;
      }
      if (loaded.current)
        replies.forEach((e) =>
          e.actions?.forEach((action) => handlers.current.act(action, e.content)),
        );
    }
    // A full page means older history is still draining.
    if (incoming.length < 1000 && !loaded.current) {
      loaded.current = true;
      if (changedMeanwhile.current) handlers.current.changed();
      changedMeanwhile.current = false;
    }
  }, []);
  const selectProject = useCallback(
    async (next: StudioProject) => {
      // Words or a photo the cook added while the first conversation was still loading belong to
      // it; moving to another conversation starts with an empty composer.
      const another = projectRef.current !== null && projectRef.current.id !== next.id;
      await stop();
      cursor.current = 0;
      setEvents([]);
      if (another) {
        setAttachment(null);
        setText('');
      }
      setCaption(null);
      setError('');
      setBrowsing(false);
      pending.current = null;
      loaded.current = false;
      changedMeanwhile.current = false;
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
      return next.id;
    } catch (e) {
      setError((e as Error).message);
      return null;
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
        const resumable = items.find(
          (p) =>
            Date.now() - Date.parse(p.updatedAt) < RESUME_MS &&
            (!opening.recipe || takesNewRecipe(p)),
        );
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
  }, [selectProject, opening]);
  // A start from Create a recipe writes in the open conversation when it can take a new recipe,
  // or else in a new one.
  const placing = useRef(0);
  useEffect(() => {
    if (!start.recipe || !project || placing.current === start.n) return;
    const n = (placing.current = start.n);
    if (takesNewRecipe(project) || (writing && !project.recipeId))
      setRecipeFor({ project: project.id, n });
    else void create().then((id) => id && setRecipeFor({ project: id, n }));
    // Placed once per start; create changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, project]);
  // What a start does next (Speak it's call) waits until its conversation is chosen.
  const placed = !start.recipe || recipeFor?.n === start.n;
  useEffect(() => {
    if (!project?.id || !watching) return;
    let done = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refresh(project.id);
        // An error from an earlier poll goes once polling works again.
        if (pollFailed.current) {
          pollFailed.current = false;
          setError('');
        }
      } catch (e) {
        if (!done) {
          pollFailed.current = true;
          setError((e as Error).message);
        }
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
  // The conversation follows what the user has open, their clock, and their language.
  const { screen, cookingStep } = context;
  const viewing = context.recipe?.id;
  const language = context.language ?? appLanguage;
  useEffect(() => {
    if (!project?.id || !attending) return;
    contextSent.current = api(`/recipe-studio/${project.id}/context`, {
      method: 'PUT',
      body: {
        screen,
        recipeId: viewing || '',
        cookingStep: cookingStep || 0,
        timeZone,
        language,
        purpose: writing ? 'recipe' : '',
      },
    }).catch(() => {});
  }, [project?.id, screen, viewing, cookingStep, attending, language, writing]);
  useEffect(() => {
    handlers.current = {
      changed: onChanged,
      act: (action, reply) => {
        // The panel stays beside the page as it changes. A sheet steps aside into its pill, so
        // the conversation is a tap away: live voice keeps talking, and a typed chat shows its
        // reply as a toast rather than closing before it was read.
        if (action.type !== 'set_language' && !floating) {
          onHide(true);
          if (!connection.current && reply) app.notify(excerpt(reply));
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
      setVoiceLost(true);
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
    setVoiceLost(false);
    setCaption(null);
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
        const role = ev.type.includes('input_') ? 'user' : 'assistant';
        setCaption((old) => ({
          role,
          text: old?.role === role ? (old.text + (ev.delta || '')).slice(-600) : ev.delta || '',
        }));
        clearTimeout(quiet.current);
        if (role === 'user') setVoiceState('listening');
        else {
          setVoiceState('speaking');
          quiet.current = setTimeout(
            () => setVoiceState((now) => (now === 'speaking' ? 'listening' : now)),
            1500,
          );
        }
      }
      if (ev.type === 'connection.failed' || ev.type === 'error') {
        setError(
          'The voice connection was interrupted. Your saved conversation is ready to resume.',
        );
        setVoiceLost(true);
        void stop();
      }
      const renew =
        ev.type === 'connection.renew' || (ev.type === 'session.closed' && ev.reason === 'expired');
      if (ev.type === 'connection.limit' || (renew && connection.current?.planEnds)) {
        // The plan's voice time is up: a new session would be refused.
        void stop().then(() => {
          if (live.current)
            setError(
              "You've used your plan's live voice time for the last 30 days. Your conversation is saved and you can continue by text.",
            );
        });
      } else if (renew) {
        void stop().then(() => {
          if (!live.current) return;
          setCaption({ role: 'assistant', text: tr('Reconnecting. Hold that thought…') });
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
      // The voice model greets for what the conversation is for, a new recipe or anything.
      await contextSent.current;
      const c = await openVoice({
        projectId: projectRef.current.id,
        signal: controller.signal,
        onEvent: event,
        onAudioBlocked: () => setAudioBlocked(true),
      });
      if (controller.signal.aborted) await c.close();
      else {
        connection.current = c;
        // The call's clock starts with the session, and counts down when it's the plan's last.
        setSeconds(0);
        setVoiceLimit(c.planEnds ? c.maxSeconds : null);
      }
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
    if (start.mode === 'voice' && project && placed && voiceAsked.current !== start.n) {
      voiceAsked.current = start.n;
      void startVoice();
    }
    // One automatic start per explicit Speak action; switching conversations doesn't restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, project?.id, placed]);
  // answer is a tap on Yes or No for the question waiting on the sous-chef.
  const send = async (
    message = text,
    image = attachment,
    fromUpload = false,
    answer?: { answer: 'yes' | 'no'; question: number },
  ) => {
    if (!project || (busy && !fromUpload) || project.busy || (!message.trim() && !image)) return;
    const value =
      message.trim() ||
      tr(
        'Here’s a photo. If it’s a recipe, make it into a complete recipe and ask about anything unclear. Otherwise, tell me what I could cook with it.',
      );
    const images = image ? [image.id] : [];
    const answered = answer ? `${answer.answer}:${answer.question}` : '';
    if (
      pending.current?.text !== value ||
      JSON.stringify(pending.current.images) !== JSON.stringify(images) ||
      pending.current.answer !== answered
    )
      pending.current = { key: requestKey(), text: value, images, answer: answered };
    setBusy(true);
    setError('');
    try {
      await contextSent.current;
      await api(`/recipe-studio/${project.id}/messages`, {
        method: 'POST',
        body: { text: value, images, ...answer },
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
  // A receipt's View goes where the change is, as the sous-chef's own screen actions do.
  const viewReceipt = (effect: StudioEffect) => {
    if (effect.recipe && effect.kind !== 'deleted')
      handlers.current.act({ type: 'open_recipe', recipeId: effect.recipe });
    else if (effect.page) handlers.current.act({ type: 'go_to', page: effect.page });
  };
  const [undoing, setUndoing] = useState<string>();
  // The draft's video, open large.
  const [videoOpen, setVideoOpen] = useState(false);
  const undoReceipt = async ({ seq, index }: Receipt) => {
    if (!project || undoing) return;
    setUndoing(`${seq}:${index}`);
    setError('');
    try {
      const { effects } = await api<{ effects: StudioEffect[] }>(
        `/recipe-studio/${project.id}/undo`,
        { method: 'POST', body: { seq, index } },
      );
      setEvents((old) => old.map((e) => (e.seq === seq ? { ...e, effects } : e)));
      handlers.current.changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUndoing(undefined);
    }
  };
  // Stop ends the reply on its way; what it already did stays, with its receipts.
  const stopTurn = async () => {
    if (!project) return;
    try {
      await api(`/recipe-studio/${project.id}/cancel`, { method: 'POST' });
      await refresh(project.id);
    } catch (e) {
      setError((e as Error).message);
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
    // Offline, the lists simply stay as they were; the next refresh catches up.
    void Promise.all([app.refreshPrivate(), app.refreshRecipes()]).catch(() => {});
    if (floating) animate(pop, 0, 160).start(() => onClose());
    else onClose();
  };
  const minimize = () => onHide(true);
  // Escape from inside the panel tucks it away, as it would close a sheet.
  const keys = useRef(minimize);
  useEffect(() => {
    keys.current = minimize;
  });
  useEffect(() => {
    if (hidden || !floating) return;
    // Captured, since text fields stop their keys from bubbling; and kept from cooking mode's Escape.
    const onKey = (e: KeyboardEvent) => {
      const node = panel.current as unknown as HTMLElement | null;
      if (e.key !== 'Escape' || !node?.contains(document.activeElement)) return;
      e.stopPropagation();
      keys.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [hidden, floating]);
  const openRecipe = async (id: string) => {
    try {
      const recipe = await api<Recipe>(`/recipes/${encodeURIComponent(id)}`);
      if (!floating) exit();
      onRecipe(recipe);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const ready = !!project && !busy && !project.busy;
  // A start's message goes once, as soon as the conversation can take it.
  const prompted = useRef(0);
  useEffect(() => {
    if (!start.message || prompted.current === start.n || !ready || !placed) return;
    prompted.current = start.n;
    void send(start.message, null);
    // Sent once per start; send itself changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, ready, placed]);
  const groups = mergeEvents(events);
  const question = project?.question;
  // The draft card sits under the reply that saved or published it; an older server doesn't
  // say which, so there it stays at the end.
  let draftAt = -1;
  groups.forEach((g, i) => {
    if (g.receipts.some((r) => r.effect.kind === 'draft' || r.effect.kind === 'published'))
      draftAt = i;
  });
  const lastFailed = !!groups[groups.length - 1]?.failed;
  // The reply that arrives as the thinking bubble goes grows out of it.
  const thinking = !!project?.busy;
  const newest = groups[groups.length - 1];
  const [wait, setWait] = useState({ thinking, newest: newest?.seq ?? 0 });
  const [grown, setGrown] = useState(0);
  const settled = useCallback(() => setGrown(0), []);
  if (wait.thinking !== thinking || wait.newest !== (newest?.seq ?? 0)) {
    setWait({ thinking, newest: newest?.seq ?? 0 });
    const ended = wait.thinking && !thinking && newest?.role === 'assistant';
    if (ended && newest.seq !== wait.newest && !hidden) setGrown(newest.seq);
  }
  const nearby = context.recipe
    ? context.cookingStep
      ? cookingSuggestions
      : recipeSuggestions
    : [];
  const earlier = history.filter((p) => p.id !== project?.id);
  const chatting = !camera && !browsing;
  const day = (iso: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(
        new Date(iso),
      );
    } catch {
      return '';
    }
  };
  // The pieces below are shared by the floating panel and the sheet, which arrange them differently.
  // While voice is live its controls take the composer's place, under the conversation. It says
  // who has the floor: the sous-chef speaking, working on what was asked, or listening.
  const working = project?.busy ? stepLabels[project.turn?.step ?? ''] : undefined;
  const voiceStatus =
    voiceState === 'connecting'
      ? tr('Connecting your sous-chef…')
      : muted
        ? tr('Microphone paused')
        : voiceState === 'speaking'
          ? tr('Speaking…')
          : working
            ? tr(working)
            : project?.busy
              ? tr('Working on it…')
              : tr('I’m listening. Take your time.');
  const voiceBar = runningVoice && (
    <View
      style={{
        borderRadius: radius.lg,
        backgroundColor: color.ink,
        padding: 16,
        paddingTop: 14,
        gap: 14,
      }}
    >
      <View style={[s.row, { gap: 12, minHeight: 24 }]}>
        {voiceState === 'connecting' ? (
          <ActivityIndicator size="small" color={color.white} />
        ) : (
          <VoiceBars active={!muted} />
        )}
        <Text
          accessibilityLiveRegion="polite"
          numberOfLines={1}
          style={{ ...s.h3, color: color.white, flex: 1 }}
        >
          {voiceStatus}
        </Text>
        <Text style={{ ...s.small, color: color.onInk, fontVariant: ['tabular-nums'] }}>
          {voiceLimit === null
            ? clock(seconds)
            : tr('{{v0}} left', { v0: clock(Math.max(0, voiceLimit - seconds)) })}
        </Text>
      </View>
      {caption?.text.trim() ? (
        <View style={{ gap: 4 }}>
          <Text style={{ ...s.label, color: color.onInk }}>
            {caption.role === 'user' ? tr('You') : tr('Sous-chef')}
          </Text>
          <Text numberOfLines={3} style={{ ...s.body, color: color.white }}>
            {latest(caption.text)}
          </Text>
        </View>
      ) : (
        <Text style={{ ...s.muted, color: color.onInk }}>
          {tr('Talk naturally. Interrupt or correct me anytime.')}
        </Text>
      )}
      {audioBlocked && (
        <Button
          title={tr('Enable assistant audio')}
          icon={Volume2}
          small
          variant="glass"
          onPress={() =>
            void connection.current
              ?.enableAudio()
              .then(() => setAudioBlocked(false))
              .catch(() => setError('Audio playback is blocked in your browser settings.'))
          }
        />
      )}
      <View style={[s.row, { gap: 10 }]}>
        <Button
          title={muted ? tr('Unmute') : tr('Mute')}
          label={muted ? tr('Resume microphone') : tr('Mute microphone')}
          icon={muted ? Mic : MicOff}
          variant="glass"
          disabled={voiceState === 'connecting'}
          onPress={() => {
            connection.current?.mute(!muted);
            setMuted(!muted);
          }}
          style={{ flex: 1 }}
        />
        <Button
          title={tr('End voice')}
          icon={Square}
          variant="inverse"
          onPress={() => void stop()}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
  const draft = project?.recipe && (
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
            {[
              tr('minuteCount', { count: project.recipe.minutes }),
              tr('servingCount', { count: project.recipe.servings }),
              tr('ingredientCount', { count: project.recipe.ingredients.length }),
            ].join(' · ')}
          </Text>
        </View>
      </View>
      {/* Enough of the recipe to see it's the right one, without opening it. */}
      <Text numberOfLines={2} style={[s.small, { color: color.ink }]}>
        {project.recipe.ingredients.map((i) => i.name).join(' · ')}
      </Text>
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
      <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
        <Button
          title={tr('Open recipe')}
          small
          onPress={() => {
            if (!floating) exit();
            onRecipe(project.recipe!);
          }}
        />
        {!!project.recipe.video && (
          <Button
            title={tr('Watch video')}
            icon={Video}
            small
            variant="secondary"
            onPress={() => setVideoOpen(true)}
          />
        )}
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
      <Text style={s.small}>{tr('Media keeps creating when you close this conversation.')}</Text>
      <Dialog visible={videoOpen} onClose={() => setVideoOpen(false)} title={project.recipe.title}>
        {videoOpen && !!project.recipe.video ? <VideoPlayer uri={project.recipe.video} /> : null}
      </Dialog>
    </View>
  );
  // Writing a new recipe starts with what to tell; as you talk, Speak it's transcript fills in
  // above the controls.
  const voiced = runningVoice && start.mode === 'voice';
  const telling = (
    <View style={{ paddingVertical: floating ? 6 : 10, gap: 14 }}>
      <View style={{ gap: 6 }}>
        <Text style={s.h2}>{tr('Tell me your recipe')}</Text>
        <Text style={s.muted}>
          {voiced
            ? tr(
                'Talk it through like you would to a friend. I’ll write it up and ask about anything I missed.',
              )
            : tr(
                'Type it out like you would to a friend. I’ll write it up and ask about anything I missed.',
              )}
        </Text>
      </View>
      <View style={[s.card, { padding: 16, gap: 14 }]}>
        {recipeTellings.map((line, n) => (
          <View key={line} style={[s.row, { gap: 12 }]}>
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                backgroundColor: color.bg,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={[s.small, { color: color.ink }]}>{n + 1}</Text>
            </View>
            <Text style={[s.body, { flex: 1 }]}>{tr(line)}</Text>
          </View>
        ))}
      </View>
      <Text style={s.small}>
        {voiced
          ? tr('Say “that’s everything” when you’re done.')
          : tr('Paste it all in, or send it a bit at a time.')}
      </Text>
    </View>
  );
  const messages = (
    <>
      {!groups.length && (voiced || writing) && telling}
      {!groups.length && !(voiced || writing) && (
        <View style={{ paddingVertical: floating ? 6 : 14, gap: 10 }}>
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
          <Text style={s.small}>{tr('Your conversation saves automatically.')}</Text>
        </View>
      )}
      {groups.map((event, i) => {
        // A failed or stopped turn's reply is the server's own sentence, which has a translation.
        const failed = event.role === 'assistant' && !!event.failed;
        const body = (
          <>
            <Text
              style={{
                ...s.small,
                color: event.role === 'user' ? color.onInk : color.muted,
              }}
            >
              {event.role === 'user' ? tr('You') : tr('Sous-chef')}
              {event.imageCount ? tr('recipePhotos', { count: event.imageCount }) : ''}
            </Text>
            <Text
              selectable
              style={{
                ...s.body,
                color: event.role === 'user' ? color.white : failed ? color.error : color.ink,
              }}
            >
              {failed ? tr(event.content) : event.content}
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
                    <Text style={s.small}>{tr('minuteCount', { count: r.minutes })}</Text>
                  </Press>
                ))}
              </ScrollView>
            )}
            {event.receipts.length > 0 && (
              <Receipts
                receipts={event.receipts}
                undoing={undoing}
                onView={viewReceipt}
                onUndo={(r) => void undoReceipt(r)}
              />
            )}
          </>
        );
        // The last reply, if it failed, offers to send the message before it again.
        const retry =
          failed && i === groups.length - 1 && ready
            ? groups
                .slice(0, i)
                .reverse()
                .find((g) => g.role === 'user')?.content
            : undefined;
        return (
          <React.Fragment key={event.seq}>
            {event.role === 'user' ? (
              <View style={[bubble, { alignSelf: 'flex-end', backgroundColor: color.ink }]}>
                {body}
              </View>
            ) : (
              <Reply
                grow={event.seq === grown}
                onGrown={settled}
                tone={failed ? 'error' : undefined}
              >
                {body}
              </Reply>
            )}
            {!!retry && (
              <Button
                title={tr('Try again')}
                icon={RotateCcw}
                small
                variant="secondary"
                style={{ alignSelf: 'flex-start' }}
                onPress={() => void send(retry, null)}
              />
            )}
            {i === draftAt && draft}
          </React.Fragment>
        );
      })}
      {/* The question the sous-chef waits on can be answered with a tap; the server does what it
          described on yes, whatever the model makes of it. */}
      {!!question && ready && groups[groups.length - 1]?.role === 'assistant' && (
        <View style={[s.row, { gap: 8, alignSelf: 'flex-start' }]}>
          {(['yes', 'no'] as const).map((answer) => {
            const title =
              question.kind === 'publish'
                ? answer === 'yes'
                  ? tr('Publish')
                  : tr('Not now')
                : answer === 'yes'
                  ? tr('Yes')
                  : tr('No');
            return (
              <Button
                key={answer}
                title={title}
                small
                variant={answer === 'yes' ? 'primary' : 'secondary'}
                onPress={() => void send(title, null, false, { answer, question: question.seq })}
              />
            );
          })}
        </View>
      )}
      {thinking && <Thinking />}
      {thinking && (
        <ThinkingCaption
          step={project?.turn?.step}
          stopping={project?.turn?.stopping}
          onStop={() => void stopTurn()}
        />
      )}
      {runningVoice && (
        <Text style={[s.small, { textAlign: 'center' }]}>
          {tr('Voice is processed live. We save your transcript, not an audio recording.')}
        </Text>
      )}
    </>
  );
  const composer = (
    <>
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
      {/* It follows what's open, so "this" means the page or recipe in front of you. */}
      <View style={{ gap: 8 }}>
        <View style={[s.row, { gap: 6, paddingHorizontal: 6 }]}>
          {writing ? (
            <PenLine size={15} color={color.muted} />
          ) : (
            <Eye size={15} color={color.muted} />
          )}
          <Text numberOfLines={1} style={[s.small, { flex: 1 }]}>
            {writing
              ? tr('New recipe')
              : context.recipe
                ? context.cookingStep
                  ? tr('Cooking {{v0}} · step {{v1}}', {
                      v0: context.recipe.title,
                      v1: context.cookingStep,
                    })
                  : tr('Viewing {{v0}}', { v0: context.recipe.title })
                : tr('Viewing {{v0}}', { v0: context.title })}
          </Text>
        </View>
        {!!nearby.length && !runningVoice && !writing && (
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
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: 2,
          padding: 6,
          backgroundColor: color.white,
          borderRadius: 26,
          borderWidth: 1,
          // The composer is the message field's edge.
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
          placeholder={
            attachment
              ? tr('Add a note (optional)…')
              : writing
                ? tr('Type your recipe…')
                : tr('Ask anything…')
          }
          placeholderTextColor={color.soft}
          value={text}
          onChangeText={setText}
          // Opening the panel puts the cursor straight in; a sheet waits for a tap.
          autoFocus={floating}
          multiline
          // One line until it needs more; the web textarea doesn't grow on its own.
          numberOfLines={1}
          onContentSizeChange={(e) => setInputHeight(Math.ceil(e.nativeEvent.contentSize.height))}
          maxLength={24000}
          style={{
            ...s.body,
            flex: 1,
            minHeight: 40,
            maxHeight: 132,
            height: Platform.OS === 'web' ? Math.min(132, Math.max(40, inputHeight)) : undefined,
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
      {project?.recipe && !project.recipe.published && (
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
    </>
  );
  const errors = (
    <>
      {!!error && (
        <Text accessibilityRole="alert" style={{ ...s.muted, color: color.error }}>
          {tr(error)}
        </Text>
      )}
      {voiceLost && !!error && !runningVoice && (
        <Button
          title={tr('Resume voice')}
          icon={AudioLines}
          small
          variant="ghost"
          style={{ alignSelf: 'flex-start' }}
          onPress={() => void startVoice()}
        />
      )}
      {!!project?.error && project.error !== error && !lastFailed && (
        <Text accessibilityRole="alert" style={{ ...s.muted, color: color.error }}>
          {tr(project.error)}
        </Text>
      )}
    </>
  );
  const cameraView = (
    <RecipeCamera onPhoto={(uri) => void upload(uri)} onCancel={() => setCamera(false)} />
  );
  const title = camera ? tr('Take a photo') : tr('Sous-chef');
  const avatar = <SousChefMark />;
  // Live voice keeps the header to what matters: on a sheet, stepping aside to keep talking.
  const actions = runningVoice ? (
    !floating && (
      <IconButton
        icon={Minimize2}
        plain
        size={36}
        label={tr('Keep talking while you browse')}
        onPress={minimize}
      />
    )
  ) : (
    <>
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
        disabled={busy}
        onPress={() => void create()}
      />
    </>
  );
  const body = camera ? (
    cameraView
  ) : browsing ? (
    <>
      <Text style={s.label}>{tr('Earlier conversations')}</Text>
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
              n > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line },
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
      <Button
        title={tr('Back to conversation')}
        variant="ghost"
        small
        onPress={() => setBrowsing(false)}
        style={{ alignSelf: 'flex-start' }}
      />
    </>
  ) : (
    <>
      {messages}
      {busy && <ActivityIndicator color={color.ink} />}
      {draftAt < 0 && draft}
    </>
  );
  return (
    <>
      {/* The panel folds into the launcher, unless a live conversation keeps going; a sheet always
          leaves a pill to come back to. */}
      {hidden && (runningVoice || !floating) && (
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
      {/* The same conversation, header and composer either way: a panel beside the page in a
          desktop browser, a bottom sheet on phones. */}
      {dock.panel && shown && (
        <Animated.View
          ref={panel}
          role="dialog"
          aria-label={tr('Sous-chef')}
          style={{
            position: 'absolute',
            right: dock.right,
            bottom: dock.bottom,
            width: dock.panel.width,
            height: dock.panel.height,
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
            <View style={{ marginRight: 8 }}>{avatar}</View>
            <Text accessibilityRole="header" numberOfLines={1} style={[s.h3, { flex: 1 }]}>
              {title}
            </Text>
            {actions}
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
            {body}
            {errors}
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
              {voiceBar || composer}
            </View>
          )}
        </Animated.View>
      )}
      {!dock.panel && (
        <Dialog
          visible={!hidden}
          onClose={exit}
          title={title}
          leading={avatar}
          actions={!camera && actions}
          footer={chatting && (voiceBar || composer)}
          stickToEnd={chatting}
        >
          <View style={{ gap: 12 }}>
            {body}
            {errors}
          </View>
        </Dialog>
      )}
    </>
  );
}
