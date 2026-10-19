// Cooking mode shows a step on one screen without scrolling where it can: its title and text take
// the largest of a few type sizes that fits the room there is, worked out from the words before
// they're drawn, so a new step comes up at its size straight away. Screens big enough start a size
// up. Below the smallest, which still reads at arm's length, a long step scrolls instead.

export type StepType = { title: number; titleLine: number; text: number; textLine: number };

/** From the largest down. Phones start at the second. */
export const STEP_TYPES: readonly StepType[] = [
  { title: 38, titleLine: 44, text: 24, textLine: 36 },
  { title: 30, titleLine: 36, text: 20, textLine: 31 },
  { title: 26, titleLine: 32, text: 18, textLine: 27 },
  { title: 22, titleLine: 28, text: 16, textLine: 24 },
];

// Manrope's average advance, in ems: about 0.47 for Latin text (spaces included) and 0.51 for
// Cyrillic, rounded up a little so an estimate errs toward fitting. Chinese, Japanese and Korean
// characters are a full em, and a line can break between any two of them.
const NARROW = 0.5;
const WIDE = 1;
const wide = /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;
const pieces =
  /[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]|[^\s\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]+\s*|\s+/g;

const ems = (text: string) => {
  let n = 0;
  for (const ch of text) n += wide.test(ch) ? WIDE : NARROW;
  return n;
};

/** How many lines `text` wraps to at `size` points in a column `width` points wide. */
export function lineCount(text: string, size: number, width: number) {
  if (!text.trim()) return 0;
  if (width <= 0) return Infinity;
  let lines = 0;
  for (const paragraph of text.split('\n')) {
    lines += 1;
    let used = 0;
    for (const piece of paragraph.match(pieces) ?? []) {
      // A word that doesn't fit after others starts the next line; the space after it never wraps.
      const word = ems(piece.trimEnd()) * size;
      if (used > 0 && used + word > width) {
        lines += 1;
        used = 0;
      }
      used += ems(piece) * size;
      // A word longer than the line breaks across lines by itself.
      while (used > width + size) {
        lines += 1;
        used -= width;
      }
    }
  }
  return lines;
}

/**
 * The largest type (an index into STEP_TYPES) at which a step's title and text, plus `reserved`
 * points of everything around them, fit `height`; the smallest when nothing does.
 */
export function stepType({
  title,
  text,
  width,
  height,
  big,
  reserved = 0,
  fontScale = 1,
}: {
  title: string;
  text: string;
  width: number;
  height: number;
  big: boolean;
  reserved?: number;
  /** The system's text size, which scales every font in the app. */
  fontScale?: number;
}) {
  const last = STEP_TYPES.length - 1;
  for (let i = big ? 0 : 1; i < last; i++) {
    const t = STEP_TYPES[i];
    const words =
      lineCount(title, t.title * fontScale, width) * t.titleLine +
      lineCount(text, t.text * fontScale, width) * t.textLine;
    if (words * fontScale + reserved <= height) return i;
  }
  return last;
}
