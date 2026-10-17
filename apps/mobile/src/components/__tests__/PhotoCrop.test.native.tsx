/// <reference types="jest" />
// Gesture Handler's own stand-in for its native module, which GestureHandlerRootView installs.
import 'react-native-gesture-handler/jestSetup';
import React from 'react';
import { Modal } from 'react-native';
import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { ComposedGesture, GestureDetector, PanGesture, State } from 'react-native-gesture-handler';
import { fireGestureHandler } from 'react-native-gesture-handler/jest-utils';
import { I18nProvider } from '../../lib/i18n';
import type { Crop, Photo } from '../../lib/photos';
import { PhotoCrop } from '../PhotoCrop';

// The crop pads itself by the safe area; the package's own mock has no provider to need.
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);

const landscape: Photo = { uri: 'file:///landscape.jpg', width: 3000, height: 2000 };
const portrait: Photo = { uri: 'file:///portrait.jpg', width: 1200, height: 1600 };

async function render(photo: Photo | null) {
  const onDone = jest.fn<void, [Crop]>();
  const onCancel = jest.fn();
  const crop = (shown: Photo | null) => (
    <I18nProvider fallback={null}>
      <PhotoCrop photo={shown} onCancel={onCancel} onDone={onDone} />
    </I18nProvider>
  );
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(crop(photo));
  });
  const area = () =>
    tree.root.find((node) => isHost(node) && node.props.accessibilityRole === 'adjustable');
  return {
    tree,
    onDone,
    onCancel,
    show: (shown: Photo | null) => act(async () => tree.update(crop(shown))),
    /** The crop area's size on screen; the circle is 40 points narrower, up to 420. */
    measure: (width: number, height: number) =>
      act(async () =>
        area().props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height } } }),
      ),
    /** Screen readers' adjustable actions, which zoom by a step. */
    zoom: (action: 'increment' | 'decrement', times = 1) =>
      act(async () => {
        for (let i = 0; i < times; i++)
          area().props.onAccessibilityAction({ nativeEvent: { actionName: action } });
      }),
    /** One finger dragged this far and lifted. */
    drag: (translationX: number, translationY: number) => {
      const gesture = tree.root.findByType(GestureDetector).props.gesture as ComposedGesture;
      const pan = gesture.toGestureArray().find((g) => g.handlerName === 'PanGestureHandler')!;
      return act(async () =>
        fireGestureHandler<PanGesture>(pan, [
          { state: State.BEGAN },
          { state: State.ACTIVE },
          { state: State.ACTIVE, translationX, translationY },
          { state: State.END },
        ]),
      );
    },
    /** Presses Finish and returns the square it cut, if any. */
    finish: async () => {
      onDone.mockClear();
      await press(tree, 'Finish crop');
      return onDone.mock.calls[0]?.[0];
    },
  };
}
const isHost = (node: ReactTestInstance) => typeof node.type === 'string';
// A tap reaches the nearest onPress above the button's native view.
async function press(tree: ReactTestRenderer, label: string) {
  let node: ReactTestInstance | null = tree.root.find(
    (n) => isHost(n) && n.props.accessibilityLabel === label,
  );
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  await act(async () => node!.props.onPress());
}
// Every cut is a square inside the photo.
function expectInside(crop: Crop | undefined, photo: Photo) {
  expect(crop).toBeDefined();
  const { originX, originY, width, height } = crop!;
  expect(width).toBe(height);
  expect(Math.min(originX, originY)).toBeGreaterThanOrEqual(0);
  expect(originX + width).toBeLessThanOrEqual(photo.width);
  expect(originY + height).toBeLessThanOrEqual(photo.height);
}

test('the crop is open only while it has a photo', async () => {
  const crop = await render(null);
  expect(crop.tree.toJSON()).toBeNull();
  await crop.show(landscape);
  expect(crop.tree.root.findByType(Modal).props.visible).toBe(true);
  await crop.show(null);
  expect(crop.tree.toJSON()).toBeNull();
});

test('finishing straight away cuts the middle square, the whole short side', async () => {
  const wide = await render(landscape);
  await wide.measure(400, 800);
  expect(await wide.finish()).toEqual({ originX: 500, originY: 0, width: 2000, height: 2000 });
  const tall = await render(portrait);
  await tall.measure(400, 800);
  expect(await tall.finish()).toEqual({ originX: 0, originY: 200, width: 1200, height: 1200 });
});

test('nothing is cut before the crop area has a size', async () => {
  const crop = await render(landscape);
  expect(await crop.finish()).toBeUndefined();
});

test('zooming stops at four times the filled circle', async () => {
  const crop = await render(landscape);
  await crop.measure(400, 800);
  await crop.zoom('increment');
  expect(await crop.finish()).toEqual({ originX: 700, originY: 200, width: 1600, height: 1600 });
  await crop.zoom('increment', 20);
  expect(await crop.finish()).toEqual({ originX: 1250, originY: 750, width: 500, height: 500 });
  // Zooming out stops where the photo still fills the circle.
  await crop.zoom('decrement', 20);
  expect(await crop.finish()).toEqual({ originX: 500, originY: 0, width: 2000, height: 2000 });
});

test('zooming keeps the same point of the photo in the middle of the circle', async () => {
  const middle = ({ originX, originY, width, height }: Crop) => [
    originX + width / 2,
    originY + height / 2,
  ];
  const crop = await render(landscape);
  await crop.measure(400, 800);
  await crop.drag(50, 0);
  const before = await crop.finish();
  expect(before).toEqual({ originX: 222, originY: 0, width: 2000, height: 2000 });
  await crop.zoom('increment');
  const after = await crop.finish();
  expect(after).toEqual({ originX: 422, originY: 200, width: 1600, height: 1600 });
  expect(middle(after!)).toEqual(middle(before!));
});

test('dragging stops at the photo’s edges, whatever the zoom or screen size', async () => {
  const crop = await render(landscape);
  await crop.measure(400, 800);
  await crop.drag(5000, 5000);
  // The photo moved right as far as it goes, so the circle holds its left edge.
  expect(await crop.finish()).toEqual({ originX: 0, originY: 0, width: 2000, height: 2000 });
  await crop.drag(-10000, -10000);
  expect(await crop.finish()).toEqual({ originX: 1000, originY: 0, width: 2000, height: 2000 });
  await crop.zoom('increment', 10);
  await crop.drag(-10000, -10000);
  expect(await crop.finish()).toEqual({ originX: 2500, originY: 1500, width: 500, height: 500 });
  await crop.drag(10000, 10000);
  expect(await crop.finish()).toEqual({ originX: 0, originY: 0, width: 500, height: 500 });
  // A smaller window (a rotated or split-screen tablet) keeps the same corner in the circle.
  await crop.drag(-10000, 0);
  await crop.measure(300, 500);
  expect(await crop.finish()).toEqual({ originX: 2500, originY: 0, width: 500, height: 500 });
});

test('every cut is a square inside the photo, at any zoom and position', async () => {
  const odd: Photo = { uri: 'file:///odd.jpg', width: 4031, height: 3023 };
  const crop = await render(odd);
  await crop.measure(393, 659);
  const moves: [steps: number, x: number, y: number][] = [
    [0, 37.5, -12.25],
    [1, -611, 87.7],
    [2, 9999, 9999],
    [5, -123.4, 55.5],
    [-3, 0.4, -0.6],
    [-9, -9999, 3],
  ];
  for (const [steps, x, y] of moves) {
    await crop.zoom(steps < 0 ? 'decrement' : 'increment', Math.abs(steps));
    await crop.drag(x, y);
    expectInside(await crop.finish(), odd);
  }
});

test('a new photo starts centered and whole again', async () => {
  const crop = await render(landscape);
  await crop.measure(400, 800);
  await crop.zoom('increment', 3);
  await crop.drag(800, -300);
  await crop.show(portrait);
  expect(await crop.finish()).toEqual({ originX: 0, originY: 200, width: 1200, height: 1200 });
});

test('the close button and Android’s back button cancel without cutting', async () => {
  const crop = await render(landscape);
  await crop.measure(400, 800);
  await press(crop.tree, 'Cancel crop');
  expect(crop.onCancel).toHaveBeenCalledTimes(1);
  await act(async () => crop.tree.root.findByType(Modal).props.onRequestClose());
  expect(crop.onCancel).toHaveBeenCalledTimes(2);
  expect(crop.onDone).not.toHaveBeenCalled();
});
