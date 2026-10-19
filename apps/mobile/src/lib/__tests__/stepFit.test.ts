/// <reference types="jest" />
import { lineCount, STEP_TYPES, stepType } from '../stepFit';

const step =
  'Add the tomatoes, crush them with the spoon and let the sauce simmer gently, uncovered, until ' +
  'thick and glossy. Stir from the bottom every few minutes so it doesn’t catch.';

describe('lineCount', () => {
  it('wraps words onto as many lines as they need', () => {
    expect(lineCount('', 20, 350)).toBe(0);
    expect(lineCount('Serve it hot.', 20, 350)).toBe(1);
    // About 35 characters a line at 20 points in 350: the step's 170 take five lines, as on a
    // phone.
    expect(lineCount(step, 20, 350)).toBe(5);
    expect(lineCount(step, 20, 700)).toBe(3);
  });

  it('counts each paragraph from a new line', () => {
    expect(lineCount('Drain.\nServe.', 20, 350)).toBe(2);
  });

  it('breaks Chinese and Japanese between any two characters', () => {
    // 40 characters a full em wide, 17 to a line of 350 at 20 points.
    expect(
      lineCount(
        'トマトを加え、スプーンでつぶし、ふたをせずに弱火で煮詰めます。とろみとつやが出るまで煮ます',
        20,
        350,
      ),
    ).toBe(3);
  });

  it('breaks a word longer than the line', () => {
    expect(lineCount('a'.repeat(100), 20, 350)).toBe(3);
  });
});

describe('stepType', () => {
  const room = { title: 'Simmer', text: step, width: 350 };

  it('starts a size up on big screens, and a size down on phones', () => {
    expect(stepType({ ...room, height: 2000, big: true })).toBe(0);
    expect(stepType({ ...room, height: 2000, big: false })).toBe(1);
  });

  it('takes the largest size that fits, and the smallest when none does', () => {
    // At 20 points: one title line (36) and five of text (155).
    expect(stepType({ ...room, height: 191, big: false })).toBe(1);
    expect(stepType({ ...room, height: 190, big: false })).toBe(2);
    expect(stepType({ ...room, height: 40, big: false })).toBe(STEP_TYPES.length - 1);
  });

  it('leaves the room asked for, and follows the system text size', () => {
    expect(stepType({ ...room, height: 271, reserved: 80, big: false })).toBe(1);
    expect(stepType({ ...room, height: 270, reserved: 80, big: false })).toBe(2);
    expect(stepType({ ...room, height: 191, big: false, fontScale: 1.3 })).toBeGreaterThan(1);
  });
});
