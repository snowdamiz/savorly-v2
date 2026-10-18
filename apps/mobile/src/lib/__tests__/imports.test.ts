/// <reference types="jest" />
import { batchesOf, mealimeLink, mealimeName, readPaste, recipeLinks, siteOf } from '../imports';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

const stew = `Grandma's stew
Serves 4

Ingredients
500 g beef
2 onions

Method
Brown the beef, add the onions and leave it in a low oven all afternoon.`;

const pancakes = `Pancakes
Ingredients
200 g flour
2 eggs
Method
Whisk everything together and fry ladlefuls in a hot pan.`;

test('every link in what the cook pasted, once each and in order', () => {
  expect(
    recipeLinks(`Saved from Mealime:
https://cook.example/lemon-pasta
Try this one! https://blog.example/soup?x=1. And https://cook.example/lemon-pasta again
<a href="https://bookmarks.example/pie">Pie</a>
example.com/bare
not a link`),
  ).toEqual([
    'https://cook.example/lemon-pasta',
    'https://blog.example/soup?x=1',
    'https://bookmarks.example/pie',
    'https://example.com/bare',
  ]);
  expect(recipeLinks('https://cook.example/ahttps://cook.example/b')).toEqual([
    'https://cook.example/a',
    'https://cook.example/b',
  ]);
  expect(recipeLinks('')).toEqual([]);
});

test('links and the recipes a cook wrote, told apart', () => {
  const links = 'My saved recipes\nhttps://cook.example/a\nhttps://cook.example/b';
  expect(readPaste(links)).toEqual({
    links: ['https://cook.example/a', 'https://cook.example/b'],
    texts: [],
  });
  // Recipes between lines of dashes, or one after another, each on their own.
  expect(readPaste(`${links}\n---\n${stew}\n\n${pancakes}`)).toEqual({
    links: ['https://cook.example/a', 'https://cook.example/b'],
    texts: [stew, pancakes],
  });
  expect(readPaste(`${stew}\n***\n${pancakes}`).texts).toEqual([stew, pancakes]);
  const blini = 'Блины\nИнгредиенты:\n2 яйца\n500 мл молока\nПриготовление\nСмешать и жарить.';
  const oyakodon = '親子丼\n\n材料\n鶏もも肉 200g\n卵 3個\n\n作り方\n煮て、卵でとじる。';
  expect(readPaste(`${blini}\n\n${oyakodon}\n\n${pancakes}`).texts).toEqual([
    blini,
    oyakodon,
    pancakes,
  ]);
  // A recipe that mentions a link stays a recipe; a short note is neither.
  const sourced = `${stew}\nFrom https://family.example/notes, with my changes to the timings.`;
  expect(readPaste(sourced)).toEqual({ links: [], texts: [sourced] });
  expect(readPaste('Mum’s stew')).toEqual({ links: [], texts: [] });
});

test('batches the server takes: 50 items, 10 of them recipes, links first', () => {
  const links = Array.from({ length: 120 }, (_, i) => `https://cook.example/${i}`);
  const texts = Array.from({ length: 12 }, (_, i) => `Recipe ${i}`);
  const batches = batchesOf({ links, texts });
  expect(batches.map((b) => [b.urls.length, b.texts.length])).toEqual([
    [50, 0],
    [50, 0],
    [20, 10],
    [0, 2],
  ]);
  expect(batches.flatMap((b) => b.urls)).toEqual(links);
  expect(batchesOf({ links: [], texts: [] })).toEqual([]);
});

test('Mealime’s own recipes, by the name their link gives them', () => {
  expect(mealimeName('https://www.mealime.com/recipes/lemony-chicken-orzo/1234')).toBe(
    'Lemony chicken orzo',
  );
  expect(mealimeName('https://mealime.com/recipes/sheet_pan_fajitas-8812')).toBe(
    'Sheet pan fajitas',
  );
  expect(mealimeName('https://www.mealime.com/recipes/caf%C3%A9-au-lait/9')).toBe('Café au lait');
  expect(mealimeName('https://cook.example/recipes/lemony-chicken-orzo')).toBe('');
  expect(mealimeLink('https://app.mealime.com/x')).toBe(true);
  expect(mealimeLink('https://notmealime.com/x')).toBe(false);
  expect(siteOf('https://www.Cook.example/a')).toBe('cook.example');
  expect(siteOf('not a link')).toBe('');
});
