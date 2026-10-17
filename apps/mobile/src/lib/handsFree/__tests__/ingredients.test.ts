/// <reference types="jest" />
import { ingredientsOf, spokenIngredient, spokenList } from '../ingredients';

const ingredient = (name: string, amount = 1, unit = '') => ({
  name,
  amount,
  unit,
  category: 'Pantry',
});

test('a step names its ingredients by name or by a word of the name', () => {
  const ingredients = [
    ingredient('San Marzano tomatoes', 400, 'g'),
    ingredient('Eggs', 2),
    ingredient('Peas', 100, 'g'),
    ingredient('Olive oil', 2, 'tbsp'),
    ingredient('盐'),
  ];
  const named = (text: string) =>
    ingredientsOf({ title: '', text }, ingredients).map((item) => item.name);
  expect(named('Crush the tomatoes into the pan.')).toEqual(['San Marzano tomatoes']);
  expect(named('Beat the egg with a little olive oil.')).toEqual(['Eggs', 'Olive oil']);
  // "pea" inside another word isn't peas.
  expect(named('Repeat until it is smooth.')).toEqual([]);
  expect(named('加一点盐。')).toEqual(['盐']);
});

test('ingredients are read with their amounts as one list', () => {
  expect(spokenIngredient(ingredient('spaghetti', 200, 'g'), 'en-US')).toBe('200 g spaghetti');
  expect(spokenIngredient(ingredient('salt', 0, ''), 'en-US')).toBe('salt');
  expect(spokenIngredient(ingredient('Mehl', 1.5, 'kg'), 'de-DE')).toBe('1,5 kg Mehl');
  expect(spokenList(['a', 'b', 'c'], 'en-US')).toMatch(/^a, b,? and c$/);
});
