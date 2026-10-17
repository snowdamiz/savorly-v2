/// <reference types="jest" />
import {
  formatAmount,
  knownUnit,
  nearestFraction,
  scaleAmount,
  showAmount,
  type UnitChoice,
} from '../units';

const show = (amount: number, unit: string, units: UnitChoice, servings = 4, locale = 'en-US') =>
  showAmount({ amount, unit }, { servings, base: 4, units, locale });
// The amount and unit as one string, the way the page puts them together.
const text = (amount: number, unit: string, units: UnitChoice, servings = 4, locale = 'en-US') => {
  const shown = show(amount, unit, units, servings, locale);
  return [shown.amount, shown.measure ?? shown.unit].filter(Boolean).join(' ');
};

describe('units it knows', () => {
  test('common spellings, any case, with or without periods', () => {
    for (const unit of ['g', 'Grams', 'gr', 'г', '克', 'グラム'])
      expect(knownUnit(unit)).toMatchObject({ kind: 'mass', size: 1 });
    for (const unit of [
      'tbsp',
      'TBSP',
      'Tablespoons',
      'tbs',
      'EL',
      'c. à soupe',
      'ст. л.',
      'ст.л.',
      '大さじ',
    ])
      expect(knownUnit(unit)).toMatchObject({ kind: 'volume', size: 15, spoon: true });
    for (const unit of ['tsp', 'teaspoon', 'TL', 'c. à c.', 'ч. л.', '小さじ', 'colher (chá)'])
      expect(knownUnit(unit)).toMatchObject({ kind: 'volume', size: 5, spoon: true });
    expect(knownUnit('fl. oz.')).toMatchObject({ kind: 'volume', size: 30 });
    expect(knownUnit('Cups')).toMatchObject({ kind: 'volume', size: 240 });
    expect(knownUnit('lbs')).toMatchObject({ kind: 'mass' });
    expect(knownUnit('kg')).toMatchObject({ kind: 'mass', size: 1000, metric: true });
    expect(knownUnit(' dl ')).toMatchObject({ kind: 'volume', size: 100, metric: true });
  });

  test('counts and units of no fixed size are left alone', () => {
    for (const unit of [
      '',
      'cloves',
      'pinch',
      'slices',
      'can',
      'bunch',
      'カップ',
      'стакан',
      'tasse',
      't',
      'c',
      null,
      undefined,
    ])
      expect(knownUnit(unit)).toBeNull();
  });
});

describe('scaling', () => {
  test('by servings, from the recipe’s own', () => {
    expect(scaleAmount(200, 6, 4)).toBe(300);
    expect(scaleAmount(1, 1, 3)).toBeCloseTo(1 / 3);
  });
  test('missing or odd amounts and servings', () => {
    expect(scaleAmount(2, 4, 0)).toBe(2);
    expect(scaleAmount(-1, 2, 2)).toBe(0);
    expect(scaleAmount(Number.NaN, 2, 2)).toBe(0);
  });
});

describe('fractions', () => {
  test('the nearest kitchen fraction', () => {
    expect(nearestFraction(1.3)).toEqual({ value: 1 + 1 / 3, whole: 1, glyph: '⅓' });
    expect(nearestFraction(0.9)).toEqual({ value: 1, whole: 1, glyph: '' });
    expect(nearestFraction(0.1)).toMatchObject({ whole: 0, glyph: '⅛' });
    expect(nearestFraction(2.5)).toMatchObject({ whole: 2, glyph: '½' });
    expect(nearestFraction(0.7)).toMatchObject({ glyph: '⅔' });
    expect(nearestFraction(0.74)).toMatchObject({ glyph: '¾' });
    expect(nearestFraction(0.04)).toMatchObject({ value: 0 });
  });

  test('spoons, cups and a few of something read as fractions', () => {
    expect(formatAmount(1.5, 'fraction', 'en-US')).toEqual({ text: '1½', value: 1.5 });
    expect(formatAmount(0.25, 'fraction', 'en-US')).toEqual({ text: '¼', value: 0.25 });
    expect(formatAmount(3, 'fraction', 'en-US')).toEqual({ text: '3', value: 3 });
    expect(formatAmount(2.5, 'count', 'en-US').text).toBe('2½');
    // Many of something are counted whole.
    expect(formatAmount(12.5, 'count', 'en-US')).toEqual({ text: '13', value: 13 });
    // Less than an eighth still shows how little.
    expect(formatAmount(0.02, 'fraction', 'en-US').text).toBe('0.02');
    expect(formatAmount(0, 'fraction', 'en-US')).toEqual({ text: '', value: 0 });
  });

  test('metric amounts use the locale’s decimals, rounded to what a cook can weigh', () => {
    expect(formatAmount(0.5, 'decimal', 'fr-FR').text).toBe('0,5');
    expect(formatAmount(0.5, 'decimal', 'en-US').text).toBe('0.5');
    expect(formatAmount(333.333, 'decimal', 'en-US').text).toBe('333');
    expect(formatAmount(2.345, 'decimal', 'de-DE').text).toBe('2,3');
    expect(formatAmount(1.256, 'decimal', 'de-DE', true).text).toBe('1,26');
    expect(formatAmount(1500, 'decimal', 'en-US').text).toBe('1,500');
  });
});

describe('as written', () => {
  test('keeps the recipe’s units, scaled to the servings', () => {
    expect(text(800, 'g', '', 2)).toBe('400 g');
    expect(text(1.5, 'cups', '', 4)).toBe('1½ cups');
    expect(text(2, 'tbsp', '', 3)).toBe('1½ tbsp');
    expect(text(1500, 'g', '', 4)).toBe('1,500 g');
    expect(text(3, 'cloves', '', 2)).toBe('1½ cloves');
    expect(text(2, '', '', 4)).toBe('2');
    expect(text(0.5, 'g', '', 4, 'fr-FR')).toBe('0,5 g');
  });

  test('an amount of nothing shows only its words', () => {
    expect(show(0, 'to taste', '')).toEqual({
      amount: '',
      value: 0,
      measure: null,
      unit: 'to taste',
    });
    expect(show(0, 'g', 'metric')).toMatchObject({ amount: '', measure: null, unit: 'g' });
  });
});

describe('metric', () => {
  test('cups and fluid ounces become millilitres and litres', () => {
    expect(text(1, 'cup', 'metric')).toBe('240 ml');
    expect(text(1 / 3, 'cup', 'metric')).toBe('80 ml');
    expect(text(5, 'cups', 'metric')).toBe('1.2 l');
    expect(text(8, 'fl oz', 'metric')).toBe('240 ml');
    expect(text(2, 'pints', 'metric')).toBe('960 ml');
  });

  test('ounces and pounds become grams and kilograms', () => {
    expect(text(8, 'oz', 'metric')).toBe('227 g');
    expect(text(1, 'lb', 'metric')).toBe('454 g');
    expect(text(3, 'lb', 'metric')).toBe('1.36 kg');
    expect(text(0.25, 'oz', 'metric')).toBe('7.1 g');
  });

  test('metric amounts move to the unit that reads best', () => {
    expect(text(1000, 'g', 'metric')).toBe('1 kg');
    expect(text(1500, 'grams', 'metric')).toBe('1.5 kg');
    expect(text(999.7, 'g', 'metric')).toBe('1 kg');
    expect(text(0.25, 'kg', 'metric')).toBe('250 g');
    expect(text(2, 'dl', 'metric')).toBe('200 ml');
    expect(text(1.5, 'l', 'metric', 4, 'de-DE')).toBe('1,5 l');
  });

  test('spoons stay spoons below a quarter cup', () => {
    expect(text(2, 'tbsp', 'metric')).toBe('2 tbsp');
    expect(text(1, 'tsp', 'metric', 2)).toBe('½ tsp');
    expect(text(6, 'tsp', 'metric')).toBe('2 tbsp');
    expect(text(8, 'tbsp', 'metric')).toBe('120 ml');
  });

  test('counts and unknown units are left as written', () => {
    expect(show(2, 'cans', 'metric')).toMatchObject({ amount: '2', measure: null, unit: 'cans' });
    expect(show(1, 'カップ', 'metric')).toMatchObject({
      amount: '1',
      measure: null,
      unit: 'カップ',
    });
  });
});

describe('imperial', () => {
  test('grams become ounces, and pounds from a pound', () => {
    expect(text(250, 'g', 'imperial')).toBe('8¾ oz');
    expect(text(200, 'g', 'imperial')).toBe('7 oz');
    expect(text(500, 'g', 'imperial')).toBe('1⅛ lb');
    expect(text(1, 'kg', 'imperial')).toBe('2¼ lb');
    expect(text(454, 'g', 'imperial')).toBe('1 lb');
    expect(text(450, 'g', 'imperial')).toBe('15¾ oz');
  });

  test('millilitres become teaspoons, tablespoons and cups', () => {
    expect(text(5, 'ml', 'imperial')).toBe('1 tsp');
    expect(text(15, 'ml', 'imperial')).toBe('1 tbsp');
    expect(text(14.9, 'ml', 'imperial')).toBe('1 tbsp');
    expect(text(45, 'ml', 'imperial')).toBe('3 tbsp');
    expect(text(60, 'ml', 'imperial')).toBe('¼ cup');
    expect(text(240, 'ml', 'imperial')).toBe('1 cup');
    expect(text(1, 'l', 'imperial')).toBe('4⅛ cup');
  });

  test('spoons add up: three teaspoons to a tablespoon, sixteen tablespoons to a cup', () => {
    expect(text(3, 'tsp', 'imperial')).toBe('1 tbsp');
    expect(text(16, 'tbsp', 'imperial')).toBe('1 cup');
    expect(text(2, 'tbsp', 'imperial', 16)).toBe('½ cup');
    expect(text(2, 'tbsp', 'imperial', 1)).toBe('1½ tsp');
  });

  test('the number shown is the one plurals follow', () => {
    expect(show(1.5, 'cups', 'imperial')).toMatchObject({
      amount: '1½',
      value: 1.5,
      measure: 'cup',
    });
    expect(show(1, 'cup', 'imperial', 2)).toMatchObject({
      amount: '½',
      value: 0.5,
      measure: 'cup',
    });
  });

  test('locale numbers for the whole part', () => {
    expect(text(2400, 'ml', 'imperial', 4, 'de-DE')).toBe('10 cup');
    expect(text(1500, 'g', 'imperial', 4, 'ru-RU')).toBe('3⅓ lb');
  });
});
