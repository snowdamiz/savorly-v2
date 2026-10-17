import { useI18n } from '../lib/i18n';
import React, { useRef, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import type { UnitChoice } from '../lib/types';
import type { ShownAmount } from '../lib/units';
import { Segmented } from './ui';

type Translate = ReturnType<typeof useI18n>['t'];

// The units chosen on a recipe page stay chosen for the session: a guest's only copy, and a
// signed-in cook's until the profile they were chosen over changes, or someone else signs in.
let picked: { user: string | null; units: UnitChoice; over: UnitChoice } | null = null;

/**
 * The units a recipe page shows amounts in, starting from the cook's saved preference, and a
 * setter that saves a signed-in cook's choice to their profile.
 */
export function useUnits() {
  const app = useApp();
  const user = app.user?.id ?? null;
  const preference = app.user?.preferences?.units;
  const saved: UnitChoice = preference === 'metric' || preference === 'imperial' ? preference : '';
  // Until the cook picks here, the page follows the session's choice or the profile, which may
  // arrive after the page opens.
  const [chosen, setChosen] = useState<UnitChoice | null>(null);
  const session = picked && picked.user === user && picked.over === saved ? picked.units : null;
  const units = chosen ?? session ?? saved;
  // Saved one after another, so quick changes can't leave an older choice on the profile.
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const choose = (next: UnitChoice) => {
    if (next === units) return;
    setChosen(next);
    picked = { user, units: next, over: saved };
    if (!user) return;
    saving.current = saving.current.then(() =>
      app.act(() => api('/me/preferences', { method: 'PATCH', body: { units: next } })),
    );
  };
  return [units, choose] as const;
}

/** Original, metric or imperial amounts: a small switch beside the servings. */
export function UnitsSwitch({
  value,
  onChange,
}: {
  value: UnitChoice;
  onChange: (units: UnitChoice) => void;
}) {
  const { t: tr } = useI18n();
  return (
    <Segmented
      compact
      value={value || 'original'}
      onChange={(v) => onChange(v === 'original' ? '' : v)}
      options={[
        { value: 'original', label: tr('Original') },
        { value: 'metric', label: tr('Metric') },
        { value: 'imperial', label: tr('Imperial') },
      ]}
    />
  );
}

/**
 * An amount with its unit, as a line of an ingredient list shows it: the recipe's own unit word,
 * or a converted unit named in the reader's language ("2 tbsp", "大さじ2", "1½ стакана").
 */
export function amountText(tr: Translate, shown: ShownAmount) {
  const { amount, value, measure, unit } = shown;
  if (!measure) return [amount, unit].filter(Boolean).join(' ');
  // Below one, a fraction reads like one of something in some languages and not in others.
  const part = value < 1;
  switch (measure) {
    case 'g':
      return tr('{{amount}} g', { amount });
    case 'kg':
      return tr('{{amount}} kg', { amount });
    case 'ml':
      return tr('{{amount}} ml', { amount });
    case 'l':
      return tr('{{amount}} l', { amount });
    case 'oz':
      return part ? tr('ozPart', { amount }) : tr('ozAmount', { amount, count: value });
    case 'lb':
      return part ? tr('lbPart', { amount }) : tr('lbAmount', { amount, count: value });
    case 'tsp':
      return part ? tr('tspPart', { amount }) : tr('tspAmount', { amount, count: value });
    case 'tbsp':
      return part ? tr('tbspPart', { amount }) : tr('tbspAmount', { amount, count: value });
    case 'cup':
      return part ? tr('cupPart', { amount }) : tr('cupAmount', { amount, count: value });
  }
}
