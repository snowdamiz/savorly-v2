/// <reference types="jest" />
import {
  EQUIPMENT_MAX,
  byImportance,
  cleanEquipment,
  moved,
  shownEquipment,
  stepEquipment,
  withSuggestions,
} from '../equipment';

const names: Record<string, string> = { pot: 'Pot', colander: 'Colander', oven: 'Oven' };
const name = (key: string) => names[key] ?? '';

test('a list is kept as the API keeps it: trimmed, without blanks or repeats, at most 20', () => {
  expect(cleanEquipment([' Large pot ', '', 'large POT', 'Colander', '  '])).toEqual([
    'Large pot',
    'Colander',
  ]);
  const many = Array.from({ length: 25 }, (_, i) => `Tool ${i}`);
  expect(cleanEquipment(many)).toHaveLength(EQUIPMENT_MAX);
});

test('the cook’s own list comes first, and never mixes with what the method mentions', () => {
  expect(
    shownEquipment({ equipment: ['Large pot', ''], equipmentDetected: ['pot', 'oven'] }, name),
  ).toMatchObject({ names: ['Large pot'], detected: false, guessed: false });
  // Without one, what the method mentions, by its names in the reader's language.
  expect(shownEquipment({ equipment: [], equipmentDetected: ['pot', 'oven'] }, name)).toMatchObject(
    {
      names: ['Pot', 'Oven'],
      detected: true,
      guessed: false,
    },
  );
  // A key this version of the app doesn't know yet is left out.
  expect(
    shownEquipment({ equipmentDetected: ['sous vide circulator', 'colander'] }, name),
  ).toMatchObject({ names: ['Colander'], detected: true, guessed: false });
  // An older server says nothing, and nothing shows.
  expect(shownEquipment({}, name)).toMatchObject({ names: [], detected: false, guessed: false });
  expect(shownEquipment({ equipmentDetected: ['sous vide circulator'] }, name)).toMatchObject({
    names: [],
    detected: false,
    guessed: false,
  });
});

test('without a list, the sous-chef’s guess comes before what the method mentions', () => {
  const recipe = {
    equipment: [],
    equipmentDetected: ['colander'],
    equipmentGuess: [
      { key: 'pot', steps: [2, 3] },
      { key: 'sous vide circulator', steps: [1] },
      { key: 'colander', steps: [2] },
    ],
  };
  expect(shownEquipment(recipe, name)).toMatchObject({
    names: ['Pot', 'Colander'],
    detected: true,
    guessed: true,
  });
  // Each step names what it uses, and a key the app doesn't know is left out.
  expect(stepEquipment(recipe, 0, name)).toEqual([]);
  expect(stepEquipment(recipe, 1, name)).toEqual(['Pot', 'Colander']);
  expect(stepEquipment(recipe, 2, name)).toEqual(['Pot']);
  // The cook's own list wins, and says nothing of steps.
  const listed = { ...recipe, equipment: ['Large pot'] };
  expect(shownEquipment(listed, name).names).toEqual(['Large pot']);
  expect(stepEquipment(listed, 1, name)).toEqual([]);
  // Before the model has guessed, what the method mentions.
  expect(shownEquipment({ ...recipe, equipmentGuess: [] }, name)).toMatchObject({
    names: ['Colander'],
    detected: true,
    guessed: false,
  });
});

test('each tool carries what it names, for its icon', () => {
  // The cook's names keep what the server read in each, one for one, through cleaning.
  expect(
    shownEquipment(
      {
        equipment: ['Large pot', 'large POT', 'Wooden spoon', 'A good apron'],
        equipmentKinds: ['pot', 'pot', 'spoon', ''],
      },
      name,
    ).tools,
  ).toEqual([
    { name: 'Large pot', kind: 'pot' },
    { name: 'Wooden spoon', kind: 'spoon' },
    { name: 'A good apron', kind: '' },
  ]);
  // From an older server, without kinds: every tool draws the utensils.
  expect(shownEquipment({ equipment: ['Wok'] }, name).tools).toEqual([{ name: 'Wok', kind: '' }]);
  // What the method mentions, or the guess, is its own key.
  expect(shownEquipment({ equipmentDetected: ['pot', 'oven'] }, name).tools).toEqual([
    { name: 'Pot', kind: 'pot' },
    { name: 'Oven', kind: 'oven' },
  ]);
});

test('what a kitchen may not have comes first, everyday tools last', () => {
  const tool = (name: string, kind: string) => ({ name, kind });
  const cookies = [
    tool('Saucepan', 'saucepan'),
    tool('Mixing bowl', 'bowl'),
    tool('Oven', 'oven'),
    tool('2 baking trays', 'sheet pan'),
    tool('Pasta machine', ''),
    tool('Springform tin', 'cake pan'),
  ];
  expect(byImportance(cookies).map((t) => t.name)).toEqual([
    'Oven',
    'Pasta machine',
    'Springform tin',
    'Saucepan',
    '2 baking trays',
    'Mixing bowl',
  ]);
  // Among equals, the list's own order; a list from an older server, without kinds, stays as is.
  const plain = [tool('B', ''), tool('A', ''), tool('C', '')];
  expect(byImportance(plain)).toEqual(plain);
});

test('the guess carries the steps that use each tool', () => {
  expect(shownEquipment({ equipmentGuess: [{ key: 'pot', steps: [2, 3] }] }, name).tools).toEqual([
    { name: 'Pot', kind: 'pot', steps: [2, 3] },
  ]);
});

test('suggestions join the end of the list, without what it already has', () => {
  expect(withSuggestions(['Large pot', 'colander'], ['Pot', 'Colander', 'Oven', 'oven'])).toEqual({
    equipment: ['Large pot', 'colander', 'Pot', 'Oven'],
    added: 2,
  });
  expect(withSuggestions(['Oven'], ['Oven'])).toEqual({ equipment: ['Oven'], added: 0 });
  const full = Array.from({ length: EQUIPMENT_MAX - 1 }, (_, i) => `Tool ${i}`);
  expect(withSuggestions(full, ['Pot', 'Oven'])).toEqual({
    equipment: [...full, 'Pot'],
    added: 1,
  });
});

test('an item moves up and down inside the list', () => {
  expect(moved(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  expect(moved(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
  expect(moved(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
  expect(moved(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
});
