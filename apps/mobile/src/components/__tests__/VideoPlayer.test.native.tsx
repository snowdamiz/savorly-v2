/// <reference types="jest" />
import React from 'react';
import { Platform } from 'react-native';
import { act, create, ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { I18nProvider } from '../../lib/i18n';
import { motionReduced } from '../ui';
import { StepClip, StepVideo } from '../VideoPlayer';

// expo-video's native player as the clips use it: its settings, play and pause, and the
// playingChange event useEvent listens to. Each player made is kept, to see how many there are.
type Player = {
  uri: string;
  loop: boolean;
  muted: boolean;
  audioMixingMode: string;
  play: jest.Mock;
  pause: jest.Mock;
};
type MockListener = (state: { isPlaying: boolean }) => void;
jest.mock('expo-video', () => {
  const { createElement, useState } = jest.requireActual<typeof import('react')>('react');
  const made: object[] = [];
  const fake = (uri: string) => {
    const listeners = new Set<MockListener>();
    const player = {
      uri,
      loop: false,
      muted: false,
      audioMixingMode: 'auto',
      playing: false,
      play: jest.fn(() => set(true)),
      pause: jest.fn(() => set(false)),
      addListener: (_: string, listener: MockListener) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
    };
    const set = (playing: boolean) => {
      player.playing = playing;
      listeners.forEach((listener) => listener({ isPlaying: playing }));
    };
    return player;
  };
  return {
    made,
    useVideoPlayer: (uri: string, setup?: (player: object) => void) =>
      useState(() => {
        const player = fake(uri);
        setup?.(player);
        made.push(player);
        return player;
      })[0],
    VideoView: (props: object) => createElement('VideoView', props),
  };
});
// Only the reduced-motion setting is needed from the shared UI.
jest.mock('../ui', () => ({ motionReduced: jest.fn(() => false) }));
const players = (jest.requireMock('expo-video') as { made: Player[] }).made;

beforeEach(() => {
  players.length = 0;
});

async function render(element: React.ReactElement) {
  let tree!: ReactTestRenderer;
  await act(async () => {
    tree = create(<I18nProvider fallback={null}>{element}</I18nProvider>);
  });
  return tree;
}
const isHost = (node: ReactTestInstance) => typeof node.type === 'string';
const labelled = (tree: ReactTestRenderer, label: string) =>
  tree.root.findAll(
    (n) => isHost(n) && (n.props.accessibilityLabel === label || n.props['aria-label'] === label),
  );
// A tap reaches the nearest onPress above the button's native view.
async function press(tree: ReactTestRenderer, label: string) {
  let node: ReactTestInstance | null = labelled(tree, label)[0] ?? null;
  while (node && typeof node.props.onPress !== 'function') node = node.parent;
  if (!node) throw new Error(`Nothing to press called “${label}”`);
  await act(async () => node!.props.onPress());
}
// The stand-in VideoView renders as a host element of that name.
const isVideo = (node: ReactTestInstance) => String(node.type) === 'VideoView';
const video = (tree: ReactTestRenderer) => tree.root.find(isVideo);

test('a clip on the recipe page gets its player once it’s played, with its controls and sound', async () => {
  const tree = await render(<StepVideo uri="https://media.test/fold.mp4" step={2} />);
  // Nothing loads for a clip nobody plays.
  expect(players).toHaveLength(0);
  expect(tree.root.findAll(isVideo)).toHaveLength(0);
  await press(tree, 'Play the clip of step 2');
  expect(players).toHaveLength(1);
  const [player] = players;
  expect(player).toMatchObject({ uri: 'https://media.test/fold.mp4', muted: false, loop: false });
  expect(player.play).toHaveBeenCalledTimes(1);
  expect(video(tree).props.nativeControls).toBe(true);
  expect(labelled(tree, 'Clip of step 2')).not.toHaveLength(0);
});

// A cooking-mode clip, playing: silent, so a step read aloud or the cook's music carries on, and
// looping; a tap pauses it and another plays it again.
async function playsSilentlyOnALoop(tree: ReactTestRenderer, step: number) {
  expect(players).toHaveLength(1);
  const [player] = players;
  expect(player).toMatchObject({ muted: true, loop: true, audioMixingMode: 'mixWithOthers' });
  expect(player.play).toHaveBeenCalledTimes(1);
  expect(video(tree).props.nativeControls).toBe(false);
  await press(tree, `Pause the clip of step ${step}`);
  expect(player.pause).toHaveBeenCalledTimes(1);
  await press(tree, `Play the clip of step ${step}`);
  expect(player.play).toHaveBeenCalledTimes(2);
}

if (Platform.OS === 'ios') {
  test('on an iPhone a clip in cooking mode waits for a tap, leaving a voice chat its microphone', async () => {
    const tree = await render(<StepClip uri="https://media.test/stir.mp4" step={1} autoPlay />);
    expect(players).toHaveLength(0);
    await press(tree, 'Play the clip of step 1');
    await playsSilentlyOnALoop(tree, 1);
  });
} else {
  test('a clip in cooking mode plays by itself, silent and looping, and a tap pauses it', async () => {
    const tree = await render(<StepClip uri="https://media.test/stir.mp4" step={1} autoPlay />);
    await playsSilentlyOnALoop(tree, 1);
  });

  test('asking the device for less motion keeps a clip still until it’s tapped', async () => {
    jest.mocked(motionReduced).mockReturnValueOnce(true);
    const tree = await render(<StepClip uri="https://media.test/stir.mp4" step={3} autoPlay />);
    expect(players).toHaveLength(0);
    await press(tree, 'Play the clip of step 3');
    await playsSilentlyOnALoop(tree, 3);
  });
}

test('a clip in the editor waits for a tap before it loads', async () => {
  const tree = await render(<StepClip uri="https://media.test/plate.mp4" step={4} fit="cover" />);
  expect(players).toHaveLength(0);
  await press(tree, 'Play the clip of step 4');
  expect(players).toHaveLength(1);
  expect(players[0]).toMatchObject({ muted: true, loop: true });
  expect(players[0].play).toHaveBeenCalledTimes(1);
  expect(video(tree).props.contentFit).toBe('cover');
});
