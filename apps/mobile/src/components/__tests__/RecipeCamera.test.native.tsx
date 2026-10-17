/// <reference types="jest" />
import React from 'react';
import { ActivityIndicator, AppState, AppStateStatus, Linking, Text } from 'react-native';
import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { CameraView } from 'expo-camera';
import { I18nProvider } from '../../lib/i18n';
import { RecipeCamera } from '../RecipeCamera';
import { FoodImage } from '../ui';

// What the component reads of a camera permission; null until it's known.
type Permission = { granted: boolean; canAskAgain: boolean } | null;
let mockPermission: Permission = null;
const mockRequestPermission = jest.fn<Promise<Permission>, []>();
const mockGetPermission = jest.fn<Promise<Permission>, []>();
const mockTakePicture = jest.fn<Promise<{ uri: string } | undefined>, [object]>();
jest.mock('expo-camera', () => {
  const { createElement, forwardRef, useImperativeHandle, useState } = require('react');
  const { View } = require('react-native');
  return {
    // Like Expo's hook: the permission so far, then a request and a fresh read that update it.
    useCameraPermissions() {
      const [permission, setPermission] = useState(mockPermission);
      const updating = (read: () => Promise<unknown>) => () =>
        read().then((next) => {
          setPermission(next);
          return next;
        });
      return [permission, updating(mockRequestPermission), updating(mockGetPermission)];
    },
    // The native preview; its ref is what the component takes pictures with.
    CameraView: forwardRef(function CameraView(_: object, ref: unknown) {
      useImperativeHandle(ref, () => ({ takePictureAsync: mockTakePicture }));
      return createElement(View);
    }),
  };
});

const granted = { granted: true, canAskAgain: true };
const undetermined = { granted: false, canAskAgain: true };
const denied = { granted: false, canAskAgain: false };
const notReady = () =>
  Object.assign(new Error('Camera is not ready yet'), { code: 'ERR_CAMERA_NOT_READY' });

async function render() {
  const onPhoto = jest.fn<void, [string]>();
  const onCancel = jest.fn();
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(
      <I18nProvider fallback={null}>
        <RecipeCamera onPhoto={onPhoto} onCancel={onCancel} />
      </I18nProvider>,
    );
  });
  return { tree, onPhoto, onCancel };
}
const isHost = (node: ReactTestInstance) => typeof node.type === 'string';
const button = (tree: ReactTestRenderer, label: string) =>
  tree.root.find((node) => isHost(node) && node.props.accessibilityLabel === label);
const buttons = (tree: ReactTestRenderer) =>
  tree.root
    .findAll((node) => isHost(node) && node.props.accessibilityRole === 'button')
    .map((node) => node.props.accessibilityLabel as string);
const enabled = (tree: ReactTestRenderer, label: string) =>
  !button(tree, label).props.accessibilityState?.disabled;
// A tap reaches the nearest onPress above the button's native view, and a disabled one takes none.
async function press(tree: ReactTestRenderer, label: string) {
  if (!enabled(tree, label)) throw new Error(`“${label}” is disabled`);
  let node: ReactTestInstance | null = button(tree, label);
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  await act(async () => node!.props.onPress());
}
const texts = (tree: ReactTestRenderer) =>
  tree.root.findAllByType(Text).map((node) => node.props.children as string);
const alerts = (tree: ReactTestRenderer) =>
  tree.root
    .findAllByType(Text)
    .filter((node) => node.props.accessibilityRole === 'alert')
    .map((node) => node.props.children as string);
const camera = (tree: ReactTestRenderer) => tree.root.findAllByType(CameraView)[0];
// The frame is sized from its measured width; the camera mounts once it has one.
const measure = (tree: ReactTestRenderer, width = 343) =>
  act(async () =>
    tree.root
      .find((node) => isHost(node) && typeof node.props.onLayout === 'function')
      .props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 0 } } }),
  );
const cameraReady = (tree: ReactTestRenderer) =>
  act(async () => camera(tree).props.onCameraReady());
// The OS telling every listener, as it would, that Savorly left or came back to the screen.
const appState = (state: AppStateStatus) =>
  act(async () => {
    for (const [type, listener] of jest.mocked(AppState.addEventListener).mock.calls)
      if (type === 'change') listener(state);
  });
// Real timers: the component waits 100 ms between attempts on a camera that's still starting.
const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

async function openCamera() {
  mockPermission = granted;
  const kit = await render();
  await measure(kit.tree);
  await cameraReady(kit.tree);
  return kit;
}

beforeEach(() => {
  jest.mocked(Linking.openSettings).mockResolvedValue(undefined);
});

describe('camera permission', () => {
  test('nothing can be taken until the permission is known', async () => {
    mockPermission = null;
    const { tree, onCancel } = await render();
    expect(tree.root.findAllByType(ActivityIndicator)).toHaveLength(1);
    expect(camera(tree)).toBeUndefined();
    expect(enabled(tree, 'Take photo')).toBe(false);
    await press(tree, 'Back to conversation');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('asks first, suggests uploading if the request fails, and opens once allowed', async () => {
    mockPermission = undetermined;
    const { tree } = await render();
    expect(texts(tree)).toContain('Allow camera access to photograph your recipe.');
    expect(enabled(tree, 'Take photo')).toBe(false);
    mockRequestPermission.mockRejectedValueOnce(new Error('request failed'));
    await press(tree, 'Allow camera');
    expect(alerts(tree)).toEqual([
      'Camera permission wasn’t granted. You can upload a photo instead.',
    ]);
    mockRequestPermission.mockResolvedValueOnce(granted);
    await press(tree, 'Allow camera');
    expect(mockRequestPermission).toHaveBeenCalledTimes(2);
    expect(Linking.openSettings).not.toHaveBeenCalled();
    await measure(tree);
    expect(camera(tree).props).toMatchObject({ facing: 'back', mode: 'picture' });
  });

  test('once it can’t ask again, it opens Settings, or suggests uploading', async () => {
    mockPermission = denied;
    const { tree } = await render();
    expect(buttons(tree)).toContain('Open settings');
    await press(tree, 'Open settings');
    expect(Linking.openSettings).toHaveBeenCalledTimes(1);
    expect(mockRequestPermission).not.toHaveBeenCalled();
    expect(alerts(tree)).toEqual([]);
    jest.mocked(Linking.openSettings).mockRejectedValueOnce(new Error('no settings app'));
    await press(tree, 'Open settings');
    expect(alerts(tree)).toEqual([
      'Camera permission wasn’t granted. You can upload a photo instead.',
    ]);
  });

  // Expo's permission hook reads the permission once, when it mounts. iOS restarts an app whose
  // camera permission changes in Settings, but Android doesn't when it's granted, so the camera
  // reads it again when the app comes back.
  test('coming back from Settings with the camera allowed opens it (Android)', async () => {
    mockPermission = denied;
    const { tree } = await render();
    await press(tree, 'Open settings');
    await appState('background');
    mockGetPermission.mockResolvedValue(granted);
    await appState('active');
    expect(buttons(tree)).not.toContain('Open settings');
    await measure(tree);
    expect(camera(tree)).toBeDefined();
  });
});

describe('taking the photo', () => {
  test('waits for the camera, then shows the shot to use', async () => {
    mockPermission = granted;
    const { tree, onPhoto } = await render();
    await measure(tree);
    expect(enabled(tree, 'Take photo')).toBe(false);
    await cameraReady(tree);
    let develop!: (picture: { uri: string }) => void;
    mockTakePicture.mockReturnValueOnce(new Promise((resolve) => (develop = resolve)));
    await press(tree, 'Take photo');
    expect(mockTakePicture).toHaveBeenCalledWith({ quality: 0.9 });
    // One shot at a time.
    expect(button(tree, 'Take photo').props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });
    await act(async () => develop({ uri: 'file:///recipe.jpg' }));
    expect(camera(tree)).toBeUndefined();
    expect(tree.root.findByType(FoodImage).props.uri).toBe('file:///recipe.jpg');
    expect(buttons(tree)).toEqual([
      'Use this photo',
      'Retake recipe photo',
      'Back to conversation',
    ]);
    await press(tree, 'Use this photo');
    expect(onPhoto).toHaveBeenCalledWith('file:///recipe.jpg');
  });

  test('retaking goes back to the camera and sends the new shot instead', async () => {
    const { tree, onPhoto } = await openCamera();
    mockTakePicture.mockResolvedValueOnce({ uri: 'file:///blurry.jpg' });
    await press(tree, 'Take photo');
    await press(tree, 'Retake recipe photo');
    expect(tree.root.findAllByType(FoodImage)).toHaveLength(0);
    expect(camera(tree)).toBeDefined();
    expect(enabled(tree, 'Take photo')).toBe(false);
    await cameraReady(tree);
    mockTakePicture.mockResolvedValueOnce({ uri: 'file:///sharp.jpg' });
    await press(tree, 'Take photo');
    await press(tree, 'Use this photo');
    expect(onPhoto).toHaveBeenCalledTimes(1);
    expect(onPhoto).toHaveBeenCalledWith('file:///sharp.jpg');
  });

  test('a camera still starting up is tried again', async () => {
    const { tree } = await openCamera();
    mockTakePicture.mockRejectedValueOnce(notReady()).mockResolvedValueOnce({
      uri: 'file:///recipe.jpg',
    });
    await press(tree, 'Take photo');
    await wait(150);
    expect(mockTakePicture).toHaveBeenCalledTimes(2);
    expect(tree.root.findByType(FoodImage).props.uri).toBe('file:///recipe.jpg');
    expect(alerts(tree)).toEqual([]);
  });

  test('any other failure is reported at once, and the camera stays ready to retry', async () => {
    const { tree } = await openCamera();
    mockTakePicture.mockRejectedValueOnce(new Error('Camera is in use by another app'));
    await press(tree, 'Take photo');
    expect(mockTakePicture).toHaveBeenCalledTimes(1);
    expect(alerts(tree)).toEqual(['We couldn’t take that photo. Check your camera and try again.']);
    expect(camera(tree)).toBeDefined();
    expect(enabled(tree, 'Take photo')).toBe(true);
    // The next attempt clears the message.
    mockTakePicture.mockResolvedValueOnce({ uri: 'file:///recipe.jpg' });
    await press(tree, 'Take photo');
    expect(alerts(tree)).toEqual([]);
  });
});

describe('the camera itself', () => {
  test('switching turns the lens around and waits for it to start', async () => {
    const { tree } = await openCamera();
    await press(tree, 'Switch camera');
    expect(camera(tree).props.facing).toBe('front');
    expect(enabled(tree, 'Take photo')).toBe(false);
    await cameraReady(tree);
    expect(enabled(tree, 'Take photo')).toBe(true);
    await press(tree, 'Switch camera');
    expect(camera(tree).props.facing).toBe('back');
  });

  test('a camera that can’t start says so and points to uploading', async () => {
    mockPermission = granted;
    const { tree } = await render();
    await measure(tree);
    await act(async () => camera(tree).props.onMountError({ message: 'Camera unavailable' }));
    expect(alerts(tree)).toEqual([
      'No camera is available. Check permission or upload a photo instead.',
    ]);
    expect(enabled(tree, 'Take photo')).toBe(false);
  });

  // The error a failed start shows doesn't stay under a camera that starts after it (after
  // switching lenses, or coming back to the app).
  test('the error from a failed start goes once the camera starts', async () => {
    mockPermission = granted;
    const { tree } = await render();
    await measure(tree);
    await act(async () => camera(tree).props.onMountError({ message: 'Camera unavailable' }));
    await press(tree, 'Switch camera');
    await cameraReady(tree);
    expect(alerts(tree)).toEqual([]);
  });

  test('the camera is let go while Savorly is in the background', async () => {
    const { tree } = await openCamera();
    await appState('background');
    expect(camera(tree)).toBeUndefined();
    expect(texts(tree)).toContain('Camera paused while the app is in the background.');
    await appState('active');
    expect(camera(tree)).toBeDefined();
    expect(texts(tree)).not.toContain('Camera paused while the app is in the background.');
  });
});
