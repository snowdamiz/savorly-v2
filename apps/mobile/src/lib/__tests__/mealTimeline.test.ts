/// <reference types="jest" />
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  canStart,
  currentItem,
  defaultEatAt,
  dishDone,
  fallBehind,
  finishItem,
  keepKitchen,
  localTime,
  mealItems,
  nextItem,
  plannedAt,
  savedKitchen,
  settleTimers,
  startRun,
  timerLeft,
  toggleTimer,
  undoItem,
  type MealTimeline,
  type TimelineStep,
} from '../mealTimeline';

const at = (minutes: number) =>
  new Date(Date.UTC(2026, 9, 17, 18, 0) + minutes * 60_000).toISOString();
const step = (
  recipeId: string,
  n: number,
  start: number,
  end: number,
  fields: Partial<TimelineStep> = {},
): TimelineStep => ({
  recipeId,
  step: n,
  title: `${recipeId} ${n}`,
  startAt: at(start),
  endAt: at(end),
  active: (end - start) * 60,
  wait: 0,
  oven: 0,
  burners: 0,
  preheat: false,
  estimated: false,
  tested: false,
  ...fields,
});
// A roast with its preheat, and potatoes that boil while it roasts.
const plan: MealTimeline = {
  eatAt: at(90),
  startAt: at(0),
  kitchen: { burners: 4, ovens: 1 },
  dishes: [
    {
      recipeId: 'roast',
      title: 'Roast',
      image: '',
      startAt: at(0),
      readyAt: at(90),
      estimated: true,
      tested: false,
    },
    {
      recipeId: 'potatoes',
      title: 'Potatoes',
      image: '',
      startAt: at(20),
      readyAt: at(90),
      estimated: false,
      tested: false,
    },
  ],
  steps: [
    step('roast', 2, 0, 10),
    step('roast', 1, 5, 20, { active: 0, oven: 220, preheat: true }),
    step('roast', 3, 20, 80, { active: 60, wait: 3540, oven: 220 }),
    step('potatoes', 1, 30, 45),
    step('potatoes', 2, 45, 65, { active: 60, wait: 1140, burners: 1 }),
    step('roast', 4, 80, 90),
    step('potatoes', 3, 85, 90),
  ],
  free: [],
  warnings: [],
};

test('a meal is cooked step by step across its dishes, waiting parts running on their own', () => {
  const items = mealItems(plan);
  // The preheat heats for its quarter hour once it's switched on.
  expect(items.find((i) => i.key === 'roast:1')).toMatchObject({ preheat: true, wait: 900 });
  let run = startRun();
  const t0 = Date.parse(at(0));
  // Seasoning first: its preheat doesn't hold it up.
  expect(currentItem(items, run)?.key).toBe('roast:2');
  run = finishItem(run, currentItem(items, run)!, t0 + 10 * 60_000);
  expect(currentItem(items, run)?.key).toBe('roast:1');
  // The roast waits for the oven to be on, not for it to be hot.
  expect(
    canStart(
      items,
      run,
      items.find((i) => i.key === 'roast:3')!,
    ),
  ).toBe(false);
  run = finishItem(run, currentItem(items, run)!, t0 + 10 * 60_000);
  expect(Object.keys(run.timers)).toEqual(['roast:1']);
  expect(currentItem(items, run)?.key).toBe('roast:3');
  // In it goes: the roast's hour runs while the potatoes are peeled and boiled.
  run = finishItem(run, currentItem(items, run)!, t0 + 20 * 60_000);
  expect(timerLeft(run.timers['roast:3'], t0 + 20 * 60_000)).toBe(3540);
  expect(currentItem(items, run)?.key).toBe('potatoes:1');
  expect(nextItem(items, run, currentItem(items, run))?.key).toBe('potatoes:2');
  run = finishItem(run, currentItem(items, run)!, t0 + 45 * 60_000);
  expect(dishDone(items, run, 'potatoes')).toBe(false);
  run = finishItem(run, currentItem(items, run)!, t0 + 46 * 60_000);
  // Nothing to do until a timer ends.
  expect(currentItem(items, run)).toBeNull();
  expect(nextItem(items, run, null)?.key).toBe('roast:4');
  // Paused, a timer keeps what's left; run on, it ends that much later.
  run = toggleTimer(run, 'potatoes:2', t0 + 50 * 60_000);
  expect(timerLeft(run.timers['potatoes:2'], t0 + 60 * 60_000)).toBe(900);
  run = toggleTimer(run, 'potatoes:2', t0 + 60 * 60_000);
  const settled = settleTimers(run, t0 + 81 * 60_000);
  expect(settled.ended.sort()).toEqual(['potatoes:2', 'roast:1', 'roast:3']);
  run = settled.run;
  expect(currentItem(items, run)?.key).toBe('roast:4');
  run = finishItem(run, currentItem(items, run)!, t0 + 85 * 60_000);
  run = finishItem(run, currentItem(items, run)!, t0 + 90 * 60_000);
  expect(run.done).toHaveLength(items.length);
  expect(dishDone(items, run, 'roast') && dishDone(items, run, 'potatoes')).toBe(true);
});

test('Back takes the last step finished back, timer and all', () => {
  const items = mealItems(plan);
  const t0 = Date.parse(at(0));
  let run = finishItem(startRun(), items[0], t0);
  run = finishItem(run, items[1], t0);
  expect(run.timers['roast:1']).toBeDefined();
  run = undoItem(run);
  expect(run.timers['roast:1']).toBeUndefined();
  expect(currentItem(items, run)?.key).toBe('roast:1');
  run = undoItem(undoItem(run));
  expect(run).toEqual(startRun());
});

test('“I’m behind” moves what is left later, by at least 5 minutes', () => {
  const items = mealItems(plan);
  const first = items[0];
  // Twelve minutes late for the first step: everything moves twelve minutes.
  let run = fallBehind(items, startRun(), first.start + 12 * 60_000);
  expect(plannedAt(first, run)).toBe(first.start + 12 * 60_000);
  // On time, or early, it's five.
  run = fallBehind(items, run, first.start);
  expect(run.shift).toBe(17 * 60_000);
});

test('a meal is eaten at the usual hour of its latest meal, unless that is too soon', () => {
  const morning = new Date(2026, 9, 17, 9, 0);
  expect(defaultEatAt(null, [], morning)).toEqual(new Date(2026, 9, 17, 19, 0));
  expect(defaultEatAt('2026-10-18', ['Breakfast', 'Lunch'], morning)).toEqual(
    new Date(2026, 9, 18, 12, 30),
  );
  // At 6:40 pm dinner at 7 is too soon: an hour and a half from now, on a quarter hour.
  expect(defaultEatAt(null, ['Dinner'], new Date(2026, 9, 17, 18, 40))).toEqual(
    new Date(2026, 9, 17, 20, 15),
  );
  expect(localTime(new Date(2026, 0, 5, 7, 5))).toBe('2026-01-05T07:05');
});

test('the kitchen planned for is kept on the device, and anything odd is the usual one', async () => {
  expect(await savedKitchen()).toEqual({ burners: 4, ovens: 1 });
  keepKitchen({ burners: 2, ovens: 2 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(await savedKitchen()).toEqual({ burners: 2, ovens: 2 });
  await AsyncStorage.setItem('savorly.kitchen', JSON.stringify({ burners: 40, ovens: 1 }));
  expect(await savedKitchen()).toEqual({ burners: 4, ovens: 1 });
});
