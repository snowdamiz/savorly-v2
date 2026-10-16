import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Animated, Platform, Text, TextInput, View } from 'react-native';
import { ArrowRight, ArrowUp, ChevronRight, RotateCcw, Sparkles } from 'lucide-react-native';
import { AIJob, AIKind, AIRequest, RecipeInput, emptyRecipe } from '../lib/types';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { requestKey } from '../lib/utils';
import { color, font, radius, s, shadow } from '../lib/theme';
import { Button, Chip, Dialog, Empty, FoodImage, IconButton, Pill, Press } from './ui';
import { VideoPlayer } from './VideoPlayer';
const finished = (j: AIJob) => j.status === 'completed' || j.status === 'failed';
const askOf = (prompt: string) => prompt.split('\n\nContext:')[0].split('\nDietary preferences')[0];
const kindLabel: Record<AIKind, string> = {
  recipe: 'New recipe',
  adapt: 'Your version',
  substitute: 'Ingredient swap',
  nutrition: 'Nutrition estimate',
  plan: 'Meal plan',
  assistant: 'Cooking question',
  image: 'Food photo',
  video: 'Recipe clip',
};
function Thinking({ video }: { video: boolean }) {
  const { t: tr } = useI18n();
  const a = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(a, { toValue: 1, duration: 1300, useNativeDriver: Platform.OS !== 'web' }),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  return (
    <View accessibilityLiveRegion="polite" style={[s.card, { gap: 12 }]}>
      <View style={[s.row, { gap: 6 }]}>
        {[0, 1, 2].map((i) => (
          <Animated.View
            key={i}
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: color.ink,
              opacity: a.interpolate({
                inputRange: [0, 0.2 + i * 0.2, 0.4 + i * 0.2, 1],
                outputRange: [0.2, 1, 0.2, 0.2],
              }),
            }}
          />
        ))}
      </View>
      <Text style={s.h3}>{video ? tr('Filming your clip…') : tr('Thinking it through…')}</Text>
    </View>
  );
}
export function JobResult({
  job,
  onRecipe,
  onMedia,
}: {
  job: AIJob;
  onRecipe: (r: RecipeInput) => void;
  onMedia?: (url: string) => void;
}) {
  const { t: tr } = useI18n();
  const r = job.result;
  if (r.recipe)
    return (
      <View style={[s.card, { gap: 10 }]}>
        <Text style={s.label}>{tr(kindLabel[job.kind])}</Text>
        <Text style={s.h2}>{r.recipe.title}</Text>
        <Text numberOfLines={4} style={s.muted}>
          {r.recipe.description}
        </Text>
        <Text style={s.small}>
          {tr('{{v0}} min · {{v1}} servings · {{v2}} ingredients', {
            v0: r.recipe.minutes,
            v1: r.recipe.servings,
            v2: r.recipe.ingredients.length,
          })}
        </Text>
        <Text numberOfLines={2} style={[s.small, { color: color.ink }]}>
          {r.recipe.ingredients.map((i) => i.name).join(' · ')}
        </Text>
        <Button
          title={tr('Open in editor')}
          icon={ArrowRight}
          onPress={() => onRecipe(r.recipe!)}
          style={{ marginTop: 6 }}
        />
      </View>
    );
  // A touch-up is already where it was asked for; history just shows it.
  if (r.url && job.source)
    return <FoodImage uri={r.url} style={{ height: 300, borderRadius: radius.lg }} />;
  if (r.url && (job.kind === 'image' || job.kind === 'video')) {
    const image = job.kind === 'image';
    return (
      <View style={{ gap: 12 }}>
        {image ? (
          <FoodImage uri={r.url} style={{ height: 300, borderRadius: radius.lg }} />
        ) : (
          <VideoPlayer uri={r.url} />
        )}
        <Button
          title={
            onMedia
              ? image
                ? tr('Use this photo')
                : tr('Use this clip')
              : tr('Start a recipe with it')
          }
          icon={ArrowRight}
          onPress={() =>
            onMedia
              ? onMedia(r.url!)
              : onRecipe({
                  ...emptyRecipe(),
                  [image ? 'image' : 'video']: r.url,
                  aiGenerated: true,
                })
          }
        />
      </View>
    );
  }
  if (r.text)
    return (
      <View style={s.card}>
        <Text selectable style={[s.body, { lineHeight: 25 }]}>
          {r.text}
        </Text>
      </View>
    );
  return null;
}
export function SousChef({
  request,
  onClose,
  onRecipe,
}: {
  request: AIRequest;
  onClose: () => void;
  onRecipe: (r: RecipeInput) => void;
}) {
  const { t: tr, number, language } = useI18n();
  const app = useApp();
  const { kind } = request;
  const [prompt, setPrompt] = useState(() => tr(request.prompt || ''));
  const [job, setJob] = useState<AIJob | null>(null);
  const [error, setError] = useState('');
  const enabled =
    kind === 'video'
      ? app.capabilities?.videoAI
      : kind === 'image'
        ? app.capabilities?.imageAI
        : app.capabilities?.textAI;
  const prepare = (ask: string) => {
    const prefs =
      kind === 'image' || kind === 'video'
        ? ''
        : `\nDietary preferences (always verify ingredient labels): ${JSON.stringify(app.user?.preferences || {})}`;
    const body = `${ask}\nPlease respond in ${language}.${request.context ? `\n\nContext: ${request.context}` : ''}${prefs}`;
    return { kind, prompt: body.slice(0, 12000), key: requestKey() };
  };
  // Capture each submission once, including its idempotency key. Effect replay must not create
  // another paid job, and changing language/profile while it runs must not resubmit it.
  const [submission, setSubmission] = useState(() =>
    prompt.trim().length >= 3 && enabled && app.user ? prepare(prompt.trim()) : null,
  );
  const busy = submission !== null;
  const run = (text: string) => {
    const ask = text.trim();
    if (busy || ask.length < 3 || !enabled || !app.requireUser()) return;
    setPrompt(ask);
    setError('');
    setSubmission(prepare(ask));
  };
  useEffect(() => {
    if (!submission) return;
    let active = true;
    api<AIJob>('/ai/jobs', {
      method: 'POST',
      body: { kind: submission.kind, prompt: submission.prompt },
      headers: { 'Idempotency-Key': submission.key },
    })
      .then((next) => {
        if (active) setJob(next);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setSubmission(null);
      });
    return () => {
      active = false;
    };
  }, [submission]);
  useEffect(() => {
    if (!job || finished(job)) return;
    let alive = true;
    const timer = setInterval(
      () => {
        api<AIJob[]>('/ai/jobs')
          .then((all) => {
            const next = all.find((j) => j.id === job.id);
            if (alive && next) setJob(next);
          })
          .catch(() => {});
      },
      job.kind === 'video' ? 5000 : 2000,
    );
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [job]);
  return (
    <Dialog visible onClose={onClose}>
      <View style={{ gap: 8 }}>
        <View style={[s.row, { gap: 8 }]}>
          <View
            style={{
              width: 26,
              height: 26,
              borderRadius: 13,
              backgroundColor: color.ink,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Sparkles size={13} color={color.white} strokeWidth={2.2} />
          </View>
          <Text style={s.label}>{tr('Sous-chef')}</Text>
        </View>
        <Text style={[s.h2, { fontSize: 22, lineHeight: 28 }]}>{tr(request.title)}</Text>
      </View>
      {!enabled && (
        <View
          style={{ backgroundColor: color.warningBg, borderRadius: radius.md, padding: 16, gap: 4 }}
        >
          <Text style={[s.h3, { color: color.warning, fontSize: 14 }]}>
            {tr('Not connected yet')}
          </Text>
          <Text style={[s.muted, { color: color.warning }]}>
            {kind === 'video'
              ? tr('Video needs a reAPI key on the server.')
              : tr('The sous-chef needs an OpenRouter key on the server.')}
          </Text>
        </View>
      )}
      {job ? (
        <>
          <View
            style={{
              alignSelf: 'flex-end',
              maxWidth: '88%',
              backgroundColor: color.ink,
              borderRadius: 22,
              borderBottomRightRadius: 6,
              paddingHorizontal: 16,
              paddingVertical: 11,
            }}
          >
            <Text style={[s.body, { color: color.white }]}>{prompt}</Text>
          </View>
          {!finished(job) ? (
            <Thinking video={kind === 'video'} />
          ) : job.status === 'failed' ? (
            <View
              style={{
                backgroundColor: color.errorBg,
                borderRadius: radius.md,
                padding: 16,
                gap: 10,
              }}
            >
              <Text style={[s.body, { color: color.error }]}>{job.error}</Text>
              <Button
                title={tr('Try again')}
                small
                icon={RotateCcw}
                onPress={() => void run(prompt)}
              />
            </View>
          ) : (
            <JobResult
              job={job}
              onRecipe={onRecipe}
              onMedia={
                request.onMedia &&
                ((url) => {
                  request.onMedia!(url);
                  onClose();
                })
              }
            />
          )}
          {finished(job) && (
            <Button
              title={tr('Ask something else')}
              variant="ghost"
              icon={RotateCcw}
              onPress={() => {
                setJob(null);
                setPrompt('');
              }}
            />
          )}
        </>
      ) : (
        <View
          style={{ gap: 16, opacity: enabled ? 1 : 0.45, pointerEvents: enabled ? 'auto' : 'none' }}
        >
          {!!request.suggestions?.length && (
            <View style={{ gap: 10 }}>
              <Text style={s.small}>{tr('Tap to ask')}</Text>
              <View style={[s.wrap, { gap: 8 }]}>
                {request.suggestions.map((t) => (
                  <Chip key={t} title={tr(t)} onPress={() => void run(tr(t))} />
                ))}
              </View>
            </View>
          )}
          <View
            style={{
              backgroundColor: color.white,
              borderRadius: 26,
              padding: 8,
              paddingLeft: 18,
              flexDirection: 'row',
              alignItems: 'flex-end',
              gap: 10,
              boxShadow: shadow.card,
            }}
          >
            <TextInput
              accessibilityLabel={tr('Your request')}
              value={prompt}
              onChangeText={setPrompt}
              placeholder={
                (request.placeholder ? tr(request.placeholder) : '') ||
                tr('Or ask in your own words…')
              }
              placeholderTextColor={color.soft}
              multiline
              maxLength={4000}
              style={{
                flex: 1,
                minHeight: 44,
                maxHeight: 160,
                paddingVertical: 11,
                fontFamily: font.medium,
                fontSize: 15,
                color: color.ink,
              }}
            />
            {busy ? (
              <View
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
              >
                <ActivityIndicator color={color.ink} />
              </View>
            ) : (
              <IconButton
                icon={ArrowUp}
                label={tr('Ask the sous-chef')}
                selected
                disabled={prompt.trim().length < 3}
                onPress={() => void run(prompt)}
              />
            )}
          </View>
          {kind === 'video' && (
            <Text style={s.small}>
              {tr('5-second clip · 720p · about {{v0}}', {
                v0: number(app.capabilities?.videoEstimateUSD || 1.005, {
                  style: 'currency',
                  currency: 'USD',
                }),
              })}
            </Text>
          )}
        </View>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={[s.body, { color: color.error }]}>
          {tr(error)}
        </Text>
      )}
      <Text style={[s.small, { fontFamily: font.medium }]}>
        {tr('AI suggestions can be wrong. Check allergens, doneness and labels yourself.')}
      </Text>
    </Dialog>
  );
}
export function SousChefHistory({
  visible,
  onClose,
  onRecipe,
}: {
  visible: boolean;
  onClose: () => void;
  onRecipe: (r: RecipeInput) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [jobs, setJobs] = useState<AIJob[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!visible || !app.user) return;
    let active = true;
    api<AIJob[]>('/ai/jobs')
      .then((next) => {
        if (!active) return;
        setJobs(next);
        setError('');
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [visible, app.user]);
  return (
    <Dialog visible={visible} onClose={onClose} title={tr('Sous-chef history')}>
      {!!error && <Text style={[s.body, { color: color.error }]}>{tr(error)}</Text>}
      {!jobs ? (
        !error && <ActivityIndicator color={color.ink} />
      ) : !jobs.length ? (
        <Empty
          title={tr('Nothing cooked up yet')}
          text={tr(
            'Ask for a swap, a twist or a whole recipe from any recipe, your pantry or the planner.',
          )}
          icon={Sparkles}
        />
      ) : (
        jobs.map((j) => (
          <View key={j.id} style={{ gap: 10, paddingBottom: 8 }}>
            <View style={s.between}>
              <Text style={s.label}>{j.source ? tr('Photo touch-up') : tr(kindLabel[j.kind])}</Text>
              <Pill
                title={
                  j.status === 'completed'
                    ? tr('Ready')
                    : j.status === 'failed'
                      ? tr('Failed')
                      : tr('Working')
                }
                tone={
                  j.status === 'completed' ? 'success' : j.status === 'failed' ? 'error' : 'light'
                }
              />
            </View>
            {/* A touch-up's prompt is Savorly's instructions, not something the cook wrote. */}
            {!j.source && (
              <Text numberOfLines={2} style={s.h3}>
                {askOf(j.prompt)}
              </Text>
            )}
            {j.status === 'failed' ? (
              <Text style={[s.muted, { color: color.error }]}>{j.error}</Text>
            ) : (
              j.status === 'completed' && <JobResult job={j} onRecipe={onRecipe} />
            )}
          </View>
        ))
      )}
    </Dialog>
  );
}
// The inline entry point used across the app: one tap opens the sheet with relevant suggestions.
export function AskCard({
  title,
  text,
  onPress,
}: {
  title: string;
  text: string;
  onPress: () => void;
}) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      scale={0.98}
      style={[s.card, s.row, { gap: 14, padding: 16 }]}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: color.ink,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Sparkles size={19} color={color.white} strokeWidth={2} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.h3}>{title}</Text>
        <Text style={[s.small, { fontFamily: font.medium, lineHeight: 17 }]}>{text}</Text>
      </View>
      <ChevronRight size={18} color={color.soft} />
    </Press>
  );
}
