/// <reference types="jest" />
import { clipFor, stepsWithoutClips } from '../stepClips';
import type { RecipeStep, StepClipJob } from '../types';

const step = (text: string, video?: string): RecipeStep => ({
  title: 'Step',
  text,
  seconds: 0,
  ...(video === undefined ? {} : { video }),
});

test('a clip is made for each step without one, once per text', () => {
  const steps = [
    step('Toast the bread.', 'https://media.test/toast.mp4'),
    step(' Spread the ricotta. '),
    step('Spread the ricotta.'),
    step('Zest the lemon.', ''),
  ];
  expect(stepsWithoutClips(steps, []).map((s) => s.text)).toEqual([
    ' Spread the ricotta. ',
    'Zest the lemon.',
  ]);
});

test('a clip on its way counts as one, and a finished or failed one does not', () => {
  const steps = [step('Spread the ricotta.'), step('Zest the lemon.'), step('Serve it.')];
  const clips: StepClipJob[] = [
    { text: 'Spread the ricotta.', status: 'processing', error: '' },
    { text: 'Zest the lemon.', status: 'failed', error: 'No luck.' },
    { text: 'Serve it.', status: 'completed', error: '', url: 'https://media.test/serve.mp4' },
  ];
  expect(stepsWithoutClips(steps, clips).map((s) => s.text)).toEqual([
    'Zest the lemon.',
    'Serve it.',
  ]);
  expect(clipFor(steps[0], clips)?.status).toBe('processing');
  expect(clipFor(steps[1], clips)).toBeUndefined();
});
