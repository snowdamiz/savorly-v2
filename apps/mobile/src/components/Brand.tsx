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
      viewBox={artwork.clove.viewBox}
      accessible={false}
      aria-hidden
      pointerEvents="none"
    >
      <Path d={artwork.clove.path} fill={brandColors.ink} fillRule="evenodd" />
      <Path d={artwork.clove.eyes} fill={brandColors.cream} />
    </Svg>
  );
}
