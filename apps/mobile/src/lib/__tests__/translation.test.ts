/// <reference types="jest" />
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Recipe, RecipeTranslation } from '../types';
import {
  TRANSLATIONS_KEPT,
  fingerprint,
  keepTranslation,
  keptTranslation,
  parseKept,
  translatable,
  translated,
  withKept,
} from '../translation';

const soup = (extra: Partial<Recipe> = {}): Recipe => ({
  id: 'soup',
  title: 'Soupe à l’oignon',
  description: 'Une soupe gratinée.',
  cuisine: 'French',
  minutes: 60,
  servings: 4,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [
    { name: 'Oignons', amount: 1, unit: 'kg', category: 'Produce' },
    { name: 'Beurre', amount: 50, unit: 'g', category: 'Dairy' },
  ],
  steps: [
    {
      title: 'Oignons',
      text: 'Faites fondre les oignons.',
      seconds: 2400,
      image: 'https://m.test/1.jpg',
    },
    { title: 'Servir', text: 'Servez chaud.', seconds: 0 },
  ],
  tags: ['Vegetarian'],
  calories: 300,
  aiGenerated: false,
  published: true,
  language: 'fr',
  author: { id: 'cook', name: 'Robin', handle: 'robin', bio: '', avatar: '' },
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-10-01T00:00:00Z',
  ...extra,
});
const english: RecipeTranslation = {
  language: 'en',
  sourceLanguage: 'fr',
  title: 'French onion soup',
  description: 'A soup with a cheese crust.',
  ingredients: [{ name: 'Onions' }, { name: 'Butter' }],
  steps: [
    { title: 'Onions', text: 'Cook the onions down.' },
    { title: 'Serve', text: 'Serve hot.' },
  ],
  translatedAt: '2026-10-17T00:00:00Z',
};

beforeEach(() => AsyncStorage.clear());

test('only a recipe in another of the app’s languages is offered a translation', () => {
  expect(translatable(soup(), 'en')).toBe(true);
  expect(translatable(soup(), 'fr')).toBe(false);
  expect(translatable(soup({ language: '' }), 'en')).toBe(false);
  expect(translatable(soup({ language: undefined }), 'en')).toBe(false);
  expect(translatable(soup({ language: 'tlh' }), 'en')).toBe(false);
});

test('a translation replaces the words and keeps amounts, units, timers, media and tags', () => {
  const read = translated(soup(), english)!;
  expect(read.title).toBe('French onion soup');
  expect(read.language).toBe('en');
  expect(read.ingredients).toEqual([
    { name: 'Onions', amount: 1, unit: 'kg', category: 'Produce' },
    { name: 'Butter', amount: 50, unit: 'g', category: 'Dairy' },
  ]);
  expect(read.steps[0]).toEqual({
    title: 'Onions',
    text: 'Cook the onions down.',
    seconds: 2400,
    image: 'https://m.test/1.jpg',
  });
  expect(read.tags).toEqual(['Vegetarian']);
  expect(read.cuisine).toBe('French');
  // A translation of another version of the recipe doesn't apply.
  expect(translated(soup(), { ...english, steps: english.steps.slice(1) })).toBeNull();
  expect(translated(soup(), { ...english, ingredients: [] })).toBeNull();
});

test('the fingerprint changes with the text and the language, not with the rest', () => {
  const print = fingerprint(soup());
  expect(fingerprint(soup({ minutes: 10, servings: 2, image: 'https://m.test/new.jpg' }))).toBe(
    print,
  );
  expect(fingerprint(soup({ title: 'Soupe gratinée' }))).not.toBe(print);
  expect(fingerprint(soup({ language: 'it' }))).not.toBe(print);
  expect(
    fingerprint(
      soup({ steps: [soup().steps[0], { title: 'Servir', text: 'Servez tiède.', seconds: 0 }] }),
    ),
  ).not.toBe(print);
});

test('the cook’s equipment reads translated name for name, and changes what is translated', () => {
  const pots = soup({ equipment: ['Grande casserole', 'Mixeur plongeant'] });
  const read = translated(pots, { ...english, equipment: ['Large pot', 'Immersion blender'] })!;
  expect(read.equipment).toEqual(['Large pot', 'Immersion blender']);
  // Without a name for each, the cook's own words stay; the rest is still translated.
  const partial = translated(pots, { ...english, equipment: ['Large pot'] })!;
  expect(partial.equipment).toEqual(['Grande casserole', 'Mixeur plongeant']);
  expect(partial.title).toBe('French onion soup');
  expect(translated(soup(), english)!.equipment).toBeUndefined();
  // A recipe without a list keeps the fingerprint it had, so kept translations still apply.
  expect(fingerprint(soup({ equipment: [] }))).toBe(fingerprint(soup()));
  expect(fingerprint(pots)).not.toBe(fingerprint(soup()));
  expect(fingerprint(soup({ equipmentDetected: ['pot'] }))).toBe(fingerprint(soup()));
});

test('the device keeps the newest translations, one per recipe and language', () => {
  const kept = (recipe: string, language = 'en') => ({
    recipe,
    fingerprint: 'x',
    translation: { ...english, language },
  });
  let list = [kept('a'), kept('b')];
  list = withKept(list, kept('a', 'de'));
  expect(list.map((k) => `${k.recipe}:${k.translation.language}`)).toEqual([
    'a:de',
    'a:en',
    'b:en',
  ]);
  list = withKept(list, kept('b'));
  expect(list.map((k) => `${k.recipe}:${k.translation.language}`)).toEqual([
    'b:en',
    'a:de',
    'a:en',
  ]);
  for (let n = 0; n < TRANSLATIONS_KEPT + 5; n++) list = withKept(list, kept(`r${n}`));
  expect(list).toHaveLength(TRANSLATIONS_KEPT);
  expect(parseKept('not json')).toEqual([]);
  expect(parseKept(JSON.stringify([kept('a'), { recipe: 'b' }, null]))).toEqual([kept('a')]);
});

test('a kept translation reads back only for the recipe as it was translated', async () => {
  keepTranslation(soup(), english);
  expect(await keptTranslation(soup(), 'en')).toEqual(english);
  expect(await keptTranslation(soup(), 'de')).toBeNull();
  expect(await keptTranslation(soup({ title: 'Soupe gratinée' }), 'en')).toBeNull();
  // A cook's draft isn't kept: it mustn't stay on the device after signing out.
  keepTranslation(soup({ id: 'draft', published: false }), english);
  expect(await keptTranslation(soup({ id: 'draft', published: false }), 'en')).toBeNull();
});

test('storage that fails is no translation, not an error', async () => {
  const read = jest.spyOn(AsyncStorage, 'getItem').mockRejectedValue(new Error('full'));
  expect(await keptTranslation(soup(), 'en')).toBeNull();
  read.mockRestore();
});
