import type { UnitChoice } from './types';

export type { UnitChoice } from './types';
export type UnitSystem = Exclude<UnitChoice, ''>;
/** The units an amount converted to a system comes out in. */
export type Measure = 'g' | 'kg' | 'oz' | 'lb' | 'ml' | 'l' | 'tsp' | 'tbsp' | 'cup';
/** What a unit measures, its size in grams or millilitres, and whether it is a spoon or metric. */
export type KnownUnit = {
  kind: 'mass' | 'volume';
  size: number;
  spoon?: boolean;
  metric?: boolean;
};

// Ingredient units are free text, so these are the spellings a recipe is likely to use in the
// app's languages, after `clean` (lower case, periods as spaces, single spaces). Volumes follow the
// US kitchen convention of a 240 ml cup: 16 tablespoons of 15 ml, 48 teaspoons of 5 ml, 8 fluid
// ounces of 30 ml. Only the English cup has a known size (a Japanese カップ is 200 ml, a Russian
// стакан about as much), so the others stay as the recipe wrote them.
const spellings: [KnownUnit, string][] = [
  [
    { kind: 'mass', size: 1, metric: true },
    'g gr grs gram grams gramme grammes gramm grammi grammo gramo gramos grama gramas г гр грамм грамма граммов 克 グラム',
  ],
  [
    { kind: 'mass', size: 1000, metric: true },
    'kg kgs kilo kilos kilogram kilograms kilogramme kilogrammes kilogramm chilogrammo chilogrammi kilogramo kilogramos quilo quilos quilograma quilogramas кг килограмм килограмма килограммов 千克 公斤 キロ キログラム',
  ],
  [
    { kind: 'mass', size: 28.349523125 },
    'oz ozs ounce ounces onza onzas oncia once onça onças unze unzen унция унции унций унц 盎司 オンス',
  ],
  [
    { kind: 'mass', size: 453.59237 },
    'lb lbs pound pounds libra libras libbra libbre pfund фунт фунта фунтов 磅 ポンド',
  ],
  [
    { kind: 'volume', size: 1, metric: true },
    'ml mls milliliter milliliters millilitre millilitres millilitro millilitri mililitro mililitros мл миллилитр миллилитра миллилитров 毫升 ミリリットル',
  ],
  [
    { kind: 'volume', size: 10, metric: true },
    'cl centiliter centiliters centilitre centilitres centilitro centilitri centilitros',
  ],
  [
    { kind: 'volume', size: 100, metric: true },
    'dl deciliter deciliters decilitre decilitres decilitro decilitri decilitros',
  ],
  [
    { kind: 'volume', size: 1000, metric: true },
    'l liter liters litre litres litro litri litros л литр литра литров 升 リットル',
  ],
  [
    { kind: 'volume', size: 5, spoon: true },
    'tsp tsps teaspoon teaspoons tl teelöffel cdta cucharadita cucharaditas cucchiaino cucchiaini 茶匙 小匙 小さじ',
  ],
  [
    { kind: 'volume', size: 15, spoon: true },
    'tbsp tbsps tbs tbl tblsp tablespoon tablespoons el esslöffel cda cdas cucharada cucharadas cucchiaio cucchiai 汤匙 大匙 大さじ',
  ],
  [{ kind: 'volume', size: 240 }, 'cup cups'],
  [{ kind: 'volume', size: 30 }, 'floz'],
  [{ kind: 'volume', size: 480 }, 'pint pints pt pts'],
  [{ kind: 'volume', size: 960 }, 'quart quarts qt qts'],
  [{ kind: 'volume', size: 3840 }, 'gallon gallons gal'],
];
// Spellings of more than one word, as the unit they stand for.
const phrases: [string, string][] = [
  ['c à c', 'tsp'],
  ['c à café', 'tsp'],
  ['cuillère à café', 'tsp'],
  ['cuillères à café', 'tsp'],
  ['colher de chá', 'tsp'],
  ['colheres de chá', 'tsp'],
  ['colher (chá)', 'tsp'],
  ['colheres (chá)', 'tsp'],
  ['ч л', 'tsp'],
  ['чайная ложка', 'tsp'],
  ['чайной ложки', 'tsp'],
  ['чайные ложки', 'tsp'],
  ['чайных ложек', 'tsp'],
  ['c à s', 'tbsp'],
  ['c à soupe', 'tbsp'],
  ['cuillère à soupe', 'tbsp'],
  ['cuillères à soupe', 'tbsp'],
  ['colher de sopa', 'tbsp'],
  ['colheres de sopa', 'tbsp'],
  ['colher (sopa)', 'tbsp'],
  ['colheres (sopa)', 'tbsp'],
  ['ст л', 'tbsp'],
  ['столовая ложка', 'tbsp'],
  ['столовой ложки', 'tbsp'],
  ['столовые ложки', 'tbsp'],
  ['столовых ложек', 'tbsp'],
  ['fl oz', 'floz'],
  ['fluid ounce', 'floz'],
  ['fluid ounces', 'floz'],
  ['fl ounce', 'floz'],
  ['fl ounces', 'floz'],
];
const known = new Map<string, KnownUnit>();
for (const [unit, names] of spellings) for (const name of names.split(' ')) known.set(name, unit);
for (const [phrase, name] of phrases) known.set(phrase, known.get(name)!);
const clean = (unit: string) => unit.toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();

/** What a unit measures, or null for counts (cloves, a pinch, none) and units it doesn't know. */
export function knownUnit(unit: string | null | undefined): KnownUnit | null {
  return known.get(clean(unit || '')) ?? null;
}

/** An amount for `servings` from a recipe written for `base`; missing amounts are 0. */
export function scaleAmount(amount: number, servings: number, base: number) {
  const value = Number.isFinite(amount) && amount > 0 ? amount : 0;
  return base > 0 && servings > 0 ? (value * servings) / base : value;
}

// The fractions of measuring cups and spoons.
const fractions: [number, string][] = [
  [0, ''],
  [1 / 8, '⅛'],
  [1 / 4, '¼'],
  [1 / 3, '⅓'],
  [1 / 2, '½'],
  [2 / 3, '⅔'],
  [3 / 4, '¾'],
  [1, ''],
];
/** The nearest whole number and kitchen fraction: 1.3 is 1⅓, 0.9 is 1. */
export function nearestFraction(value: number) {
  let whole = Math.floor(value);
  let [part, glyph] = fractions[0];
  for (const [f, g] of fractions)
    if (Math.abs(value - whole - f) < Math.abs(value - whole - part)) [part, glyph] = [f, g];
  if (part === 1) [whole, part, glyph] = [whole + 1, 0, ''];
  return { value: whole + part, whole, glyph };
}

const round = (value: number, digits: number) => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
// Grams and millilitres read best whole from ten, with a decimal below; kilograms and litres keep
// two decimals.
const fineDigits = (value: number) => (value >= 10 ? 0 : value >= 1 ? 1 : 2);
const metricRound = (value: number, coarse: boolean) =>
  round(value, coarse ? 2 : fineDigits(value));

export type Style = 'decimal' | 'fraction' | 'count';
/**
 * An amount as text. `decimal` is metric, in the locale's numbers: whole grams from ten, two
 * decimals for `coarse` units (kilograms, litres). `fraction` uses kitchen fractions (spoons, cups,
 * ounces); `count` does too for a few and rounds many to whole ones. Returns the number shown, for
 * choosing a plural; nothing to show (no amount, "to taste") is ''.
 */
export function formatAmount(value: number, style: Style, locale: string, coarse = false) {
  const number = (n: number, digits: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
  if (!(value > 0)) return { text: '', value: 0 };
  if (style === 'decimal') {
    const shown = metricRound(value, coarse);
    // Less than the rounding shows (a trace of something): say how little rather than 0.
    return shown > 0
      ? { text: number(shown, 2), value: shown }
      : { text: number(value, 3), value: round(value, 3) };
  }
  if (style === 'count' && value >= 10) {
    const shown = Math.round(value);
    return { text: number(shown, 0), value: shown };
  }
  const near = nearestFraction(value);
  if (near.value === 0) return { text: number(value, 2), value: round(value, 2) };
  return { text: `${near.whole ? number(near.whole, 0) : ''}${near.glyph}`, value: near.value };
}

export type ShownAmount = {
  /** The number as text: '' when the recipe gives none, such as salt to taste. */
  amount: string;
  /** The number shown, for choosing a plural. */
  value: number;
  /** A converted amount's unit, which the caller names in the reader's language. */
  measure: Measure | null;
  /** Otherwise the recipe's own unit, as written. */
  unit: string;
};

const ounce = 28.349523125;
const pound = 453.59237;
// The unit an amount reads best in, chosen after rounding it the way it will show: 14.9 ml is
// three teaspoons, which is a tablespoon. `base` is in grams or millilitres.
function inMeasure(base: number, unit: KnownUnit, system: UnitSystem): [number, Measure] {
  if (unit.kind === 'mass') {
    if (system === 'imperial')
      return nearestFraction(base / ounce).value < 16 ? [base / ounce, 'oz'] : [base / pound, 'lb'];
    const grams = metricRound(base, false);
    return grams >= 1000 ? [metricRound(grams / 1000, true), 'kg'] : [grams, 'g'];
  }
  // Spoons measure in both systems. Metric keeps a recipe's spoons up to a quarter cup rather than
  // turn half a teaspoon into 2.5 ml; imperial measures everything below that in spoons.
  if (system === 'imperial' || unit.spoon) {
    if (nearestFraction(base / 5).value * 5 < 15) return [base / 5, 'tsp'];
    if (nearestFraction(base / 15).value * 15 < 60) return [base / 15, 'tbsp'];
    if (system === 'imperial') return [base / 240, 'cup'];
  }
  const ml = metricRound(base, false);
  return ml >= 1000 ? [metricRound(ml / 1000, true), 'l'] : [ml, 'ml'];
}

/**
 * An ingredient's amount for `servings`, in the recipe's own units (`units` '') or converted to
 * metric or imperial. Counts (cloves, eggs, a pinch) and units it doesn't know keep the recipe's
 * words in every system.
 */
export function showAmount(
  ingredient: { amount: number; unit: string },
  options: { servings: number; base: number; units: UnitChoice; locale: string },
): ShownAmount {
  const value = scaleAmount(ingredient.amount, options.servings, options.base);
  const unit = (ingredient.unit || '').trim();
  const size = knownUnit(unit);
  if (size && options.units && value > 0) {
    const [amount, measure] = inMeasure(value * size.size, size, options.units);
    const metric = measure === 'g' || measure === 'kg' || measure === 'ml' || measure === 'l';
    const shown = formatAmount(
      amount,
      metric ? 'decimal' : 'fraction',
      options.locale,
      measure === 'kg' || measure === 'l',
    );
    return { amount: shown.text, value: shown.value, measure, unit: '' };
  }
  const shown = size
    ? formatAmount(value, size.metric ? 'decimal' : 'fraction', options.locale, size.size >= 10)
    : formatAmount(value, 'count', options.locale);
  return { amount: shown.text, value: shown.value, measure: null, unit };
}
