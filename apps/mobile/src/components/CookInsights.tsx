import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../lib/api';
import { AuthorInsights, cooksNeed, StepInsight, StepQuestion } from '../lib/cookInsights';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { Recipe } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
import { Check, ChevronDown, Eye, EyeOff, Hourglass, Pencil, Timer } from './icons';
import { SwitchRow } from './NotificationSettings';
import { FixReview, fixTitle } from './RecipeFixes';
import { Suggestion } from '../lib/recipeFixes';
import { Button, Dialog, Field, IconButton } from './ui';

/**
 * The questions cooks keep asking at a step, under a small label: each a row that opens to its
 * answer, so a step reads as it always did until the cook wants to know. Nothing without any.
 */
export function StepQuestions({ insight, dark }: { insight?: StepInsight; dark?: boolean }) {
  const { t: tr } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const questions = insight?.questions ?? [];
  if (!questions.length) return null;
  const ink = dark ? color.white : color.ink;
  const muted = dark ? color.onInk : color.muted;
  const rule = dark ? 'rgba(255,255,255,0.12)' : color.line;
  return (
    <View style={{ marginTop: 6 }}>
      <Text style={[s.label, { color: muted, marginBottom: 2 }]}>{tr('Often asked here')}</Text>
      {questions.map((q, i) => {
        const shown = open === q.id;
        return (
          <View
            key={q.id}
            style={i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: rule }}
          >
            <Pressable
              accessibilityRole="button"
              aria-expanded={shown}
              onPress={() => setOpen(shown ? null : q.id)}
              style={[s.row, { gap: 10, paddingVertical: 10 }]}
            >
              <Text
                style={{
                  flex: 1,
                  color: ink,
                  fontFamily: font.semibold,
                  fontSize: 15,
                  lineHeight: 21,
                }}
              >
                {q.question}
              </Text>
              <ChevronDown
                size={18}
                color={muted}
                style={{ transform: [{ rotate: shown ? '180deg' : '0deg' }] }}
              />
            </Pressable>
            {shown && (
              <View style={{ gap: 4, paddingBottom: 12 }}>
                <Text
                  style={{
                    color: dark ? 'rgba(255,255,255,0.82)' : '#3A3A3A',
                    fontFamily: font.regular,
                    fontSize: 15,
                    lineHeight: 22,
                  }}
                >
                  {q.answer}
                </Text>
                <Text style={[s.small, { color: muted, fontSize: 11 }]}>
                  {q.checked ? tr('Answered by the cook') : tr('Answered by the sous-chef')}
                </Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

/**
 * A step's timer on the recipe page ("Timer for 8 min in cooking mode"), and how long cooks
 * really need where they run over it, on the same line.
 */
export function StepTimerHint({ seconds, insight }: { seconds: number; insight?: StepInsight }) {
  const { t: tr } = useI18n();
  if (!seconds) return null;
  const need = cooksNeed(insight);
  return (
    <View style={[s.row, { gap: 6, marginTop: 2 }]}>
      <Timer size={14} color={color.muted} />
      <Text style={[s.small, { flex: 1 }]}>
        {need
          ? tr('timerHintCooks', { count: Math.round(seconds / 60), cooks: need / 60 })
          : tr('timerHint', { count: Math.round(seconds / 60) })}
      </Text>
    </View>
  );
}

/**
 * How long a step without a timer usually takes cooks, as one quiet line ("Cooks usually spend
 * about 12 minutes here"). Steps with a timer say it beside the timer instead.
 */
export function StepUsual({ insight, dark }: { insight?: StepInsight; dark?: boolean }) {
  const { t: tr } = useI18n();
  if (insight?.note?.kind !== 'usual') return null;
  const muted = dark ? color.onInk : color.muted;
  return (
    <View style={[s.row, { gap: 6 }]}>
      <Hourglass size={14} color={muted} strokeWidth={2} />
      <Text style={[s.small, { flex: 1, color: muted }]}>
        {tr('stepNoteUsual', { count: insight.note.minutes })}
      </Text>
    </View>
  );
}

/**
 * Under cooking mode's timer, when cooks run over it: how long they usually need, and a tap that
 * sets the timer to it while it hasn't started.
 */
export function TimerNote({ seconds, onUse }: { seconds: number; onUse?: () => void }) {
  const { t: tr } = useI18n();
  const minutes = Math.round(seconds / 60);
  return (
    <View style={[s.row, { gap: 8, justifyContent: 'center', flexWrap: 'wrap' }]}>
      <Hourglass size={14} color={color.onInk} strokeWidth={2} />
      <Text style={[s.small, { color: color.onInk }]}>
        {tr('cooksNeedAbout', { count: minutes })}
      </Text>
      {onUse && (
        <Pressable
          accessibilityRole="button"
          onPress={onUse}
          hitSlop={8}
          style={{ paddingHorizontal: 4 }}
        >
          <Text style={[s.small, { color: color.white, textDecorationLine: 'underline' }]}>
            {tr('setTimerTo', { count: minutes })}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * "Where cooks get stuck", for a recipe's author: each step with how long cooks really take
 * against its timer, how many who reached it stopped there, and the questions cooks keep asking,
 * which the author can answer in their own words, approve or hide. Editing a step starts its
 * numbers afresh.
 */
export function CooksGetStuck({
  recipe,
  visible,
  onClose,
  onEdit,
  fixes,
  onFixed,
  onHistory,
}: {
  recipe: Recipe;
  visible: boolean;
  onClose: () => void;
  onEdit: () => void;
  /** What cooks suggest changing (docs/RECIPE-FIXES.md), each under the step it changes. */
  fixes?: { suggestions: Suggestion[]; reload: () => void };
  /** The recipe changed: a suggestion was accepted. */
  onFixed?: () => void;
  /** Opens how cooks improved it, once the author accepted a fix. */
  onHistory?: () => void;
}) {
  const { t: tr } = useI18n();
  const [view, setView] = useState<AuthorInsights | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!visible) return;
    let live = true;
    api<AuthorInsights>(`/recipes/${encodeURIComponent(recipe.id)}/insights/author`)
      .then((v) => {
        if (!live) return;
        setView(v);
        setError('');
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [visible, recipe.id]);
  const replace = (q: StepQuestion) =>
    setView(
      (v) =>
        v && {
          ...v,
          steps: v.steps.map((st) => ({
            ...st,
            questions: st.questions.map((x) => (x.id === q.id ? { ...x, ...q } : x)),
          })),
        },
    );
  const anything = !!view?.steps.some((st) => st.sessions > 0 || st.questions.length);
  const suggestions = fixes?.suggestions ?? [];
  const answered = (accepted: boolean) => {
    fixes?.reload();
    if (accepted) onFixed?.();
  };
  // A step's suggestions go under it; ingredients, new steps and what no longer fits go first.
  const atStep = (n: number) =>
    suggestions.filter((f) => f.part === 'step' && f.fits && f.place === n);
  const elsewhere = suggestions.filter((f) => f.part !== 'step' || !f.fits);
  return (
    <Dialog visible={visible} onClose={onClose} title={tr('Where cooks get stuck')}>
      <Text style={s.muted}>
        {tr(
          'How cooks get on with this recipe in cooking mode. A step’s numbers show once 5 cooks have spent time on it, and a question once 3 cooks have asked it.',
        )}
      </Text>
      {!!error && <Text style={[s.small, { color: color.error }]}>{tr(error)}</Text>}
      {!view && !error && <ActivityIndicator color={color.ink} />}
      {view && (
        <>
          {view.finishRate !== null && (
            <Text style={[s.body, { fontFamily: font.semibold }]}>
              {tr('finishedOfStarted', { count: view.sessions, finished: view.finished })}
            </Text>
          )}
          {!anything && !suggestions.length && (
            <Text style={s.muted}>
              {tr('Nobody has cooked enough of this recipe in cooking mode for numbers yet.')}
            </Text>
          )}
          {!!elsewhere.length && (
            <View style={[s.card, { gap: 8 }]}>
              <Text style={s.h3}>{tr('Suggested by cooks')}</Text>
              {elsewhere.map((f) => (
                <FixReview key={f.id} fix={f} title={fixTitle(tr, f)} onAnswered={answered} />
              ))}
            </View>
          )}
          {view.steps.map((st) => (
            <StuckStep
              key={st.step}
              insight={st}
              title={recipe.steps[st.step - 1]?.title ?? ''}
              recipeId={recipe.id}
              onChanged={replace}
              onEdit={onEdit}
            >
              {atStep(st.step).map((f) => (
                <FixReview key={f.id} fix={f} onAnswered={answered} />
              ))}
            </StuckStep>
          ))}
          {onHistory && (
            <Button
              title={tr('How cooks improved it')}
              variant="ghost"
              small
              style={{ alignSelf: 'flex-start', marginLeft: -12 }}
              onPress={onHistory}
            />
          )}
        </>
      )}
    </Dialog>
  );
}

function StuckStep({
  insight,
  title,
  recipeId,
  onChanged,
  onEdit,
  children,
}: {
  insight: StepInsight;
  title: string;
  recipeId: string;
  onChanged: (q: StepQuestion) => void;
  onEdit: () => void;
  /** What cooks suggest changing in this step. */
  children?: React.ReactNode;
}) {
  const { t: tr } = useI18n();
  const minutes = Math.round((insight.medianSeconds ?? 0) / 60);
  // Running over its timer is what the author most needs to see, so that line stands out.
  const over = insight.note?.kind === 'longer';
  const time =
    insight.sessions > 0 &&
    (insight.timerSeconds > 0
      ? tr('stepTakesTimer', {
          count: Math.max(1, minutes),
          timer: Math.round(insight.timerSeconds / 60),
        })
      : tr('stepTakes', { count: Math.max(1, minutes) }));
  return (
    <View style={[s.card, { gap: 8 }]}>
      <View style={[s.row, { gap: 8 }]}>
        <Text style={[s.h3, { flex: 1 }]}>
          {tr('Step {{v0}}: {{v1}}', { v0: insight.step, v1: title })}
        </Text>
        <IconButton icon={Pencil} label={tr('Edit this step')} size={36} plain onPress={onEdit} />
      </View>
      {time && (
        <Text style={[s.small, over && { color: color.warning, fontFamily: font.bold }]}>
          {time}
        </Text>
      )}
      {!!insight.entered && (
        <Text style={s.small}>
          {tr('stoppedHere', { count: insight.entered, stopped: insight.gaveUp ?? 0 })}
        </Text>
      )}
      {!time && !insight.entered && (
        <Text style={s.small}>{tr('Not enough cooks have reached this step yet.')}</Text>
      )}
      {insight.questions.map((q) => (
        <StuckQuestion key={q.id} question={q} recipeId={recipeId} onChanged={onChanged} />
      ))}
      {children}
    </View>
  );
}

function StuckQuestion({
  question,
  recipeId,
  onChanged,
}: {
  question: StepQuestion;
  recipeId: string;
  onChanged: (q: StepQuestion) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [editing, setEditing] = useState(false);
  const [answer, setAnswer] = useState(question.answer);
  const [busy, setBusy] = useState(false);
  const change = (body: Record<string, unknown>, message: string) => {
    if (busy) return;
    setBusy(true);
    void app
      .act(async () => {
        const q = await api<StepQuestion>(
          `/recipes/${encodeURIComponent(recipeId)}/insights/questions/${encodeURIComponent(question.id)}`,
          { method: 'PATCH', body },
        );
        onChanged(q);
        setEditing(false);
      }, message)
      .finally(() => setBusy(false));
  };
  return (
    <View
      style={{
        gap: 6,
        padding: 12,
        borderRadius: radius.md,
        backgroundColor: color.bg,
        opacity: question.hidden ? 0.6 : 1,
      }}
    >
      <Text style={[s.small, { color: color.ink, fontFamily: font.semibold }]}>
        {question.question}
      </Text>
      <Text style={[s.small, { fontSize: 11 }]}>
        {tr('askedByCooks', { count: question.askers ?? 0 })}
        {question.hidden ? ` · ${tr('Hidden from cooks')}` : ''}
      </Text>
      {editing ? (
        <>
          <Field
            label={tr('Your answer')}
            value={answer}
            onChangeText={setAnswer}
            multiline
            maxLength={1000}
          />
          <View style={[s.row, { gap: 8 }]}>
            <Button
              title={tr('Save answer')}
              small
              busy={busy}
              disabled={answer.trim().length < 2}
              onPress={() => change({ answer: answer.trim() }, 'Your answer is saved.')}
            />
            <Button
              title={tr('Cancel')}
              variant="ghost"
              small
              onPress={() => {
                setAnswer(question.answer);
                setEditing(false);
              }}
            />
          </View>
        </>
      ) : (
        <>
          <Text style={s.small}>{question.answer || tr('No answer yet.')}</Text>
          <Text style={[s.small, { fontSize: 11 }]}>
            {question.checked ? tr('Answered by you') : tr('Answered by the sous-chef')}
          </Text>
          <View style={[s.row, { gap: 8 }]}>
            {!question.checked && !!question.answer && (
              <Button
                title={tr('Approve answer')}
                icon={Check}
                variant="secondary"
                small
                busy={busy}
                onPress={() => change({ approve: true }, 'Approved.')}
              />
            )}
            <Button
              title={tr('Edit answer')}
              icon={Pencil}
              variant="secondary"
              small
              onPress={() => setEditing(true)}
            />
            <View style={{ flex: 1 }} />
            <IconButton
              icon={question.hidden ? Eye : EyeOff}
              label={question.hidden ? tr('Show to cooks') : tr('Hide from cooks')}
              size={36}
              plain
              disabled={busy}
              onPress={() =>
                change(
                  { hidden: !question.hidden },
                  question.hidden ? 'Cooks see this question again.' : 'Hidden from cooks.',
                )
              }
            />
          </View>
        </>
      )}
    </View>
  );
}

/**
 * Whether the member's cooking counts toward recipes' insights: on unless turned off. Off, the
 * server also takes back what their cooking already added.
 */
export function ShareCooking({ bare }: { bare?: boolean }) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [changed, setChanged] = useState<boolean | null>(null);
  if (!app.user) return null;
  const on = changed ?? app.user.preferences.shareCooking !== false;
  return (
    <View style={bare ? undefined : [s.card, { paddingVertical: 4 }]}>
      <SwitchRow
        title={tr('Share how my cooking goes')}
        text={tr(
          'Cooking mode notes how long your steps take and keeps what you ask the sous-chef, so recipes can show what cooks found. Nobody sees your own numbers or words. Turning it off removes what you’ve shared.',
        )}
        value={on}
        onChange={() => {
          const next = !on;
          setChanged(next);
          void app
            .act(async () => {
              await api('/me/preferences', { method: 'PATCH', body: { shareCooking: next } });
              await app.refreshUser();
            })
            .then((ok) => !ok && setChanged(null));
        }}
      />
    </View>
  );
}
