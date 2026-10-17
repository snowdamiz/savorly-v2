/// <reference types="jest" />
import { foodConflicts, foodKey, joinNames, noFood, pantryLines } from '../food';
import type { Avoid, Recipe } from '../types';

const recipe = (fields: Partial<Recipe>): Recipe =>
  ({
    id: 'satay',
    title: 'Chicken satay',
    ingredients: [
      { name: 'Chicken thighs', amount: 500, unit: 'g', category: '' },
      { name: 'Peanut butter', amount: 3, unit: 'tbsp', category: '' },
      { name: 'Fresh cilantro', amount: 0, unit: '', category: '' },
    ],
    ingredientFood: [
      { key: 'chicken', allergens: ['poultry'], terms: ['chicken', 'chicken thigh'] },
      { key: 'peanut butter', allergens: ['peanut'], terms: ['peanut', 'peanut butter'] },
      { key: 'cilantro', allergens: [], terms: ['cilantro'] },
    ],
    allergens: ['peanut', 'poultry'],
    ...fields,
  }) as Recipe;

const avoid: Avoid = {
  groups: { peanut: ['Peanuts'], poultry: ['Vegetarian'], meat: ['Vegetarian'] },
  terms: { cilantro: ['coriander'] },
};

describe('what a recipe has that its reader avoids', () => {
  test('groups and the reader’s own words, with the lines that have them', () => {
    expect(foodConflicts(recipe({}), avoid)).toEqual([
      { group: 'poultry', from: [{ what: 'Vegetarian' }], ingredients: [0] },
      { group: 'peanut', from: [{ what: 'Peanuts' }], ingredients: [1] },
      { term: 'cilantro', from: [{ what: 'coriander' }], ingredients: [2] },
    ]);
  });
  test('housemates who share theirs add their reasons, by name', () => {
    const ben = { name: 'Ben', avoid: { groups: { peanut: ['Peanuts'] }, terms: {} } };
    expect(foodConflicts(recipe({}), null, [ben])).toEqual([
      { group: 'peanut', from: [{ what: 'Peanuts', who: 'Ben' }], ingredients: [1] },
    ]);
    expect(foodConflicts(recipe({}), avoid, [ben])[1]).toEqual({
      group: 'peanut',
      from: [{ what: 'Peanuts' }, { what: 'Peanuts', who: 'Ben' }],
      ingredients: [1],
    });
  });
  test('nothing for a guest, or a reader who avoids nothing here', () => {
    expect(foodConflicts(recipe({}), null)).toEqual([]);
    expect(foodConflicts(recipe({}), { groups: { pork: ['Halal'] }, terms: {} })).toEqual([]);
  });
  test('older recipes without ingredient facts conflict by their groups, with no lines', () => {
    expect(foodConflicts(recipe({ ingredientFood: undefined }), avoid)).toEqual([
      { group: 'peanut', from: [{ what: 'Peanuts' }], ingredients: [] },
      { group: 'poultry', from: [{ what: 'Vegetarian' }], ingredients: [] },
    ]);
    // Facts that don't line up with the ingredients (an edit not yet indexed) aren't trusted.
    const shorter = recipe({}).ingredientFood!.slice(0, 2);
    expect(foodConflicts(recipe({ ingredientFood: shorter }), avoid)).toHaveLength(2);
  });
});

describe('the pantry and names', () => {
  test('lines the pantry covers, by key', () => {
    expect(pantryLines(recipe({}), ['chicken', 'onion'])).toEqual([true, false, false]);
    expect(pantryLines(recipe({}), [])).toEqual([false, false, false]);
    expect(pantryLines(recipe({ ingredientFood: undefined }), ['chicken'])).toEqual([
      false,
      false,
      false,
    ]);
  });
  test('lists join the way each language writes them', () => {
    expect(joinNames(['Eggs', '', 'Butter'], 'en')).toBe('Eggs, Butter');
    expect(joinNames(['卵', 'バター'], 'ja')).toBe('卵、バター');
  });
  test('the same food state has the same key', () => {
    const a = { avoid, household: [], diets: ['Vegetarian'], pantryCover: ['egg'] };
    expect(foodKey(a)).toBe(foodKey(JSON.parse(JSON.stringify(a))));
    expect(foodKey(a)).not.toBe(foodKey(noFood));
  });
});
