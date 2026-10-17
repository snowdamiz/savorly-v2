/// <reference types="jest" />
type Kit = {
  welcome: typeof import('../welcome');
  storage: typeof import('@react-native-async-storage/async-storage').default;
  React: typeof import('react');
  renderer: typeof import('react-test-renderer');
};
// The welcome state is read from storage when the module loads, as on a cold start. React, the
// renderer and the storage mock come from the same fresh registry so hooks see one React.
async function launch(stored: string | null): Promise<Kit> {
  let kit!: Kit;
  jest.isolateModules(() => {
    const mock = require('@react-native-async-storage/async-storage');
    const storage = mock.default ?? mock;
    if (stored !== null) void storage.setItem('savorly.welcomed', stored);
    kit = {
      storage,
      welcome: require('../welcome'),
      React: require('react'),
      renderer: require('react-test-renderer'),
    };
  });
  await kit.renderer.act(async () => {});
  return kit;
}
function watchPending({ welcome, React, renderer }: Kit) {
  const seen: boolean[] = [];
  function Probe() {
    seen.push(welcome.useWelcomePending());
    return null;
  }
  renderer.act(() => {
    renderer.create(React.createElement(Probe));
  });
  return seen;
}

test('a first launch shows the welcome until it is finished', async () => {
  const kit = await launch(null);
  const seen = watchPending(kit);
  expect(seen.at(-1)).toBe(true);
  await kit.renderer.act(async () => kit.welcome.finishWelcome());
  expect(seen.at(-1)).toBe(false);
  await expect(kit.storage.getItem('savorly.welcomed')).resolves.toBe('1');
});

test('a device that was welcomed before goes straight in', async () => {
  expect(watchPending(await launch('1')).at(-1)).toBe(false);
});

test('replaying shows it again and forgets the stored answer', async () => {
  const kit = await launch('1');
  const seen = watchPending(kit);
  await kit.renderer.act(async () => kit.welcome.replayWelcome());
  expect(seen.at(-1)).toBe(true);
  await expect(kit.storage.getItem('savorly.welcomed')).resolves.toBeNull();
});
