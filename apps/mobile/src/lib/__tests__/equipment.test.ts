/// <reference types="jest" />
import {
  EQUIPMENT_MAX,
  cleanEquipment,
  moved,
  shownEquipment,
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
  ).toEqual({ names: ['Large pot'], detected: false });
  // Without one, what the method mentions, by its names in the reader's language.
  expect(shownEquipment({ equipment: [], equipmentDetected: ['pot', 'oven'] }, name)).toEqual({
    names: ['Pot', 'Oven'],
    detected: true,
  });
  // A key this version of the app doesn't know yet is left out.
  expect(shownEquipment({ equipmentDetected: ['sous vide circulator', 'colander'] }, name)).toEqual(
    { names: ['Colander'], detected: true },
  );
  // An older server says nothing, and nothing shows.
  expect(shownEquipment({}, name)).toEqual({ names: [], detected: false });
  expect(shownEquipment({ equipmentDetected: ['sous vide circulator'] }, name)).toEqual({
    names: [],
    detected: false,
  });
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
