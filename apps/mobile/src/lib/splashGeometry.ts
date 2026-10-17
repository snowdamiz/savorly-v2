import artwork from '../../assets/brand-artwork.json';

export const splashSize = 112;
const [x, y] = artwork.mascot.eyeOrigin.split(' ').map(parseFloat);

// React Native's string parser truncates decimal percentages. A numeric tuple
// bypasses that parser and keeps the blink centered on the face on every platform.
export const splashEyeOrigin: [number, number, number] = [
  (x / 100) * splashSize,
  (y / 100) * splashSize,
  0,
];
