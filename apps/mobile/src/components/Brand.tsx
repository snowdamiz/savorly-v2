import React from 'react';
import Svg, { Path } from 'react-native-svg';
import artwork from '../../assets/brand-artwork.json';

export const brandColors = artwork.colors;

/** Shared vector artwork also used to render the launcher icons and favicon. */
export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox={artwork.mascot.viewBox}
      accessible={false}
      aria-hidden
      pointerEvents="none"
    >
      <Path d={artwork.mascot.path} fill={brandColors.ink} />
      <Path d={artwork.mascot.accents} fill={brandColors.cream} />
      <Path d={artwork.mascot.eyes} fill={brandColors.cream} />
      <Path d={artwork.mascot.pupils} fill={brandColors.ink} />
    </Svg>
  );
}

/** The full wordmark is reserved for the web navigation, not mobile sheets. */
export function BrandWordmark({ width = 134 }: { width?: number }) {
  const [, , sourceWidth, sourceHeight] = artwork.wordmark.viewBox.split(' ').map(Number);
  return (
    <Svg
      width={width}
      height={(width * sourceHeight) / sourceWidth}
      viewBox={artwork.wordmark.viewBox}
      accessible={false}
      aria-hidden
      pointerEvents="none"
    >
      <Path d={artwork.wordmark.path} fill={brandColors.ink} fillRule="evenodd" />
    </Svg>
  );
}
