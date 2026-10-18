import { useI18n } from '../lib/i18n';
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { ChevronDown, CookingPot } from './icons';
import { useHeat } from './CookTogether';
import { useApp } from '../lib/store';
import type { StepTiming } from '../lib/types';
import { color, font, s } from '../lib/theme';
import { NumberField } from './ui';

const box = {
  backgroundColor: color.bg,
  borderColor: color.bg,
  minHeight: 46,
  paddingVertical: 11,
  paddingHorizontal: 12,
  borderRadius: 14,
};

/**
 * A step's timing for cooking it with other dishes (docs/MEAL-TIMELINE.md): one quiet line that
 * opens to hands-on and waiting minutes, the oven's heat and the burners. Changing any of it
 * makes it the cook's own rather than an estimate; clearing it leaves the step to the server's.
 */
/** Timing as a recipe may hold it: times up to a day, an oven between 50 and 300 °C or none, and up
 * to 6 burners, whatever was typed. */
export function fitTiming(timing: StepTiming | null): StepTiming | null {
  if (!timing) return null;
  const within = (n: number | undefined, high: number) =>
    Math.min(Math.max(Math.round(n ?? 0), 0), high);
  const oven = within(timing.oven, 300);
  return {
    active: within(timing.active, 86400),
    wait: within(timing.wait, 86400),
    oven: oven >= 50 ? oven : 0,
    burners: within(timing.burners, 6),
    ...(timing.estimated ? { estimated: true } : {}),
  };
}

export function StepTimingEditor({
  step,
  timing,
  onChange,
}: {
  /** The step's 1-based place, for the fields' names. */
  step: number;
  timing?: StepTiming | null;
  onChange: (timing: StepTiming | null) => void;
}) {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  const heat = useHeat();
  const [open, setOpen] = useState(false);
  const units = app.user?.preferences?.units;
  const fahrenheit = units === 'imperial' || (!units && /-US$/.test(locale));
  const minutes = (seconds?: number) => Math.round((seconds ?? 0) / 6) / 10;
  const set = (patch: StepTiming) => {
    const next = { ...timing, ...patch, estimated: false };
    onChange(next);
  };
  const parts = timing
    ? [
        timing.active ? tr('{{v0}} min hands-on', { v0: minutes(timing.active) }) : '',
        timing.wait ? tr('{{v0}} min waiting', { v0: minutes(timing.wait) }) : '',
        timing.oven ? tr('Oven {{v0}}', { v0: heat(timing.oven) }) : '',
        timing.burners ? tr('burnerCount', { count: timing.burners }) : '',
      ].filter(Boolean)
    : [];
  const summary = parts.length
    ? timing?.estimated
      ? tr('Estimated: {{v0}}', { v0: parts.join(' · ') })
      : parts.join(' · ')
    : tr('Timing for cooking with other dishes');
  // Fahrenheit is kept as typed while it's typed: converting it back and forth would change it
  // under the cook's fingers. Saved heats show to the nearest 5 °F.
  const [typed, setTyped] = useState<{ oven: number; shown: number } | null>(null);
  const ovenShown =
    typed && typed.oven === (timing?.oven ?? 0)
      ? typed.shown
      : timing?.oven
        ? fahrenheit
          ? Math.round(((timing.oven * 9) / 5 + 32) / 5) * 5
          : timing.oven
        : 0;
  return (
    <View style={{ gap: 10 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        aria-expanded={open}
        accessibilityLabel={tr('Timing for step {{v0}}: {{v1}}', { v0: step, v1: summary })}
        onPress={() => setOpen(!open)}
        style={[s.row, { gap: 10, minHeight: 32 }]}
      >
        <CookingPot size={16} color={color.muted} strokeWidth={2} />
        <Text style={[s.small, { flex: 1, fontSize: 13 }]}>{summary}</Text>
        <ChevronDown
          size={16}
          color={color.muted}
          style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}
        />
      </Pressable>
      {open && (
        <View style={{ gap: 10 }}>
          <View style={[s.row, { gap: 10, flexWrap: 'wrap' }]}>
            {(
              [
                [
                  tr('Hands-on, min'),
                  tr('Hands-on minutes for step {{v0}}', { v0: step }),
                  minutes(timing?.active),
                  (v: number) => set({ active: Math.round(v * 60) }),
                ],
                [
                  tr('Waiting, min'),
                  tr('Waiting minutes for step {{v0}}', { v0: step }),
                  minutes(timing?.wait),
                  (v: number) => set({ wait: Math.round(v * 60) }),
                ],
                [
                  fahrenheit ? tr('Oven, °F') : tr('Oven, °C'),
                  tr('Oven heat for step {{v0}}', { v0: step }),
                  ovenShown,
                  (v: number) => {
                    const oven = v ? Math.round(fahrenheit ? ((v - 32) * 5) / 9 : v) : 0;
                    setTyped({ oven, shown: v });
                    set({ oven });
                  },
                ],
                [
                  tr('Burners'),
                  tr('Burners for step {{v0}}', { v0: step }),
                  timing?.burners ?? 0,
                  (v: number) => set({ burners: Math.round(v) }),
                ],
              ] as const
            ).map(([label, name, value, change]) => (
              <View key={label} style={{ width: 118, gap: 4 }}>
                <Text
                  aria-hidden
                  style={{ fontFamily: font.semibold, fontSize: 12, color: color.muted }}
                >
                  {label}
                </Text>
                <NumberField
                  accessibilityLabel={name}
                  value={value}
                  placeholder="0"
                  style={box}
                  onChange={change}
                />
              </View>
            ))}
          </View>
          <Text style={s.small}>
            {tr(
              'An oven heat with no time preheats it. Leave this empty and Savorly estimates it.',
            )}
          </Text>
          {!!timing && (
            <Pressable
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => onChange(null)}
              style={{ alignSelf: 'flex-start' }}
            >
              <Text style={[s.small, { color: color.ink, textDecorationLine: 'underline' }]}>
                {tr('Clear the timing')}
              </Text>
            </Pressable>
          )}
        </View>
      )}
    </View>
  );
}
