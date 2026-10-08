import { useI18n } from '../lib/i18n';
import React, {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  BackHandler,
  Easing,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  PressableProps,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextInputProps,
  View,
  ViewProps,
  ViewStyle,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { ArrowRight, Check, ChefHat, LucideIcon, Search, X } from 'lucide-react-native';
import { color, font, radius, s, shadow } from '../lib/theme';
export const native = Platform.OS !== 'web';
// Liquid Glass on iPhones running iOS 26+; Android, web and older iOS keep the flat styles.
export const liquidGlass =
  Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
// Glass that mounts under an ancestor at opacity 0 never renders, so it waits for any FadeIn above
// it to land and shows the flat style until then.
const Settled = React.createContext(true);
const useGlass = () => useContext(Settled) && liquidGlass;
// Glass inside a horizontal ScrollView renders blank on iOS 26, so carousels keep the flat look.
export const FlatGlass = ({ children }: { children: React.ReactNode }) => (
  <Settled.Provider value={false}>{children}</Settled.Provider>
);
// Glass where available; elsewhere a plain View that also takes the flat look in `flat`.
export function GlassSurface({
  dark,
  tint,
  flat,
  style,
  ...props
}: ViewProps & { dark?: boolean; tint?: string; flat?: StyleProp<ViewStyle> }) {
  return useGlass() ? (
    <GlassView colorScheme={dark ? 'dark' : 'light'} tintColor={tint} style={style} {...props} />
  ) : (
    <View style={[style, flat]} {...props} />
  );
}
// Kept in sync with the OS setting; entrances and parallax become instant when it is on.
let reduceMotion = false;
const readMotion = () =>
  void AccessibilityInfo.isReduceMotionEnabled().then((v) => (reduceMotion = v));
readMotion();
AccessibilityInfo.addEventListener('reduceMotionChanged', readMotion);
export const motionReduced = () => reduceMotion;
const ease = Easing.bezier(0.22, 1, 0.36, 1);
export const animate = (v: Animated.Value, toValue: number, duration = 420, delay = 0) =>
  Animated.timing(v, {
    toValue,
    duration: reduceMotion ? 0 : duration,
    delay: reduceMotion ? 0 : delay,
    easing: ease,
    useNativeDriver: native,
  });
// A quick dip on press and a soft overshoot on release.
export function usePress(to = 0.96) {
  const v = useState(() => new Animated.Value(1))[0];
  const go = (toValue: number) =>
    Animated.spring(v, {
      toValue,
      useNativeDriver: native,
      speed: toValue < 1 ? 50 : 18,
      bounciness: toValue < 1 ? 0 : 9,
    }).start();
  return {
    onPressIn: () => go(to),
    onPressOut: () => go(1),
    style: { transform: [{ scale: v }] },
  };
}
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
export function Press({
  style,
  scale = 0.96,
  disabled,
  ...props
}: Omit<PressableProps, 'style'> & { style?: StyleProp<ViewStyle>; scale?: number }) {
  const press = usePress(scale);
  const [hovered, setHovered] = useState(false);
  return (
    <AnimatedPressable
      {...props}
      disabled={disabled}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[style, { opacity: disabled ? 0.4 : hovered ? 0.88 : 1 }, press.style]}
    />
  );
}
// Rises and fades in once on mount; stagger siblings with `delay`.
export function FadeIn({
  children,
  delay = 0,
  offset = 16,
  style,
}: {
  children: React.ReactNode;
  delay?: number;
  offset?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const a = useState(() => new Animated.Value(0))[0];
  const parent = useContext(Settled);
  const [done, setDone] = useState(false);
  useEffect(() => {
    animate(a, 1, 560, delay).start(() => setDone(true));
  }, [a, delay]);
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: a,
          transform: [
            { translateY: a.interpolate({ inputRange: [0, 1], outputRange: [offset, 0] }) },
          ],
        },
      ]}
    >
      <Settled.Provider value={parent && done}>{children}</Settled.Provider>
    </Animated.View>
  );
}
// Layout facts every screen agrees on: phone/tablet get app chrome, desktop gets the sidebar.
export function useChrome() {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const desktop = width >= 1000;
  return {
    width,
    height,
    insets,
    desktop,
    compact: !desktop,
    gutter: desktop ? 40 : width > 650 ? 28 : 20,
    top: desktop ? 32 : insets.top + 12,
  };
}
export function Button({
  title,
  onPress,
  icon: Icon,
  variant = 'primary',
  small,
  large,
  disabled,
  busy,
  label,
  style,
}: {
  title: string;
  onPress: () => void;
  icon?: LucideIcon;
  variant?: 'primary' | 'secondary' | 'ghost' | 'inverse' | 'glass';
  small?: boolean;
  large?: boolean;
  disabled?: boolean;
  busy?: boolean;
  label?: string;
  style?: ViewStyle;
}) {
  const light = variant === 'primary' || variant === 'glass';
  const fg = light ? color.white : color.ink;
  const bg = {
    primary: color.ink,
    secondary: color.white,
    ghost: 'transparent',
    inverse: color.white,
    glass: color.glass,
  }[variant];
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label || title}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      scale={0.97}
      style={[
        {
          flexDirection: 'row',
          gap: 8,
          alignItems: 'center',
          justifyContent: 'center',
          paddingHorizontal: variant === 'ghost' ? 12 : small ? 16 : 24,
          minHeight: small ? 40 : large ? 58 : 52,
          borderRadius: radius.pill,
          backgroundColor: bg,
          borderWidth: variant === 'secondary' || variant === 'glass' ? 1 : 0,
          borderColor: variant === 'glass' ? color.glassBorder : color.border,
        },
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : Icon ? (
        <Icon size={small ? 16 : 18} color={fg} strokeWidth={2} />
      ) : null}
      <Text
        style={{
          fontFamily: font.bold,
          fontSize: small ? 13 : large ? 16 : 15,
          color: fg,
          letterSpacing: -0.1,
        }}
      >
        {title}
      </Text>
    </Press>
  );
}
export function IconButton({
  icon: Icon,
  onPress,
  label,
  selected,
  dark,
  plain,
  glass,
  disabled,
  size = 44,
}: {
  icon: LucideIcon;
  onPress: () => void;
  label: string;
  selected?: boolean;
  dark?: boolean;
  plain?: boolean;
  /** Floats over photos or other busy surfaces: Liquid Glass where available. */
  glass?: boolean;
  disabled?: boolean;
  size?: number;
}) {
  const light = selected || dark;
  // Dark buttons always sit on photos or the black header, so they turn to glass too.
  const glassy = useGlass() && (glass || dark);
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected: !!selected }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={size < 40 ? 6 : 0}
      // Interactive glass has its own touch response; a scale on top would fight it.
      scale={glassy ? 1 : 0.9}
      style={[
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: glassy
            ? 'transparent'
            : dark
              ? color.glass
              : selected
                ? color.ink
                : plain
                  ? 'transparent'
                  : color.white,
          borderColor: dark
            ? color.glassBorder
            : selected
              ? color.ink
              : plain
                ? 'transparent'
                : color.border,
          borderWidth: glassy ? 0 : 1,
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      {glassy && (
        <GlassView
          isInteractive
          colorScheme={dark ? 'dark' : 'light'}
          tintColor={selected ? color.ink : undefined}
          style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }]}
        />
      )}
      <Icon
        size={Math.round(size * 0.43)}
        color={light ? color.white : color.ink}
        strokeWidth={1.9}
        fill={selected ? color.white : 'none'}
      />
    </Press>
  );
}
export function Chip({
  title,
  active,
  onPress,
  icon: Icon,
  dark,
  label,
  leading,
}: {
  title: string;
  active?: boolean;
  onPress: () => void;
  icon?: LucideIcon;
  dark?: boolean;
  label?: string;
  leading?: React.ReactNode;
}) {
  const fg = active || dark ? color.white : color.ink;
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      aria-pressed={active}
      onPress={onPress}
      style={[
        {
          paddingHorizontal: 16,
          minHeight: leading ? 44 : 40,
          borderRadius: radius.pill,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          borderWidth: 1,
          borderColor: active ? color.ink : dark ? color.glassBorder : color.border,
          backgroundColor: active ? color.ink : dark ? color.glass : color.white,
        },
      ]}
    >
      {leading || (Icon && <Icon size={15} color={fg} strokeWidth={2} />)}
      <Text style={{ fontFamily: font.semibold, fontSize: 13, color: fg }}>{title}</Text>
    </Press>
  );
}
export function Pill({
  title,
  icon: Icon,
  tone = 'light',
  fill,
  leading,
}: {
  title: string;
  icon?: LucideIcon;
  fill?: boolean;
  leading?: React.ReactNode;
  tone?: 'light' | 'dark' | 'glass' | 'success' | 'warning' | 'error';
}) {
  const [bg, fg] = {
    light: [color.white, color.ink],
    dark: [color.ink, color.white],
    glass: ['rgba(0,0,0,0.38)', color.white],
    success: [color.successBg, color.success],
    warning: [color.warningBg, color.warning],
    error: [color.errorBg, color.error],
  }[tone];
  const pill = [
    s.row,
    {
      gap: 5,
      paddingHorizontal: 10,
      height: 28,
      borderRadius: radius.pill,
      alignSelf: 'flex-start' as const,
    },
  ];
  const body = (
    <>
      {leading || (Icon && <Icon size={13} color={fg} fill={fill ? fg : 'none'} strokeWidth={2} />)}
      <Text style={{ fontFamily: font.bold, fontSize: 12, color: fg }}>{title}</Text>
    </>
  );
  // Glass badges sit on photos.
  return tone === 'glass' ? (
    <GlassSurface dark flat={{ backgroundColor: bg }} style={pill}>
      {body}
    </GlassSurface>
  ) : (
    <View style={[pill, { backgroundColor: bg }]}>{body}</View>
  );
}
export function Field({ label, style, ...props }: TextInputProps & { label?: string }) {
  return (
    <View style={{ gap: 8, flexGrow: 1, flexShrink: 1, flexBasis: 'auto' }}>
      {label && (
        <Text style={{ fontFamily: font.semibold, fontSize: 13, color: color.muted }}>{label}</Text>
      )}
      <TextInput
        accessibilityLabel={label || props.placeholder}
        placeholderTextColor={color.soft}
        {...props}
        style={[s.input, props.multiline && { minHeight: 110, textAlignVertical: 'top' }, style]}
      />
    </View>
  );
}
export function SearchBar({
  value,
  onChangeText,
  placeholder = 'Search recipes, ingredients…',
  bare,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  bare?: boolean;
}) {
  const { t: tr } = useI18n();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        height: 52,
        paddingLeft: 18,
        paddingRight: 8,
        borderRadius: radius.pill,
        backgroundColor: color.white,
        borderWidth: bare ? 0 : 1,
        borderColor: color.border,
        flex: 1,
      }}
    >
      <Search size={19} color={color.muted} strokeWidth={2} />
      <TextInput
        accessibilityLabel={tr('Search recipes')}
        placeholder={placeholder ? tr(placeholder) : undefined}
        placeholderTextColor={color.soft}
        value={value}
        onChangeText={onChangeText}
        returnKeyType="search"
        style={{ flex: 1, color: color.ink, fontFamily: font.medium, fontSize: 15, height: 48 }}
      />
      {value.length > 0 && (
        <IconButton
          icon={X}
          plain
          size={36}
          label={tr('Clear search')}
          onPress={() => onChangeText('')}
        />
      )}
    </View>
  );
}
export function Avatar({ name, uri, size = 36 }: { name: string; uri?: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  return uri && !failed ? (
    <Image
      source={{ uri }}
      onError={() => setFailed(true)}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color.subtle }}
    />
  ) : (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: color.ink,
      }}
    >
      <Text style={{ fontFamily: font.bold, color: color.white, fontSize: size / 2.8 }}>
        {name
          .split(' ')
          .slice(0, 2)
          .map((n) => n[0])
          .join('')
          .toUpperCase()}
      </Text>
    </View>
  );
}
export function FoodImage({ uri, style }: { uri: string; style?: ViewStyle }) {
  const [failed, setFailed] = useState(false);
  return (
    <View style={[{ backgroundColor: color.subtle, overflow: 'hidden' }, style]}>
      {uri && !failed ? (
        <Image
          source={{ uri }}
          resizeMode="cover"
          onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%' }}
        />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ChefHat size={30} color={color.soft} strokeWidth={1.5} />
        </View>
      )}
    </View>
  );
}
export function Empty({
  title,
  text,
  icon: Icon = ChefHat,
  action,
  actionTitle,
}: {
  title: string;
  text: string;
  icon?: LucideIcon;
  action?: () => void;
  actionTitle?: string;
}) {
  const { t: tr } = useI18n();
  return (
    <View style={{ alignItems: 'center', paddingVertical: 44, paddingHorizontal: 20, gap: 10 }}>
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: 36,
          backgroundColor: color.white,
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: shadow.card,
          marginBottom: 8,
        }}
      >
        <Icon size={28} color={color.ink} strokeWidth={1.6} />
      </View>
      <Text style={[s.h2, { textAlign: 'center' }]}>{title}</Text>
      <Text style={[s.muted, { textAlign: 'center', maxWidth: 340 }]}>{text}</Text>
      {action && (
        <Button
          title={actionTitle || tr('Get started')}
          onPress={action}
          icon={ArrowRight}
          small
          style={{ marginTop: 10 }}
        />
      )}
    </View>
  );
}
export function SectionTitle({
  title,
  subtitle,
  action,
  actionTitle = 'See all',
}: {
  title: string;
  subtitle?: string;
  action?: () => void;
  actionTitle?: string;
}) {
  const { t: tr } = useI18n();
  return (
    <View style={[s.between, { marginBottom: 14, gap: 12 }]}>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={s.h2}>{title}</Text>
        {subtitle && <Text style={s.muted}>{subtitle}</Text>}
      </View>
      {action && (
        <Press
          accessibilityRole="button"
          accessibilityLabel={tr(actionTitle)}
          onPress={action}
          hitSlop={10}
        >
          <Text style={{ fontFamily: font.semibold, fontSize: 14, color: color.muted }}>
            {tr(actionTitle)}
          </Text>
        </Press>
      )}
    </View>
  );
}
export function PageHeading({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  children?: React.ReactNode;
}) {
  const { desktop } = useChrome();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: desktop ? 'flex-end' : 'flex-start',
        justifyContent: 'space-between',
        gap: 16,
      }}
    >
      <View style={{ gap: 6, flex: 1 }}>
        {eyebrow && <Text style={s.label}>{eyebrow}</Text>}
        <Text style={desktop ? s.display : [s.h1, { fontSize: 30, lineHeight: 36 }]}>{title}</Text>
        {subtitle && <Text style={[s.muted, { maxWidth: 560 }]}>{subtitle}</Text>}
      </View>
      {children && <View style={[s.row, { gap: 10 }]}>{children}</View>}
    </View>
  );
}
export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const x = useState(() => new Animated.Value(index))[0];
  useEffect(() => {
    Animated.spring(x, {
      toValue: index,
      damping: 24,
      stiffness: 280,
      mass: 0.8,
      useNativeDriver: native,
    }).start();
  }, [index, x]);
  const segment = (width - 8) / options.length;
  return (
    <View
      accessibilityRole="tablist"
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={{
        flexDirection: 'row',
        backgroundColor: color.subtle,
        borderRadius: radius.pill,
        padding: 4,
      }}
    >
      {width > 0 && (
        <Animated.View
          style={{
            position: 'absolute',
            top: 4,
            bottom: 4,
            left: 4,
            width: segment,
            borderRadius: radius.pill,
            backgroundColor: color.white,
            boxShadow: '0px 1px 3px rgba(0,0,0,0.12)',
            transform: [{ translateX: Animated.multiply(x, segment) }],
          }}
        />
      )}
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => onChange(o.value)}
            style={{
              flex: 1,
              minHeight: 40,
              paddingHorizontal: 12,
              borderRadius: radius.pill,
              alignItems: 'center',
              justifyContent: 'center',
              // Until the track is measured the pill can't slide, so the active segment paints itself.
              backgroundColor: on && !width ? color.white : 'transparent',
            }}
          >
            <Text
              numberOfLines={1}
              style={{ fontFamily: font.bold, fontSize: 14, color: on ? color.ink : color.muted }}
            >
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
// Every Dialog renders into one shared sheet (SheetHost). When one sheet hands off to another, the
// container stays put: the old page fades out, the sheet eases to the new height, the new page
// fades in. A sheet opened over another returns to it when closed.
type Sheet = {
  id: number;
  order: number;
  title?: string;
  children?: React.ReactNode;
  onClose: () => void;
};
let sheetSeq = 0;
let sheets: Sheet[] = [];
const sheetListeners = new Set<() => void>();
const setSheets = (next: Sheet[]) => {
  sheets = next;
  sheetListeners.forEach((l) => l());
};
const subscribeSheets = (l: () => void) => {
  sheetListeners.add(l);
  return () => {
    sheetListeners.delete(l);
  };
};
const getSheets = () => sheets;
const pageOf = (e: Sheet) => `${e.id}:${e.title ?? ''}`;
export function Dialog({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const [id] = useState(() => ++sheetSeq);
  useLayoutEffect(() => {
    if (!visible) return;
    setSheets([...sheets, { id, order: ++sheetSeq, onClose: () => {} }]);
    return () => setSheets(sheets.filter((e) => e.id !== id));
  }, [visible, id]);
  // Runs after every render so the sheet always shows the owner's latest content.
  useLayoutEffect(() => {
    if (visible)
      setSheets(sheets.map((e) => (e.id === id ? { ...e, title, children, onClose } : e)));
  });
  return null;
}
// Centered card on desktop; a bottom sheet with a grabber on phones and tablets.
export function SheetHost() {
  const { t: tr } = useI18n();
  const { compact, height, insets, width } = useChrome();
  const entries = useSyncExternalStore(subscribeSheets, getSheets, getSheets);
  const top = entries.length ? entries.reduce((a, b) => (b.order > a.order ? b : a)) : undefined;
  const topPage = top && pageOf(top);
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<string>();
  // While the old page fades out it is frozen; once closed, its last version rides the sheet down.
  const [frozen, setFrozen] = useState<Sheet>();
  const [last, setLast] = useState<Sheet>();
  const live = entries.find((e) => pageOf(e) === page);
  if (live && live !== last) setLast(live);
  const entry = frozen ?? live ?? last;
  const [sized, setSized] = useState(false);
  const [y] = useState(() => new Animated.Value(height));
  const [backdrop] = useState(() => new Animated.Value(0));
  const [fade] = useState(() => new Animated.Value(1));
  const [h] = useState(() => new Animated.Value(0));
  const m = useRef({
    phase: 'closed' as 'closed' | 'open' | 'fading' | 'measuring' | 'closing',
    page: undefined as string | undefined,
    pending: undefined as string | undefined,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  const chrome = compact ? 21 + insets.bottom + 6 : 0;
  const maxHeight = compact ? height - insets.top - 20 : height - 60;
  const show = (next: string) => {
    m.current.page = next;
    setPage(next);
  };
  const reveal = () => {
    const st = m.current;
    st.phase = 'open';
    animate(fade, 1, 240, 40).start(() => {
      if (st.phase === 'open' && st.pending && st.pending !== st.page) swap(st.pending);
    });
  };
  const swap = (next: string) => {
    const st = m.current;
    st.pending = next;
    if (st.phase === 'fading' || st.phase === 'measuring') return;
    st.phase = 'fading';
    setFrozen(entry);
    animate(fade, 0, 110).start(() => {
      if (st.phase !== 'fading') return;
      setFrozen(undefined);
      show(st.pending!);
      st.phase = 'measuring';
      // The new page reports its size on mount; this only guards against a page that never does.
      st.timer = setTimeout(() => st.phase === 'measuring' && reveal(), 300);
    });
  };
  useEffect(() => {
    const st = m.current;
    clearTimeout(st.timer);
    if (topPage) {
      st.pending = topPage;
      if (st.phase === 'closed') {
        show(topPage);
        setOpen(true);
        st.phase = 'open';
        fade.setValue(1);
        y.setValue(compact ? height : 24);
        backdrop.setValue(0);
        if (motionReduced()) y.setValue(0);
        else
          Animated.spring(y, {
            toValue: 0,
            damping: 30,
            stiffness: 300,
            mass: 0.9,
            useNativeDriver: native,
          }).start();
        animate(backdrop, 1, 240).start();
      } else {
        if (st.phase === 'closing') {
          // Another sheet arrived while this one was leaving: bring it back and hand over.
          st.phase = 'open';
          Animated.spring(y, {
            toValue: 0,
            damping: 30,
            stiffness: 300,
            useNativeDriver: native,
          }).start();
          animate(backdrop, 1, 160).start();
          if (topPage === st.page) {
            setFrozen(undefined);
            animate(fade, 1, 160).start();
          }
        }
        if (topPage !== st.page) swap(topPage);
      }
    } else if (st.phase !== 'closed') {
      // A beat of grace so "close this, open that" in quick succession still reads as one sheet.
      st.timer = setTimeout(() => {
        st.phase = 'closing';
        Animated.parallel([
          Animated.timing(y, {
            toValue: compact ? height : 16,
            duration: motionReduced() ? 0 : 240,
            easing: Easing.in(Easing.cubic),
            useNativeDriver: native,
          }),
          animate(backdrop, 0, 220),
        ]).start(({ finished }) => {
          if (!finished || st.phase !== 'closing') return;
          st.phase = 'closed';
          st.page = st.pending = undefined;
          setOpen(false);
          setPage(undefined);
          setLast(undefined);
          setFrozen(undefined);
          setSized(false);
        });
      }, 40);
    }
  }, [topPage]);
  const measure = (content: number) => {
    const target = Math.min(chrome + content, maxHeight);
    if (!sized) {
      h.setValue(target);
      setSized(true);
    } else
      Animated.timing(h, {
        toValue: target,
        duration: motionReduced() ? 0 : 300,
        easing: Easing.bezier(0.22, 1, 0.36, 1),
        useNativeDriver: false,
      }).start();
    if (m.current.phase === 'measuring') {
      clearTimeout(m.current.timer);
      reveal();
    }
  };
  const close = () => top?.onClose();
  return (
    <Modal
      visible={open}
      transparent
      animationType="none"
      onRequestClose={close}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{
          flex: 1,
          justifyContent: compact ? 'flex-end' : 'center',
          alignItems: 'center',
          padding: compact ? 0 : 30,
        }}
      >
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: color.scrim, opacity: backdrop }]}
        />
        <Pressable
          accessible={false}
          focusable={false}
          onPress={close}
          style={StyleSheet.absoluteFill}
        />
        <Animated.View
          accessibilityViewIsModal
          // Slide and fade run on the native driver; height can't, so it lives on the inner view.
          style={{
            width: '100%',
            maxWidth: compact ? (width > 700 ? 640 : undefined) : 520,
            flexShrink: 1,
            opacity: compact ? 1 : backdrop,
            transform: [{ translateY: y }],
          }}
        >
          <Animated.View
            style={{
              maxHeight,
              height: sized ? h : undefined,
              flexShrink: 1,
              backgroundColor: color.bg,
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              borderBottomLeftRadius: compact ? 0 : radius.xl,
              borderBottomRightRadius: compact ? 0 : radius.xl,
              overflow: 'hidden',
              paddingBottom: compact ? insets.bottom + 6 : 0,
              boxShadow: shadow.float,
            }}
          >
            {compact && (
              <View
                style={{
                  alignSelf: 'center',
                  width: 40,
                  height: 5,
                  borderRadius: 3,
                  backgroundColor: color.line,
                  marginTop: 10,
                  marginBottom: 6,
                }}
              />
            )}
            <View style={{ position: 'absolute', top: compact ? 18 : 20, right: 18, zIndex: 20 }}>
              <IconButton icon={X} label={tr('Close dialog')} onPress={close} size={38} glass />
            </View>
            {entry && (
              <Animated.ScrollView
                key={page}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                onContentSizeChange={(_, content) => measure(content)}
                style={{ opacity: fade }}
              >
                <View
                  style={{ padding: compact ? 22 : 30, paddingTop: compact ? 12 : 30, gap: 18 }}
                >
                  {entry.title && (
                    <Text style={[s.h2, { paddingRight: 50, fontSize: 22, lineHeight: 28 }]}>
                      {entry.title}
                    </Text>
                  )}
                  {entry.children}
                </View>
              </Animated.ScrollView>
            )}
          </Animated.View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
// Full-screen pages slide over the app as plain views rather than native modals, so a sheet can
// always present above them (iOS will not stack a second native modal).
export function useSlideOver(onClose: () => void) {
  const { height } = useChrome();
  const [y] = useState(() => new Animated.Value(height));
  useEffect(() => {
    if (motionReduced()) y.setValue(0);
    else
      Animated.spring(y, {
        toValue: 0,
        damping: 32,
        stiffness: 280,
        mass: 1,
        useNativeDriver: native,
      }).start();
  }, [y]);
  const leave = useCallback(
    () =>
      Animated.timing(y, {
        toValue: height,
        duration: motionReduced() ? 0 : 260,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: native,
      }).start(() => onClose()),
    [y, height, onClose],
  );
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      leave();
      return true;
    });
    return () => sub.remove();
  }, [leave]);
  return { leave, style: [StyleSheet.absoluteFill, { transform: [{ translateY: y }] }] };
}
export function CheckRow({
  checked,
  onPress,
  children,
}: {
  checked: boolean;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const a = useState(() => new Animated.Value(checked ? 1 : 0))[0];
  useEffect(() => {
    Animated.spring(a, {
      toValue: checked ? 1 : 0,
      speed: 20,
      bounciness: 12,
      useNativeDriver: native,
    }).start();
  }, [checked, a]);
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={[s.row, { gap: 14, paddingVertical: 13 }]}
    >
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          borderWidth: 1.5,
          borderColor: checked ? color.ink : color.line,
          backgroundColor: color.white,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <Animated.View
          style={{
            position: 'absolute',
            top: -1.5,
            left: -1.5,
            width: 24,
            height: 24,
            borderRadius: 12,
            backgroundColor: color.ink,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: a.interpolate({
              inputRange: [0, 0.4],
              outputRange: [0, 1],
              extrapolate: 'clamp',
            }),
            transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
          }}
        >
          <Check size={14} color={color.white} strokeWidth={3} />
        </Animated.View>
      </View>
      <Animated.View
        style={{
          flex: 1,
          opacity: a.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0.42],
            extrapolate: 'clamp',
          }),
        }}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}
export function NumberField({
  label,
  value,
  onChange,
  placeholder,
  style,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  placeholder?: string;
  style?: TextInputProps['style'];
}) {
  const { locale } = useI18n();
  const format = (amount: number) =>
    amount
      ? new Intl.NumberFormat(locale, {
          useGrouping: false,
          maximumFractionDigits: 12,
        }).format(amount)
      : '';
  const [entry, setEntry] = useState(() => ({ value, locale, text: format(value) }));
  // Preserve unfinished input; reformat only when the external value or locale changes.
  if (entry.value !== value || entry.locale !== locale) {
    setEntry({ value, locale, text: format(value) });
  }
  return (
    <Field
      label={label}
      value={entry.text}
      keyboardType="decimal-pad"
      placeholder={placeholder}
      style={style}
      onChangeText={(next) => {
        if (/^\d*[.,]?\d*$/.test(next)) {
          const parsed = Number(next.replace(',', '.'));
          const valid = Number.isFinite(parsed);
          setEntry({ value: valid ? parsed : value, locale, text: next });
          if (valid) onChange(parsed);
        }
      }}
    />
  );
}
// Rendered by the shell and again inside full-screen modals, which sit above the shell.
export function Toast({ message, bottom }: { message: string; bottom?: number }) {
  const { t: tr } = useI18n();
  const { compact, insets, width } = useChrome();
  // Holds the last message so it can leave as gracefully as it arrived.
  const [last, setLast] = useState(message);
  if (message && message !== last) setLast(message);
  const shown = message || last;
  const a = useState(() => new Animated.Value(0))[0];
  useEffect(() => {
    if (message)
      Animated.spring(a, {
        toValue: 1,
        damping: 18,
        stiffness: 220,
        useNativeDriver: native,
      }).start();
    else animate(a, 0, 200).start(({ finished }) => finished && setLast(''));
  }, [message, a]);
  if (!shown) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        position: 'absolute',
        left: 16,
        right: 16,
        bottom: bottom ?? (compact ? Math.max(16, insets.bottom) + 84 : 28),
        alignItems: 'center',
        pointerEvents: 'none',
        zIndex: 100,
      }}
    >
      <Animated.View
        style={{
          maxWidth: Math.min(width - 32, 480),
          backgroundColor: color.ink,
          paddingHorizontal: 20,
          paddingVertical: 14,
          borderRadius: radius.pill,
          boxShadow: shadow.float,
          opacity: a.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
          transform: [
            { translateY: a.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) },
            { scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) },
          ],
        }}
      >
        <Text
          style={{
            color: color.white,
            fontFamily: font.semibold,
            fontSize: 14,
            textAlign: 'center',
          }}
        >
          {tr(shown)}
        </Text>
      </Animated.View>
    </View>
  );
}
