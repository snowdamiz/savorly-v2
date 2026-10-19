// Building blocks for the admin console. The console is an operator tool and stays in
// English; dates and numbers still follow the selected locale.
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Info,
  LucideIcon,
} from '../../components/icons';
import { api, ApiError } from '../../lib/api';
import { AdminSection, AuditEntry, Paged } from '../../lib/admin';
import { useI18n } from '../../lib/i18n';
import { color, font, radius, s } from '../../lib/theme';
import { User } from '../../lib/types';
import {
  Button,
  Chip,
  Dialog,
  Field,
  Pill,
  Press,
  SearchBar,
  useChrome,
} from '../../components/ui';
import { DangerButton } from '../Kitchen';

/** What every section can do: open records over the console, switch sections, and refresh. */
export type AdminNav = {
  me: User;
  owner: boolean;
  member: (id: string) => void;
  recipe: (id: string) => void;
  job: (id: string) => void;
  turn: (id: string) => void;
  go: (section: AdminSection) => void;
  /** After a change, every open list and record reloads. */
  changed: () => void;
  version: number;
};
export const Nav = createContext<AdminNav | null>(null);
export function useNav() {
  const nav = useContext(Nav);
  if (!nav) throw new Error('Admin navigation missing');
  return nav;
}

export function useFormat() {
  const { locale } = useI18n();
  const number = (n: number) => new Intl.NumberFormat(locale).format(n);
  return {
    number,
    compact: (n: number) =>
      new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n),
    money: (n: number) =>
      new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: n > 0 && n < 0.1 ? 3 : 2,
      }).format(n),
    date: (iso: string) => new Date(iso).toLocaleDateString(locale, { dateStyle: 'medium' }),
    dateTime: (iso: string) =>
      new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    day: (iso: string) =>
      new Date(`${iso}T00:00:00Z`).toLocaleDateString(locale, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
    ago: (iso: string | null) => {
      if (!iso) return 'never';
      const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
      // Hermes has no Intl.RelativeTimeFormat; there it reads in English, like the console.
      const rtf =
        typeof Intl.RelativeTimeFormat === 'function'
          ? new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
          : null;
      for (const [unit, size] of [
        ['year', 31536000],
        ['month', 2592000],
        ['day', 86400],
        ['hour', 3600],
        ['minute', 60],
      ] as const)
        if (Math.abs(seconds) >= size) {
          const n = Math.round(seconds / size);
          if (rtf) return rtf.format(-n, unit);
          const amount = `${Math.abs(n)} ${unit}${Math.abs(n) === 1 ? '' : 's'}`;
          return n < 0 ? `in ${amount}` : `${amount} ago`;
        }
      return rtf ? rtf.format(-Math.round(seconds), 'second') : 'just now';
    },
    bytes: (n: number) =>
      n > 1e9
        ? `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n / 1e9)} GB`
        : `${number(Math.max(1, Math.round(n / 1e6)))} MB`,
  };
}

/** What an admin action left to finish by hand, such as a Stripe change Stripe didn't confirm. */
export const followUp = (e: AuditEntry) =>
  typeof e.detail.followUp === 'string' ? e.detail.followUp : '';

/** Loads one record, and again whenever the console records a change. */
export function useLoad<T>(path: string | null) {
  const { version } = useNav();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<T>(path)
      .then((d) => {
        if (!live) return;
        setData(d);
        setError('');
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [path, version, tick]);
  return { data, error, reload: useCallback(() => setTick((t) => t + 1), []) };
}

const pageSize = 50;
const maxPages = 10; // the API sends up to 500 rows at once
/** A paged admin list. A new query starts over; refreshes keep what's on screen until they land. */
export function usePaged<T>(path: string) {
  const { version } = useNav();
  // A new query starts again from the first page.
  const [paging, setPaging] = useState({ path, pages: 1 });
  if (paging.path !== path) setPaging({ path, pages: 1 });
  const pages = paging.path === path ? paging.pages : 1;
  const request = `${path}${path.includes('?') ? '&' : '?'}limit=${pageSize * pages}`;
  const [loaded, setLoaded] = useState<{
    request: string;
    version: number;
    page: Paged<T> | null;
    error: string;
  }>({
    request: '',
    version,
    page: null,
    error: '',
  });
  useEffect(() => {
    let live = true;
    api<Paged<T>>(request)
      .then((page) => live && setLoaded({ request, version, page, error: '' }))
      .catch(
        (e) => live && setLoaded((l) => ({ ...l, request, version, error: (e as Error).message })),
      );
    return () => {
      live = false;
    };
  }, [request, version]);
  const loading = loaded.request !== request || loaded.version !== version;
  const { items = [], total = 0 } = loaded.page || {};
  const more = () => setPaging((p) => ({ ...p, pages: Math.min(p.pages + 1, maxPages) }));
  return { items, total, loading, error: loaded.error, more };
}

/** Runs one action at a time inside a dialog and keeps its outcome on screen. */
export function useRun() {
  const nav = useNav();
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  /** With no success message, nothing changed and only a failure is shown. */
  const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setResult(null);
    try {
      await fn();
      if (success) {
        setResult({ ok: true, text: success });
        nav.changed();
      }
      return true;
    } catch (e) {
      setResult({
        ok: false,
        text: e instanceof ApiError || e instanceof Error ? e.message : String(e),
      });
      return false;
    } finally {
      setBusy('');
    }
  };
  return { busy, result, run, clear: () => setResult(null) };
}

// Inside a Panel, rows and stats share its card with a line between them, rather than a card each.
const InPanel = createContext(false);
const line = { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.border };

export function Panel({
  title,
  subtitle,
  right,
  children,
  style,
}: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  style?: ViewStyle;
}) {
  const { compact } = useChrome();
  const [more, setMore] = useState(false);
  // On a phone a long explanation keeps to two lines until it's asked for.
  const fold = compact && !!subtitle && subtitle.length > 120;
  return (
    <View style={[s.card, { gap: 14, flexGrow: 1 }, compact && { padding: 16 }, style]}>
      {(title || right) && (
        <View style={[s.between, { gap: 12, alignItems: 'flex-start' }]}>
          <View style={{ flex: 1, gap: 2 }}>
            {title && <Text style={s.h3}>{title}</Text>}
            {subtitle && (
              <Text style={s.small} numberOfLines={fold && !more ? 2 : undefined}>
                {subtitle}
              </Text>
            )}
            {fold && (
              <Text
                accessibilityRole="button"
                onPress={() => setMore(!more)}
                style={[s.small, { color: color.ink, textDecorationLine: 'underline' }]}
              >
                {more ? 'Less' : 'More'}
              </Text>
            )}
          </View>
          {right}
        </View>
      )}
      <InPanel.Provider value>{children}</InPanel.Provider>
    </View>
  );
}

/** Lays children out in columns of at least `min` pixels. */
export function Grid({ min = 220, children }: { min?: number; children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
      {React.Children.map(children, (child) =>
        child ? <View style={{ flexGrow: 1, flexBasis: min, minWidth: 0 }}>{child}</View> : null,
      )}
    </View>
  );
}

export function Stat({
  label,
  value,
  note,
  tone,
  onPress,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'warning' | 'error';
  onPress?: () => void;
}) {
  const flat = useContext(InPanel);
  const body = (
    <>
      <Text style={s.small}>{label}</Text>
      <Text style={[s.h1, { fontSize: flat ? 24 : 28, lineHeight: flat ? 30 : 34 }]}>{value}</Text>
      {!!note && (
        <Text
          style={[
            s.small,
            { fontFamily: font.medium },
            tone && { color: tone === 'error' ? color.error : color.warning },
          ]}
        >
          {note}
        </Text>
      )}
    </>
  );
  const style = flat
    ? [line, { gap: 4, paddingTop: 12, flexGrow: 1 }]
    : [s.card, { gap: 4, padding: 18, flexGrow: 1 }];
  return onPress ? (
    <Press accessibilityRole="button" onPress={onPress} scale={0.98} style={style}>
      {body}
    </Press>
  ) : (
    <View style={style}>{body}</View>
  );
}

/** A ratio against a limit. The fill turns to warning at 80% and error at 100%, with words to match. */
export function Meter({
  label,
  used,
  limit,
  display,
}: {
  label: string;
  used: number;
  limit: number;
  display: string;
}) {
  const share = limit > 0 ? used / limit : used > 0 ? 1 : 0;
  const state = share >= 1 ? 'error' : share >= 0.8 ? 'warning' : 'ok';
  return (
    <View style={{ gap: 6 }}>
      <View style={[s.between, { gap: 10 }]}>
        <Text style={[s.body, { flex: 1 }]}>{label}</Text>
        <Text style={[s.small, { color: color.ink }]}>{display}</Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={`${label}: ${display}`}
        style={{ height: 8, borderRadius: 4, backgroundColor: color.subtle, overflow: 'hidden' }}
      >
        <View
          style={{
            height: 8,
            borderRadius: 4,
            width: `${Math.min(100, share * 100)}%`,
            backgroundColor:
              state === 'error' ? color.error : state === 'warning' ? color.warning : color.ink,
          }}
        />
      </View>
      {state !== 'ok' && (
        <Text style={[s.small, { color: state === 'error' ? color.error : color.warning }]}>
          {state === 'error' ? 'At the limit' : 'Nearly at the limit'}
        </Text>
      )}
    </View>
  );
}

/**
 * One series over time as columns. Pressing or hovering a column reads its value out above the
 * chart; every column also carries its value for screen readers.
 */
export function Columns({
  points,
  format,
  unit,
  summary,
}: {
  points: { label: string; value: number }[];
  format: (n: number) => string;
  unit: string;
  /** The line above the chart while no day is chosen; by default, the total. */
  summary?: string;
}) {
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const height = 140;
  const max = Math.max(...points.map((p) => p.value), 0);
  // A clean top tick: 1, 2 or 5 times a power of ten.
  const top = (() => {
    if (max <= 0) return 1;
    const step = 10 ** Math.floor(Math.log10(max));
    return [1, 2, 5, 10].map((m) => m * step).find((v) => v >= max) || max;
  })();
  const slot = points.length ? width / points.length : 0;
  const bar = Math.max(2, Math.min(24, slot - 2));
  const total = points.reduce((sum, p) => sum + p.value, 0);
  const shown = active === null ? null : points[active];
  return (
    <View style={{ gap: 10 }}>
      <Text style={[s.small, { color: color.ink, fontFamily: font.semibold }]}>
        {shown
          ? `${shown.label}: ${format(shown.value)} ${unit}`
          : (summary ??
            `${format(total)} ${unit} in ${points.length} days · press a day for its value`)}
      </Text>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <View style={{ height, justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <Text style={[s.small, { fontSize: 11 }]}>{format(top)}</Text>
          <Text style={[s.small, { fontSize: 11 }]}>0</Text>
        </View>
        <View
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          style={{
            flex: 1,
            height,
            flexDirection: 'row',
            alignItems: 'flex-end',
            borderBottomWidth: 1,
            borderTopWidth: StyleSheet.hairlineWidth,
            borderColor: color.border,
          }}
        >
          {width > 0 &&
            points.map((p, i) => (
              <Pressable
                key={p.label}
                accessibilityRole="button"
                accessibilityLabel={`${p.label}: ${format(p.value)} ${unit}`}
                onPress={() => setActive(active === i ? null : i)}
                onHoverIn={() => setActive(i)}
                onHoverOut={() => setActive(null)}
                onFocus={() => setActive(i)}
                onBlur={() => setActive(null)}
                style={{ width: slot, height, justifyContent: 'flex-end', alignItems: 'center' }}
              >
                <View
                  style={{
                    width: bar,
                    height: p.value > 0 ? Math.max(2, (p.value / top) * (height - 1)) : 0,
                    borderTopLeftRadius: Math.min(4, bar / 2),
                    borderTopRightRadius: Math.min(4, bar / 2),
                    backgroundColor: active === null || active === i ? color.ink : color.soft,
                  }}
                />
              </Pressable>
            ))}
        </View>
      </View>
      {points.length > 1 && (
        <View style={[s.between, { marginLeft: 8 + format(top).length * 6 }]}>
          <Text style={[s.small, { fontSize: 11 }]}>{points[0].label}</Text>
          <Text style={[s.small, { fontSize: 11 }]}>{points[points.length - 1].label}</Text>
        </View>
      )}
    </View>
  );
}

/** Values compared side by side as horizontal bars, largest first, each labelled at its tip. */
export function Bars({
  rows,
  format,
}: {
  rows: { label: string; value: number }[];
  format: (n: number) => string;
}) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  return (
    <View style={{ gap: 10 }}>
      {[...rows]
        .sort((a, b) => b.value - a.value)
        .map((r) => (
          <View
            key={r.label}
            accessibilityLabel={`${r.label}: ${format(r.value)}`}
            style={{ gap: 4 }}
          >
            <Text style={s.small}>{r.label}</Text>
            <View style={[s.row, { gap: 8 }]}>
              <View style={{ flex: 1, flexDirection: 'row' }}>
                <View
                  style={{
                    height: 16,
                    width: max > 0 ? `${Math.max(r.value > 0 ? 1 : 0, (r.value / max) * 100)}%` : 0,
                    borderTopRightRadius: 4,
                    borderBottomRightRadius: 4,
                    backgroundColor: color.ink,
                  }}
                />
              </View>
              <Text style={[s.small, { color: color.ink, minWidth: 64, textAlign: 'right' }]}>
                {format(r.value)}
              </Text>
            </View>
          </View>
        ))}
    </View>
  );
}

const tones = {
  info: { bg: color.white, fg: color.ink, icon: Info, border: color.border },
  success: { bg: color.successBg, fg: color.success, icon: Check, border: color.successBg },
  warning: { bg: color.warningBg, fg: color.warning, icon: AlertTriangle, border: color.warningBg },
  error: { bg: color.errorBg, fg: color.error, icon: CircleAlert, border: color.errorBg },
};
/** A status line with an icon, so its meaning never rests on color alone. */
export function Notice({
  tone = 'info',
  text,
  action,
  onPress,
}: {
  tone?: keyof typeof tones;
  text: string;
  action?: string;
  onPress?: () => void;
}) {
  const t = tones[tone];
  const Icon = t.icon;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        s.row,
        {
          gap: 10,
          padding: 14,
          borderRadius: radius.md,
          backgroundColor: t.bg,
          borderWidth: 1,
          borderColor: t.border,
        },
      ]}
    >
      <Icon size={18} color={t.fg} strokeWidth={2} />
      <Text style={[s.body, { flex: 1, fontSize: 14, lineHeight: 20 }]}>{text}</Text>
      {action && onPress && <Button title={action} small variant="secondary" onPress={onPress} />}
    </View>
  );
}

export type Alert = {
  key: string;
  tone: 'info' | 'warning' | 'error';
  text: string;
  /** Where to look into it: the row opens it. */
  onPress: () => void;
};
const severity = { error: 0, warning: 1, info: 2 };
/** What needs an admin, most pressing first, as the rows of one card that each open the place to act. */
export function Attention({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return null;
  return (
    <View style={[s.card, { padding: 0, overflow: 'hidden' }]}>
      {[...alerts]
        .sort((a, b) => severity[a.tone] - severity[b.tone])
        .map((a, i) => {
          const t = tones[a.tone];
          const Icon = t.icon;
          return (
            <Press
              key={a.key}
              accessibilityRole="button"
              onPress={a.onPress}
              scale={1}
              style={[
                s.row,
                { gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
                i > 0 && line,
              ]}
            >
              <Icon size={18} color={a.tone === 'info' ? color.muted : t.fg} strokeWidth={2} />
              <Text style={[s.body, { flex: 1, fontSize: 14, lineHeight: 20 }]}>{a.text}</Text>
              <ChevronRight size={18} color={color.soft} />
            </Press>
          );
        })}
    </View>
  );
}

export type Tone = 'light' | 'dark' | 'success' | 'warning' | 'error';
export function Badge({
  title,
  tone = 'light',
  icon,
}: {
  title: string;
  tone?: Tone;
  icon?: LucideIcon;
}) {
  return <Pill title={title} tone={tone} icon={icon} />;
}

/**
 * One record in a list: leading art, a title with badges, and quiet details underneath. `right`
 * stays beside the text, such as an amount; `actions` (buttons) move under it on a phone, so the
 * title keeps its width.
 */
export function Row({
  leading,
  title,
  badges,
  lines,
  right,
  actions,
  onPress,
  label,
}: {
  leading?: React.ReactNode;
  title: string;
  badges?: React.ReactNode;
  lines?: (string | false | null | undefined)[];
  right?: React.ReactNode;
  actions?: React.ReactNode;
  onPress?: () => void;
  label?: string;
}) {
  const flat = useContext(InPanel);
  const { compact } = useChrome();
  const body = (
    <>
      {leading}
      <View style={{ flex: 1, gap: 4, minWidth: 0 }}>
        <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
          <Text numberOfLines={1} style={[s.h3, { fontSize: 15, flexShrink: 1 }]}>
            {title}
          </Text>
          {badges}
        </View>
        {lines
          ?.filter((l): l is string => !!l)
          .map((l, i) => (
            <Text key={i} numberOfLines={2} style={[s.small, { fontFamily: font.medium }]}>
              {l}
            </Text>
          ))}
        {compact && actions && (
          <View style={[s.row, { gap: 4, flexWrap: 'wrap', marginTop: 4 }]}>{actions}</View>
        )}
      </View>
      {right}
      {!compact && actions && <View style={[s.row, { gap: 4 }]}>{actions}</View>}
    </>
  );
  const style = flat
    ? [line, s.row, { gap: 12, paddingTop: 12, alignItems: 'center' as const }]
    : [
        s.card,
        s.row,
        { gap: compact ? 12 : 14, padding: compact ? 12 : 14, alignItems: 'center' as const },
      ];
  return onPress ? (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label || title}
      onPress={onPress}
      scale={0.99}
      style={style}
    >
      {body}
    </Press>
  ) : (
    <View style={style}>{body}</View>
  );
}

export function Filters<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label?: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const { compact } = useChrome();
  const chips = (
    <>
      {label && <Text style={[s.small, { alignSelf: 'center', marginRight: 2 }]}>{label}</Text>}
      {options.map((o) => (
        <Chip
          key={o.value}
          title={o.label}
          active={o.value === value}
          onPress={() => onChange(o.value)}
        />
      ))}
    </>
  );
  return compact ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8 }}
    >
      {chips}
    </ScrollView>
  ) : (
    <View style={[s.wrap, { gap: 8 }]}>{chips}</View>
  );
}

/** Search with a short pause, so typing doesn't send a request per keystroke. */
export function useSearch(initial = '') {
  const [text, setText] = useState(initial);
  const [query, setQuery] = useState(initial);
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  return { text, setText, query };
}
export function Search({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <View style={{ flexDirection: 'row', maxWidth: 560 }}>
      <SearchBar value={value} onChangeText={onChange} placeholder={placeholder} />
    </View>
  );
}

/**
 * One choice from a list, such as how to sort, as a quiet button that says the current choice
 * and opens a sheet of the options.
 */
export function Choose<T extends string>({
  title,
  options,
  value,
  onChange,
  icon: Icon,
}: {
  /** Names the choice, for the sheet and screen readers: "Sort members". */
  title: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  icon?: LucideIcon;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value) ?? options[0];
  return (
    <>
      <Press
        accessibilityRole="button"
        accessibilityLabel={`${title}: ${current.label}`}
        onPress={() => setOpen(true)}
        style={[
          s.row,
          {
            gap: 6,
            minHeight: 36,
            paddingLeft: 12,
            paddingRight: 10,
            borderRadius: radius.pill,
            borderWidth: 1,
            borderColor: color.border,
            backgroundColor: color.white,
          },
        ]}
      >
        {Icon && <Icon size={14} color={color.ink} strokeWidth={2} />}
        <Text style={{ fontFamily: font.semibold, fontSize: 13, color: color.ink }}>
          {current.label}
        </Text>
        <ChevronDown size={14} color={color.soft} strokeWidth={2} />
      </Press>
      <Dialog visible={open} onClose={() => setOpen(false)} title={title}>
        <View style={[s.card, { padding: 0, overflow: 'hidden' }]}>
          {options.map((o, i) => {
            const on = o.value === value;
            return (
              <Press
                key={o.value}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                onPress={() => {
                  setOpen(false);
                  onChange(o.value);
                }}
                scale={1}
                style={[s.row, { gap: 12, minHeight: 52, paddingHorizontal: 16 }, i > 0 && line]}
              >
                <Text style={[s.body, { flex: 1 }, on && { fontFamily: font.bold }]}>
                  {o.label}
                </Text>
                {on && <Check size={18} color={color.ink} strokeWidth={2.4} />}
              </Press>
            );
          })}
        </View>
      </Dialog>
    </>
  );
}

/** The line over a list: how many match, and the list's own choices, such as its order. */
export function ListBar({
  total,
  loading,
  noun,
  children,
}: {
  total: number;
  loading: boolean;
  /** The singular and plural: ['member', 'members']. */
  noun: [string, string];
  children?: React.ReactNode;
}) {
  const f = useFormat();
  return (
    <View style={[s.between, { gap: 10, minHeight: 36 }]}>
      <Text style={[s.small, { flexShrink: 1 }]}>
        {loading && !total ? '' : `${f.number(total)} ${total === 1 ? noun[0] : noun[1]}`}
      </Text>
      {children && <View style={[s.row, { gap: 8 }]}>{children}</View>}
    </View>
  );
}

/** The state under a list: loading, an error, nothing found, or more to load. */
export function ListState({
  shown,
  total,
  loading,
  error,
  empty,
  onMore,
}: {
  shown: number;
  total: number;
  loading: boolean;
  error: string;
  empty: string;
  onMore: () => void;
}) {
  if (error) return <Notice tone="error" text={error} />;
  if (loading && !shown)
    return (
      <View style={{ paddingVertical: 40, alignItems: 'center' }}>
        <ActivityIndicator color={color.ink} />
      </View>
    );
  if (!shown)
    return <Text style={[s.muted, { paddingVertical: 24, textAlign: 'center' }]}>{empty}</Text>;
  return (
    <View style={[s.between, { paddingVertical: 4 }]}>
      <Text style={s.small}>
        Showing {shown} of {total}
      </Text>
      {shown < total &&
        (shown < pageSize * maxPages ? (
          <Button title="Load more" small variant="secondary" busy={loading} onPress={onMore} />
        ) : (
          <Text style={s.small}>Narrow the search to see the rest</Text>
        ))}
    </View>
  );
}

export function Loading({ error }: { error?: string }) {
  return error ? (
    <Notice tone="error" text={error} />
  ) : (
    <View style={{ paddingVertical: 60, alignItems: 'center' }}>
      <ActivityIndicator color={color.ink} />
    </View>
  );
}

/** Label/value pairs, such as a member's account details. Values can be selected and copied. */
export function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  const { compact } = useChrome();
  return (
    <View style={{ gap: 0 }}>
      {rows.map(([label, value], i) => (
        <View
          key={label}
          style={[
            s.row,
            {
              gap: 12,
              paddingVertical: 10,
              alignItems: 'flex-start',
              borderTopWidth: i ? StyleSheet.hairlineWidth : 0,
              borderColor: color.line,
            },
          ]}
        >
          <Text style={[s.small, { width: compact ? 104 : 128, paddingTop: 2 }]}>{label}</Text>
          {typeof value === 'string' || typeof value === 'number' ? (
            <Text selectable style={[s.body, { flex: 1, fontSize: 14, lineHeight: 20 }]}>
              {value}
            </Text>
          ) : (
            <View style={{ flex: 1 }}>{value}</View>
          )}
        </View>
      ))}
    </View>
  );
}

export function SectionLabel({ children }: { children: string }) {
  return <Text style={[s.label, { marginTop: 6 }]}>{children}</Text>;
}

export function Toggle({
  label,
  text,
  value,
  onChange,
}: {
  label: string;
  text?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={[s.row, { gap: 14 }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.h3}>{label}</Text>
        {text && <Text style={s.muted}>{text}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: color.line, true: color.ink }}
        thumbColor={color.white}
        {...(Platform.OS === 'web' ? { activeThumbColor: color.white } : {})}
        accessibilityLabel={label}
      />
    </View>
  );
}

/**
 * Asks before an action. With `input`, the admin writes a note (or, with `match`, types a
 * value back to confirm something permanent).
 */
export function Confirm({
  visible,
  title,
  text,
  action,
  danger,
  input,
  busy,
  result,
  onConfirm,
  onClose,
}: {
  visible: boolean;
  title: string;
  text: string;
  action: string;
  danger?: boolean;
  input?: { label: string; placeholder?: string; required?: boolean; match?: string };
  busy?: boolean;
  result?: { ok: boolean; text: string } | null;
  onConfirm: (value: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState('');
  // Each opening starts with an empty field.
  const [shown, setShown] = useState(visible);
  if (shown !== visible) {
    setShown(visible);
    if (visible) setValue('');
  }
  const ready = !input
    ? true
    : input.match
      ? value.trim().toLowerCase() === input.match.toLowerCase()
      : !input.required || value.trim().length >= 3;
  return (
    <Dialog visible={visible} onClose={onClose} title={title}>
      <Text style={s.muted}>{text}</Text>
      {input && (
        <Field
          label={input.label}
          placeholder={input.placeholder}
          value={value}
          onChangeText={setValue}
          autoCapitalize="none"
          multiline={!input.match}
          maxLength={input.match ? 254 : 500}
        />
      )}
      {result && !result.ok && <Notice tone="error" text={result.text} />}
      {danger ? (
        <DangerButton
          title={action}
          busy={busy}
          disabled={!ready}
          onPress={() => onConfirm(value.trim())}
        />
      ) : (
        <Button
          title={action}
          busy={busy}
          disabled={!ready}
          onPress={() => onConfirm(value.trim())}
        />
      )}
    </Dialog>
  );
}
