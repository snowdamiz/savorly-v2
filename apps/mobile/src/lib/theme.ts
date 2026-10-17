import { StyleSheet } from 'react-native';
// Monochrome surfaces; the only hues are semantic (success / warning / error).
// Text and icons keep 4.5:1 on white and on the page (`bg`): `soft` is the lightest for them.
// `outline` edges controls (fields, chips, secondary buttons, checkboxes) at 3:1 on both;
// `border` and `line` are for decorative edges and hairlines only.
export const color = {
  ink: '#0D0D0D',
  muted: '#6B6B6B',
  soft: '#707070',
  bg: '#F4F4F4',
  white: '#FFFFFF',
  border: '#E6E6E6',
  line: '#D4D4D4',
  outline: '#8D8D8D',
  subtle: '#ECECEC',
  onInk: '#9C9C9C',
  glass: 'rgba(255,255,255,0.16)',
  glassBorder: 'rgba(255,255,255,0.22)',
  scrim: 'rgba(0,0,0,0.42)',
  success: '#1E8A4C',
  successBg: '#E6F4EB',
  warning: '#A86A12',
  warningBg: '#FBF1DF',
  error: '#C93A30',
  errorBg: '#FBE9E7',
};
export const radius = { sm: 14, md: 20, lg: 28, xl: 36, pill: 999 };
export const shadow = {
  card: '0px 1px 2px rgba(0,0,0,0.04), 0px 6px 20px rgba(0,0,0,0.05)',
  float: '0px 14px 40px rgba(0,0,0,0.28)',
};
export const font = {
  regular: 'Manrope_400Regular',
  medium: 'Manrope_500Medium',
  semibold: 'Manrope_600SemiBold',
  bold: 'Manrope_700Bold',
  extra: 'Manrope_800ExtraBold',
};
/** How far text in compact controls (pills, chips, day cells) follows a larger system text size;
 * the controls grow with it (minHeight), and beyond this the text stops growing. */
export const maxFontScale = 1.6;
export const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  card: {
    backgroundColor: color.white,
    borderRadius: radius.lg,
    padding: 20,
    boxShadow: shadow.card,
  },
  display: {
    fontFamily: font.extra,
    color: color.ink,
    fontSize: 32,
    letterSpacing: -1.1,
    lineHeight: 38,
  },
  h1: {
    fontFamily: font.extra,
    color: color.ink,
    fontSize: 28,
    letterSpacing: -1,
    lineHeight: 34,
  },
  h2: {
    fontFamily: font.bold,
    color: color.ink,
    fontSize: 20,
    letterSpacing: -0.5,
    lineHeight: 26,
  },
  h3: {
    fontFamily: font.bold,
    color: color.ink,
    fontSize: 16,
    letterSpacing: -0.25,
    lineHeight: 22,
  },
  body: { fontFamily: font.medium, color: color.ink, fontSize: 15, lineHeight: 23 },
  muted: { fontFamily: font.regular, color: color.muted, fontSize: 14, lineHeight: 21 },
  small: { fontFamily: font.semibold, color: color.muted, fontSize: 12, lineHeight: 16 },
  label: {
    fontFamily: font.bold,
    color: color.muted,
    fontSize: 11,
    letterSpacing: 1.3,
    textTransform: 'uppercase',
  },
  input: {
    fontFamily: font.medium,
    color: color.ink,
    fontSize: 15,
    backgroundColor: color.white,
    borderWidth: 1,
    borderColor: color.outline,
    borderRadius: 18,
    paddingHorizontal: 18,
    paddingVertical: 15,
    minHeight: 54,
  },
});
