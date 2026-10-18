import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { Recipe } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
import {
  FixDraft,
  FixKind,
  FixPart,
  fixPart,
  FixVersion,
  minutesOf,
  sendSuggestion,
  Suggestion,
} from '../lib/recipeFixes';
import { Check, ChevronDown, Pencil, ThumbsUp, Undo2, X } from './icons';
import { keepEdit } from '../lib/yourVersion';
import { Button, Chip, Dialog, Field, IconButton } from './ui';

type Translate = ReturnType<typeof useI18n>['t'];

const kindLabel = (tr: Translate, kind: FixKind | '') =>
  ({
    time: tr('A step’s time'),
    heat: tr('Heat or method'),
    note: tr('A note'),
    missing_step: tr('A missing step'),
    amount: tr('An amount'),
    swap: tr('A swap that worked'),
    '': tr('A change'),
  })[kind];

/** An ingredient line as a cook reads it: "1.5 kg Tomatoes". */
const ingredientLine = (p: FixPart) =>
  [p.amount ? String(p.amount) : '', p.unit ?? '', p.name ?? ''].filter(Boolean).join(' ');

/** A fix in a few words, for its row: where it is and what it changes. */
export function fixTitle(
  tr: Translate,
  f: Pick<Suggestion, 'kind' | 'part' | 'place' | 'before' | 'after'>,
) {
  if (f.part === 'new_step')
    return f.place === 0
      ? tr('At the start: {{v0}}', { v0: f.after.title ?? '' })
      : tr('After step {{v0}}: {{v1}}', { v0: f.place, v1: f.after.title ?? '' });
  if (f.part === 'ingredient')
    return f.kind === 'amount'
      ? tr('{{v0}}: {{v1}} instead of {{v2}}', {
          v0: f.before.name ?? '',
          v1: ingredientLine({ ...f.after, name: '' }) || '0',
          v2: ingredientLine({ ...f.before, name: '' }) || '0',
        })
      : tr('{{v0}}: {{v1}}', { v0: f.before.name ?? '', v1: f.after.name ?? '' });
  if (f.kind === 'time' && f.after.seconds !== f.before.seconds)
    return tr('Step {{v0}}: {{v1}} min instead of {{v2}}', {
      v0: f.place,
      v1: minutesOf(f.after.seconds),
      v2: minutesOf(f.before.seconds),
    });
  return tr('Step {{v0}}: {{v1}}', { v0: f.place, v1: kindLabel(tr, f.kind).toLowerCase() });
}

/**
 * What a fix changes, as the part reads now and as suggested: the text where it changes, and the
 * timer where that changes, unless the row above already says so (`timer` false).
 */
function BeforeAfter({
  fix,
  timer = true,
}: {
  fix: Pick<Suggestion, 'part' | 'before' | 'after'>;
  timer?: boolean;
}) {
  const { t: tr } = useI18n();
  const { before, after } = fix;
  const ingredient = fix.part === 'ingredient';
  // Each line: its label, its text, and whether it's the suggestion (set in ink).
  const lines: [string, string, boolean][] = [];
  if (ingredient)
    lines.push(
      [tr('Now'), ingredientLine(before), false],
      [tr('Suggested'), ingredientLine(after), true],
    );
  else if (fix.part === 'new_step') lines.push([tr('Suggested'), after.text ?? '', true]);
  else if (after.text !== before.text)
    lines.push([tr('Now'), before.text ?? '', false], [tr('Suggested'), after.text ?? '', true]);
  if (timer && !ingredient && (after.seconds ?? 0) !== (before.seconds ?? 0) && after.seconds)
    lines.push([
      tr('Timer'),
      fix.part === 'new_step'
        ? tr('minuteCount', { count: minutesOf(after.seconds) })
        : tr('{{v0}} → {{v1}} min', {
            v0: minutesOf(before.seconds),
            v1: minutesOf(after.seconds),
          }),
      false,
    ]);
  return (
    <View style={{ gap: 6 }}>
      {lines.map(([label, text, suggested], i) => (
        <Text key={i} style={[s.small, suggested && { color: color.ink }]}>
          <Text style={{ fontFamily: font.bold }}>{label}</Text> {text}
        </Text>
      ))}
    </View>
  );
}

/**
 * What cooks who made the recipe suggest, under its method: each a row that opens to the change
 * and why, with "Same for me" for other cooks who made it, and a way to suggest one. Nothing for
 * a recipe without suggestions, unless the reader may make one.
 */
export function CooksSuggest({
  recipe,
  fixes,
  onSuggest,
}: {
  recipe: Recipe;
  fixes: {
    canSuggest: boolean;
    suggestions: Suggestion[];
    replace: (s: Suggestion) => void;
    reload: () => void;
  };
  onSuggest: () => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const { suggestions, canSuggest } = fixes;
  if (!suggestions.length && !canSuggest) return null;
  const vote = (sg: Suggestion) =>
    void app.act(async () =>
      fixes.replace(
        await api<Suggestion>(`/suggestions/${encodeURIComponent(sg.id)}/vote`, {
          method: sg.voted ? 'DELETE' : 'PUT',
        }),
      ),
    );
  const withdraw = (sg: Suggestion) =>
    void app.act(async () => {
      await api(`/suggestions/${encodeURIComponent(sg.id)}`, { method: 'DELETE' });
      fixes.reload();
    }, 'Your suggestion is withdrawn.');
  return (
    <View style={{ gap: 2, marginTop: 4 }}>
      {!!suggestions.length && (
        <Text style={[s.label, { marginBottom: 2 }]}>{tr('Suggested by cooks')}</Text>
      )}
      {suggestions.map((sg, i) => {
        const shown = open === sg.id;
        return (
          <View
            key={sg.id}
            style={i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line }}
          >
            <Pressable
              aria-expanded={shown}
              accessibilityRole="button"
              onPress={() => setOpen(shown ? null : sg.id)}
              style={[s.row, { gap: 10, paddingVertical: 10 }]}
            >
              <Text style={[styles.row, { flex: 1 }]}>{fixTitle(tr, sg)}</Text>
              {sg.votes > 0 && <Text style={s.small}>{tr('agreeCount', { count: sg.votes })}</Text>}
              <ChevronDown
                size={18}
                color={color.muted}
                style={{ transform: [{ rotate: shown ? '180deg' : '0deg' }] }}
              />
            </Pressable>
            {shown && (
              <View style={{ gap: 8, paddingBottom: 12 }}>
                <BeforeAfter fix={sg} timer={sg.kind !== 'time'} />
                {!!sg.reason && <Text style={styles.quote}>“{sg.reason}”</Text>}
                <Text style={[s.small, { fontSize: 11 }]}>
                  {sg.status === 'stale'
                    ? tr('A note from {{v0}}', { v0: sg.author.name })
                    : tr('Suggested by {{v0}}', { v0: sg.author.name })}
                </Text>
                {sg.mine ? (
                  <Button
                    title={tr('Withdraw')}
                    variant="ghost"
                    small
                    style={{ alignSelf: 'flex-start', marginLeft: -12 }}
                    onPress={() => withdraw(sg)}
                  />
                ) : (
                  canSuggest && (
                    <View style={{ alignSelf: 'flex-start' }}>
                      <Chip
                        title={tr('Same for me')}
                        icon={ThumbsUp}
                        active={sg.voted}
                        onPress={() => vote(sg)}
                      />
                    </View>
                  )
                )}
              </View>
            )}
          </View>
        );
      })}
      {canSuggest && (
        <Button
          title={tr('Suggest a change')}
          icon={Pencil}
          variant="ghost"
          small
          style={{ alignSelf: 'flex-start', marginLeft: -12, marginTop: 4 }}
          onPress={onSuggest}
        />
      )}
    </View>
  );
}

const kinds: FixKind[] = ['time', 'heat', 'note', 'missing_step', 'amount', 'swap'];

/**
 * Suggesting a change: what kind, which step or ingredient, and the change, with what happened.
 * `draft` opens it filled in, as after a cook where a step took longer than its timer. With mode
 * `mine` it keeps the change in the member's own version instead (docs/YOUR-VERSION.md), which
 * changes steps and ingredients but adds none.
 */
export function SuggestFix({
  recipe,
  visible,
  draft,
  mode = 'suggest',
  onClose,
  onSent,
}: {
  recipe: Recipe;
  visible: boolean;
  draft?: FixDraft | null;
  mode?: 'suggest' | 'mine';
  onClose: () => void;
  onSent: () => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [kind, setKind] = useState<FixKind>('time');
  const [place, setPlace] = useState(1);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const part = fixPart[kind];
  const mine = mode === 'mine';
  // Each part starts as it reads now, so the cook changes only what they mean to.
  const fill = (k: FixKind, n: number, change?: FixPart) => {
    const p = fixPart[k];
    const step = recipe.steps[n - 1];
    const ingredient = recipe.ingredients[n - 1];
    setFields(
      p === 'step'
        ? {
            text: change?.text ?? step?.text ?? '',
            minutes: String(minutesOf(change?.seconds ?? step?.seconds)),
            note: '',
          }
        : p === 'ingredient'
          ? {
              name: change?.name ?? ingredient?.name ?? '',
              amount: String(change?.amount ?? ingredient?.amount ?? ''),
              unit: change?.unit ?? ingredient?.unit ?? '',
            }
          : {
              title: change?.title ?? '',
              text: change?.text ?? '',
              minutes: change?.seconds ? String(minutesOf(change.seconds)) : '',
            },
    );
  };
  // Filled in each time it opens (with what cooking mode found, if anything); edits after that
  // are the cook's.
  const opening = visible ? (draft ?? null) : undefined;
  const [opened, setOpened] = useState<FixDraft | null | undefined>(undefined);
  if (opening !== opened) {
    setOpened(opening);
    if (opening !== undefined) {
      const k = opening?.kind ?? 'time';
      const n = (fixPart[k] === 'ingredient' ? opening?.ingredient : opening?.step) ?? 1;
      setKind(k);
      setPlace(n);
      setReason(opening?.reason ?? '');
      fill(k, n, opening?.change);
    }
  }
  const choose = (k: FixKind) => {
    const n = fixPart[k] === 'new_step' ? recipe.steps.length : 1;
    setKind(k);
    setPlace(n);
    fill(k, n);
  };
  const pick = (n: number) => {
    setPlace(n);
    fill(kind, n);
  };
  const set = (key: string) => (v: string) => setFields((f) => ({ ...f, [key]: v }));
  const number = (v?: string) => {
    const n = Number(String(v ?? '').replace(',', '.'));
    return Number.isFinite(n) ? n : undefined;
  };
  const change = (): FixPart => {
    if (part === 'ingredient')
      return { name: fields.name, amount: number(fields.amount), unit: fields.unit };
    const minutes = number(fields.minutes);
    const seconds = minutes === undefined ? undefined : Math.round(minutes * 60);
    if (part === 'new_step') return { title: fields.title, text: fields.text, seconds };
    if (kind === 'note')
      return { text: `${recipe.steps[place - 1]?.text ?? ''} ${fields.note.trim()}`.trim() };
    return kind === 'time' ? { text: fields.text, seconds } : { text: fields.text };
  };
  const send = () => {
    if (busy) return;
    setBusy(true);
    const body: FixDraft = {
      kind,
      ...(part === 'ingredient' ? { ingredient: place } : { step: place }),
      change: change(),
      reason: reason.trim(),
    };
    void app
      .act(
        async () => {
          await (mine ? keepEdit(recipe.id, body, 'typed') : sendSuggestion(recipe.id, body));
          onSent();
          onClose();
        },
        mine ? 'Kept in your version.' : 'Your suggestion is sent.',
      )
      .finally(() => setBusy(false));
  };
  const places =
    part === 'ingredient'
      ? recipe.ingredients.map((x, i) => ({ n: i + 1, title: x.name }))
      : part === 'new_step'
        ? [
            { n: 0, title: tr('At the start') },
            ...recipe.steps.map((_, i) => ({ n: i + 1, title: tr('Step {{v0}}', { v0: i + 1 }) })),
          ]
        : recipe.steps.map((_, i) => ({ n: i + 1, title: tr('Step {{v0}}', { v0: i + 1 }) }));
  const now =
    part === 'ingredient'
      ? ingredientLine(recipe.ingredients[place - 1] ?? {})
      : part === 'step'
        ? (recipe.steps[place - 1]?.text ?? '')
        : '';
  return (
    <Dialog
      visible={visible}
      onClose={onClose}
      title={mine ? tr('Change it for yourself') : tr('Suggest a change')}
      footer={
        <Button
          title={mine ? tr('Keep in my version') : tr('Send to {{v0}}', { v0: recipe.author.name })}
          busy={busy}
          onPress={send}
        />
      }
    >
      <Text style={s.muted}>
        {mine
          ? tr('Only you see this. The recipe opens your way next time.')
          : tr(
              'Suggest what another cook can check: a time, the heat, an amount, a missing step, a swap or a note. Taste is for comments.',
            )}
      </Text>
      <View style={{ gap: 10 }}>
        <Text style={s.label}>{tr('What should change?')}</Text>
        <View style={[s.wrap, { gap: 8 }]}>
          {kinds
            .filter((k) => !mine || k !== 'missing_step')
            .map((k) => (
              <Chip
                key={k}
                title={kindLabel(tr, k)}
                active={kind === k}
                onPress={() => choose(k)}
              />
            ))}
        </View>
      </View>
      <View style={{ gap: 10 }}>
        <Text style={s.label}>
          {part === 'ingredient'
            ? tr('Which ingredient?')
            : part === 'new_step'
              ? tr('After which step?')
              : tr('Which step?')}
        </Text>
        <View style={[s.wrap, { gap: 8 }]}>
          {places.map((p) => (
            <Chip key={p.n} title={p.title} active={place === p.n} onPress={() => pick(p.n)} />
          ))}
        </View>
        {!!now && (
          <Text style={s.small} numberOfLines={3}>
            <Text style={{ fontFamily: font.bold }}>{tr('Now')}</Text> {now}
          </Text>
        )}
      </View>
      {part === 'ingredient' ? (
        kind === 'amount' ? (
          <View style={[s.row, { gap: 10 }]}>
            <Field
              label={tr('Amount')}
              value={fields.amount}
              onChangeText={set('amount')}
              keyboardType="decimal-pad"
            />
            <Field
              label={tr('Unit')}
              value={fields.unit}
              onChangeText={set('unit')}
              maxLength={30}
            />
          </View>
        ) : (
          <Field
            label={tr('The ingredient as it should read')}
            value={fields.name}
            onChangeText={set('name')}
            maxLength={120}
          />
        )
      ) : kind === 'note' ? (
        <Field
          label={tr('Your note')}
          value={fields.note}
          onChangeText={set('note')}
          placeholder={tr('At high altitude, add 5 minutes.')}
          maxLength={300}
          multiline
        />
      ) : (
        <>
          {part === 'new_step' && (
            <Field
              label={tr('Step title')}
              value={fields.title}
              onChangeText={set('title')}
              maxLength={120}
            />
          )}
          {kind !== 'heat' && (
            <Field
              label={tr('Minutes')}
              value={fields.minutes}
              onChangeText={set('minutes')}
              keyboardType="number-pad"
            />
          )}
          <Field
            label={tr('The step as it should read')}
            value={fields.text}
            onChangeText={set('text')}
            maxLength={3000}
            multiline
          />
        </>
      )}
      <Field
        label={tr('What happened? (optional)')}
        value={reason}
        onChangeText={setReason}
        maxLength={500}
        multiline
      />
    </Dialog>
  );
}

/** The author's view of one suggestion: the change, why, and accept, edit or decline. */
export function FixReview({
  fix,
  title,
  onAnswered,
}: {
  fix: Suggestion;
  /** What it changes, where its card doesn't already say (the kind otherwise). */
  title?: string;
  onAnswered: (accepted: boolean) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [mode, setMode] = useState<'view' | 'edit' | 'decline'>('view');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(
    fix.part === 'ingredient' ? (fix.after.name ?? '') : (fix.after.text ?? ''),
  );
  const [minutes, setMinutes] = useState(String(minutesOf(fix.after.seconds)));
  const [response, setResponse] = useState('');
  const answer = (body: Record<string, unknown>, message: string) => {
    if (busy) return;
    setBusy(true);
    void app
      .act(async () => {
        await api(`/suggestions/${encodeURIComponent(fix.id)}`, { method: 'PATCH', body });
        onAnswered(body.action === 'accept');
      }, message)
      .finally(() => setBusy(false));
  };
  const edited = () =>
    fix.part === 'ingredient'
      ? { name: text }
      : { text, ...(fix.kind === 'heat' ? {} : { seconds: Math.round(Number(minutes) * 60) }) };
  return (
    <View style={styles.review}>
      <View style={[s.row, { gap: 8 }]}>
        <Text style={[styles.row, { flex: 1 }]}>{title ?? kindLabel(tr, fix.kind)}</Text>
        {fix.votes > 0 && <Text style={s.small}>{tr('agreeCount', { count: fix.votes })}</Text>}
      </View>
      <BeforeAfter fix={fix} />
      {!!fix.reason && <Text style={styles.quote}>“{fix.reason}”</Text>}
      <Text style={[s.small, { fontSize: 11 }]}>
        {tr('Suggested by {{v0}}', { v0: fix.author.name })}
        {!fix.fits ? ` · ${tr('This part of the recipe has changed since.')}` : ''}
      </Text>
      {mode === 'edit' && (
        <>
          {fix.part !== 'ingredient' && fix.kind !== 'heat' && (
            <Field
              label={tr('Minutes')}
              value={minutes}
              onChangeText={setMinutes}
              keyboardType="number-pad"
            />
          )}
          <Field
            label={
              fix.part === 'ingredient'
                ? tr('The ingredient as it should read')
                : tr('The step as it should read')
            }
            value={text}
            onChangeText={setText}
            multiline={fix.part !== 'ingredient'}
          />
        </>
      )}
      {mode === 'decline' && (
        <Field
          label={tr('Why not? (optional)')}
          value={response}
          onChangeText={setResponse}
          maxLength={500}
        />
      )}
      <View style={[s.row, { gap: 8 }]}>
        {mode === 'decline' ? (
          <Button
            title={tr('Decline')}
            variant="secondary"
            small
            busy={busy}
            onPress={() => answer({ action: 'decline', response: response.trim() }, 'Declined.')}
          />
        ) : (
          fix.fits && (
            <Button
              title={mode === 'edit' ? tr('Accept as edited') : tr('Accept')}
              icon={Check}
              variant="secondary"
              small
              busy={busy}
              onPress={() =>
                answer(
                  mode === 'edit' ? { action: 'accept', change: edited() } : { action: 'accept' },
                  'The recipe is updated.',
                )
              }
            />
          )
        )}
        <View style={{ flex: 1 }} />
        {fix.fits && mode === 'view' && (
          <IconButton
            icon={Pencil}
            label={tr('Edit before accepting')}
            size={36}
            plain
            onPress={() => setMode('edit')}
          />
        )}
        <IconButton
          icon={mode === 'view' ? X : Undo2}
          label={mode === 'view' ? tr('Decline') : tr('Cancel')}
          size={36}
          plain
          onPress={() => setMode(mode === 'view' ? 'decline' : 'view')}
        />
      </View>
    </View>
  );
}

/**
 * How cooks improved the recipe: its accepted fixes, newest first, each crediting its cook. Its
 * author can undo the latest while nothing else changed since.
 */
export function FixHistory({
  recipe,
  visible,
  onClose,
  onUndone,
}: {
  recipe: Recipe;
  visible: boolean;
  onClose: () => void;
  onUndone: () => void;
}) {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  const [versions, setVersions] = useState<FixVersion[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!visible) return;
    let live = true;
    api<{ versions: FixVersion[] }>(`/recipes/${encodeURIComponent(recipe.id)}/history`)
      .then((v) => live && setVersions(v.versions ?? []))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [visible, recipe.id]);
  const undo = (v: FixVersion) =>
    void app.act(async () => {
      await api(
        `/recipes/${encodeURIComponent(recipe.id)}/history/${encodeURIComponent(v.id)}/undo`,
        {
          method: 'POST',
        },
      );
      setVersions((list) => list && list.filter((x) => x.id !== v.id));
      onUndone();
    }, 'The change is undone.');
  return (
    <Dialog visible={visible} onClose={onClose} title={tr('How cooks improved it')}>
      {!!error && <Text style={[s.small, { color: color.error }]}>{tr(error)}</Text>}
      {versions?.length === 0 && <Text style={s.muted}>{tr('No changes from cooks yet.')}</Text>}
      {versions?.map((v, i) => (
        <View
          key={v.id}
          style={[
            { gap: 6, paddingVertical: 12 },
            i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line },
          ]}
        >
          <View style={[s.row, { gap: 8 }]}>
            <Text style={[styles.row, { flex: 1 }]}>
              {v.part
                ? fixTitle(tr, { ...v, kind: v.kind || 'note', part: v.part, place: 0 })
                : tr('A change')}
            </Text>
            {v.undoable && (
              <IconButton
                icon={Undo2}
                label={tr('Undo this change')}
                size={36}
                plain
                onPress={() => undo(v)}
              />
            )}
          </View>
          <Text style={s.small}>
            {v.by
              ? tr('From {{v0}} · {{v1}}', {
                  v0: v.by.name,
                  v1: new Date(v.createdAt).toLocaleDateString(locale, {
                    day: 'numeric',
                    month: 'short',
                  }),
                })
              : new Date(v.createdAt).toLocaleDateString(locale, {
                  day: 'numeric',
                  month: 'short',
                })}
          </Text>
        </View>
      ))}
    </Dialog>
  );
}

const styles = StyleSheet.create({
  row: { color: color.ink, fontFamily: font.semibold, fontSize: 15, lineHeight: 21 },
  quote: { fontFamily: font.regular, fontSize: 14, lineHeight: 21, color: '#3A3A3A' },
  review: { gap: 8, padding: 12, borderRadius: radius.md, backgroundColor: color.bg },
});
