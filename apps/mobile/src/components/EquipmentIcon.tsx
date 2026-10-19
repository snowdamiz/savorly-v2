import React from 'react';
import { Platform } from 'react-native';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';

// Original illustrations of kitchen equipment, drawn like the cuisine icons (CuisineIcon.tsx):
// fixed colors on a 64-unit grid, legible on white and grey surfaces. Each is keyed by what the
// server's lexicon says a name names (services/api/internal/app/equipment_lexicon.go): an
// equipment key, or an everyday tool it reads only on a cook's list. Anything else gets utensils.
const p = {
  cream: '#FFF3D6',
  rice: '#FFFCF2',
  gold: '#E8AD45',
  crust: '#B97132',
  red: '#C94F3D',
  coral: '#EA8261',
  green: '#568258',
  mint: '#8BAD70',
  dark: '#344C40',
  brown: '#754B36',
  blue: '#86AEB5',
  plate: '#DAE7E5',
  steel: '#B4C4C4',
  shade: '#5F7A74',
};

const round = { strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' } as const;

const utensils = (
  <>
    <G transform="rotate(-32 32 32)">
      <Ellipse cx="32" cy="14" rx="6.5" ry="9" fill={p.steel} />
      <Rect x="30" y="21" width="4" height="22" rx="2" fill={p.steel} />
      <Rect x="29" y="40" width="6" height="18" rx="3" fill={p.dark} />
    </G>
    <G transform="rotate(32 32 32)">
      <Path d="M26 5v10M30 5v10M34 5v10M38 5v10" stroke={p.steel} strokeWidth="2.6" {...round} />
      <Path d="M24.5 13h15v3c0 5-3 8-7.5 8s-7.5-3-7.5-8Z" fill={p.steel} />
      <Rect x="30" y="22" width="4" height="21" rx="2" fill={p.steel} />
      <Rect x="29" y="40" width="6" height="18" rx="3" fill={p.dark} />
    </G>
  </>
);

const illustrations: Record<string, React.ReactNode> = {
  // Pots and pans
  pot: (
    <>
      <Rect x="3" y="27" width="10" height="6" rx="3" fill={p.dark} />
      <Rect x="51" y="27" width="10" height="6" rx="3" fill={p.dark} />
      <Path d="M11 24h42v20a10 10 0 0 1-10 10H21a10 10 0 0 1-10-10Z" fill={p.blue} />
      <Rect x="9" y="21" width="46" height="6" rx="3" fill={p.shade} />
      <Path d="M12 21c2-7 10-11 20-11s18 4 20 11Z" fill={p.steel} />
      <Rect x="27" y="5" width="10" height="7" rx="3.5" fill={p.dark} />
      <Path d="M17 33v11" stroke={p.rice} strokeWidth="3" opacity=".6" {...round} />
    </>
  ),
  saucepan: (
    <>
      <Path d="M40 29l20-6" stroke={p.brown} strokeWidth="6" {...round} />
      <Path d="M5 28h36v16a9 9 0 0 1-9 9H14a9 9 0 0 1-9-9Z" fill={p.crust} />
      <Rect x="3" y="25" width="40" height="6" rx="3" fill={p.brown} />
      <Path d="M11 35v9" stroke={p.cream} strokeWidth="3" opacity=".55" {...round} />
      <Path
        d="M17 20c-2-3 2-5 0-8M25 20c-2-3 2-5 0-8"
        stroke={p.blue}
        strokeWidth="2.5"
        {...round}
      />
    </>
  ),
  'frying pan': (
    <>
      <Path d="M44 30l16-10" stroke={p.brown} strokeWidth="6" {...round} />
      <Ellipse cx="26" cy="36" rx="23" ry="16" fill={p.dark} />
      <Ellipse cx="26" cy="35" rx="18" ry="11.5" fill={p.shade} />
      <Path d="M14 31c3-4 9-6 15-5" stroke={p.steel} strokeWidth="2.5" opacity=".8" {...round} />
    </>
  ),
  griddle: (
    <>
      <Rect x="42" y="29" width="20" height="6" rx="3" fill={p.brown} />
      <Rect x="3" y="12" width="44" height="40" rx="7" fill={p.dark} />
      <Path
        d="M10 26l9-9M10 36l19-19M10 46l29-29M20 46l20-20M30 46l10-10"
        stroke={p.shade}
        strokeWidth="3"
        {...round}
      />
    </>
  ),
  wok: (
    <>
      <Path d="M50 27l11-6" stroke={p.brown} strokeWidth="5" {...round} />
      <Path d="M5 26c3-1 4 3 2 5" stroke={p.dark} strokeWidth="3" {...round} />
      <Path d="M4 26h48c-2 15-11 25-24 25S6 41 4 26Z" fill={p.dark} />
      <Rect x="2" y="23" width="52" height="5" rx="2.5" fill={p.shade} />
      <Path d="M12 33c3 7 8 11 14 12" stroke={p.shade} strokeWidth="3" {...round} />
      <Path
        d="M22 21c-1-4 3-5 2-9M32 21c-1-4 3-5 2-9"
        stroke={p.blue}
        strokeWidth="2.5"
        {...round}
      />
    </>
  ),
  'dutch oven': (
    <>
      <Path d="M3 35c-1-5 3-7 7-6M61 35c1-5-3-7-7-6" stroke={p.dark} strokeWidth="4" {...round} />
      <Path d="M9 28h46v14c0 8-6 12-14 12H23c-8 0-14-4-14-12Z" fill={p.red} />
      <Path d="M8 27c3-9 13-13 24-13s21 4 24 13Z" fill={p.coral} />
      <Rect x="27" y="8" width="10" height="7" rx="3.5" fill={p.dark} />
      <Rect x="6" y="26" width="52" height="4" rx="2" fill={p.dark} />
      <Path d="M15 35v8" stroke={p.cream} strokeWidth="3" opacity=".55" {...round} />
    </>
  ),
  'roasting pan': (
    <>
      <Path d="M15 31c0-10 8-16 17-16s17 6 17 16Z" fill={p.crust} />
      <Path d="M22 22c3-3 7-4 11-3" stroke={p.gold} strokeWidth="3" {...round} />
      <Path d="M3 30c-1 5 1 8 5 8M61 30c1 5-1 8-5 8" stroke={p.shade} strokeWidth="3" {...round} />
      <Path d="M6 29h52l-4 18a5 5 0 0 1-5 4H15a5 5 0 0 1-5-4Z" fill={p.blue} />
      <Rect x="4" y="27" width="56" height="5" rx="2.5" fill={p.shade} />
    </>
  ),
  'sheet pan': (
    <>
      <Path d="M3 41l15-17h43L46 41Z" fill={p.shade} />
      <Path d="M9 39l11-12h34L43 39Z" fill={p.blue} />
      <Path d="M3 41h43v5H3Z" fill={p.dark} />
      <Path d="M46 41l15-17v5L46 46Z" fill={p.dark} />
      <Ellipse cx="22" cy="35" rx="4.5" ry="2.6" fill={p.gold} />
      <Ellipse cx="33" cy="30.5" rx="4.5" ry="2.6" fill={p.gold} />
      <Ellipse cx="35" cy="36" rx="4.5" ry="2.6" fill={p.crust} />
    </>
  ),
  'baking dish': (
    <>
      <Path d="M10 26c4-5 9-1 13-4s9 2 13-1 9 2 13-1 5 2 6 6Z" fill={p.gold} />
      <Circle cx="21" cy="22.5" r="1.8" fill={p.crust} />
      <Circle cx="33" cy="21.5" r="1.8" fill={p.crust} />
      <Circle cx="45" cy="22.5" r="1.8" fill={p.crust} />
      <Path d="M8 30h48l-3 17a5 5 0 0 1-5 4H16a5 5 0 0 1-5-4Z" fill={p.coral} />
      <Rect x="2" y="25" width="60" height="6" rx="3" fill={p.red} />
      <Path d="M14 36l2 9" stroke={p.cream} strokeWidth="3" opacity=".5" {...round} />
    </>
  ),
  'loaf pan': (
    <>
      <Path d="M13 31c0-12 8-19 19-19s19 7 19 19Z" fill={p.gold} />
      <Path d="M23 18l4 6M31 15l4 7M39 17l4 6" stroke={p.crust} strokeWidth="2.5" {...round} />
      <Path d="M10 29h44l-4 24H14Z" fill={p.blue} />
      <Rect x="7" y="27" width="50" height="5" rx="2.5" fill={p.shade} />
    </>
  ),
  'cake pan': (
    <>
      <Path d="M8 26v19c0 5 11 9 24 9s24-4 24-9V26Z" fill={p.blue} />
      <Ellipse cx="32" cy="26" rx="24" ry="8" fill={p.shade} />
      <Ellipse cx="32" cy="26" rx="20.5" ry="6" fill={p.gold} />
      <Rect x="50" y="32" width="9" height="9" rx="2.5" fill={p.dark} />
      <Path d="M14 33v11" stroke={p.rice} strokeWidth="3" opacity=".55" {...round} />
    </>
  ),
  'pie dish': (
    <>
      <Path d="M8 35c2-12 12-19 24-19s22 7 24 19Z" fill={p.gold} />
      <Path
        d="M17 34l10-15M28 35l11-17M40 35l7-10M12 28h40M10 32h44"
        stroke={p.crust}
        strokeWidth="2.2"
        {...round}
      />
      <Path d="M4 35h56l-6 12a6 6 0 0 1-5 3H15a6 6 0 0 1-5-3Z" fill={p.coral} />
      <Path
        d="M5 35q3-3 6 0t6 0 6 0 6 0 6 0 6 0 6 0 6 0 6 0"
        stroke={p.crust}
        strokeWidth="3"
        {...round}
      />
    </>
  ),
  'muffin pan': (
    <>
      <Rect x="3" y="13" width="58" height="40" rx="8" fill={p.blue} />
      {[18, 32, 46].flatMap((x) =>
        [25, 41].map((y) => (
          <G key={`${x}-${y}`}>
            <Circle cx={x} cy={y} r="6.8" fill={p.shade} />
            <Circle cx={x} cy={y - 1} r="5.4" fill={p.gold} />
            <Circle cx={x - 1.5} cy={y - 2.5} r="1.6" fill={p.cream} opacity=".7" />
          </G>
        )),
      )}
    </>
  ),
  // Appliances
  oven: (
    <>
      <Rect x="7" y="5" width="50" height="54" rx="7" fill={p.dark} />
      <Circle cx="15" cy="12" r="2.6" fill={p.rice} />
      <Circle cx="23" cy="12" r="2.6" fill={p.rice} />
      <Circle cx="31" cy="12" r="2.6" fill={p.rice} />
      <Rect x="40" y="9.5" width="11" height="5" rx="2" fill={p.gold} />
      <Rect x="14" y="20" width="36" height="3.5" rx="1.75" fill={p.steel} />
      <Rect x="12" y="27" width="40" height="25" rx="4" fill={p.gold} />
      <Rect x="16" y="31" width="32" height="17" rx="3" fill={p.coral} />
      <Path d="M18 41h28" stroke={p.crust} strokeWidth="2" {...round} />
      <Path d="M21 41c0-5 3-7 6-7h10c3 0 6 2 6 7" fill={p.crust} />
    </>
  ),
  grill: (
    <>
      <Path d="M20 44l-6 15M44 44l6 15M32 47v12" stroke={p.dark} strokeWidth="3.5" {...round} />
      <Path d="M8 30h48c-1 12-11 20-24 20S9 42 8 30Z" fill={p.dark} />
      <Path d="M19 27c-4-5 0-10 3-13 0 4 5 6 3 13Z" fill={p.coral} />
      <Path d="M30 27c-5-7 1-13 4-17 0 5 6 9 3 17Z" fill={p.red} />
      <Path d="M42 27c-3-5 0-9 3-12 0 4 4 6 3 12Z" fill={p.coral} />
      <Path d="M31.5 27c-2-3 0-6 1.5-8 0 3 3 4 1.5 8Z" fill={p.gold} />
      <Rect x="6" y="27" width="52" height="4" rx="2" fill={p.shade} />
    </>
  ),
  'slow cooker': (
    <>
      <Rect x="2" y="32" width="8" height="5" rx="2.5" fill={p.dark} />
      <Rect x="54" y="32" width="8" height="5" rx="2.5" fill={p.dark} />
      <Path d="M8 28h48v16c0 7-5 10-12 10H20c-7 0-12-3-12-10Z" fill={p.dark} />
      <Path d="M8 27c3-8 12-12 24-12s21 4 24 12Z" fill={p.plate} />
      <Path d="M17 22c3-3 7-4 11-4" stroke={p.rice} strokeWidth="2.5" {...round} />
      <Rect x="27" y="10" width="10" height="6" rx="3" fill={p.dark} />
      <Rect x="6" y="26" width="52" height="4" rx="2" fill={p.shade} />
      <Rect x="25" y="37" width="14" height="9" rx="2.5" fill={p.shade} />
      <Circle cx="32" cy="41.5" r="2.6" fill={p.gold} />
    </>
  ),
  'pressure cooker': (
    <>
      <Path d="M32 8c-2-2 0-4 1-6M37 9c1-2 3-3 2-6" stroke={p.blue} strokeWidth="2.2" {...round} />
      <Rect x="52" y="30" width="10" height="5" rx="2.5" fill={p.dark} />
      <Rect x="2" y="30" width="10" height="5" rx="2.5" fill={p.dark} />
      <Path d="M10 28h44v16a10 10 0 0 1-10 10H20a10 10 0 0 1-10-10Z" fill={p.blue} />
      <Path d="M8 29c2-7 12-11 24-11s22 4 24 11Z" fill={p.shade} />
      <Rect x="16" y="14" width="32" height="5" rx="2.5" fill={p.dark} />
      <Rect x="30" y="9" width="4" height="6" rx="2" fill={p.red} />
      <Path d="M16 35v9" stroke={p.rice} strokeWidth="3" opacity=".55" {...round} />
    </>
  ),
  'air fryer': (
    <>
      <Rect x="12" y="5" width="40" height="54" rx="12" fill={p.dark} />
      <Circle cx="32" cy="16" r="5.5" fill={p.gold} />
      <Circle cx="32" cy="16" r="2" fill={p.crust} />
      <Rect x="16" y="27" width="32" height="27" rx="6" fill={p.shade} />
      <Rect x="25" y="36" width="14" height="5" rx="2.5" fill={p.rice} />
    </>
  ),
  'deep fryer': (
    <>
      <Path d="M38 24l17-15" stroke={p.dark} strokeWidth="5" {...round} />
      <Rect x="16" y="17" width="26" height="10" rx="2" fill={p.plate} />
      <Path d="M21 17v10M27 17v10M33 17v10M38 17v10" stroke={p.blue} strokeWidth="1.6" />
      <Rect x="10" y="24" width="44" height="6" rx="3" fill={p.gold} />
      <Rect x="8" y="27" width="48" height="27" rx="6" fill={p.blue} />
      <Rect x="40" y="35" width="10" height="5" rx="2.5" fill={p.dark} />
      <Path d="M14 34v13" stroke={p.rice} strokeWidth="3" opacity=".5" {...round} />
    </>
  ),
  microwave: (
    <>
      <Rect x="4" y="12" width="56" height="40" rx="6" fill={p.dark} />
      <Rect x="9" y="17" width="34" height="30" rx="4" fill={p.blue} />
      <Path
        d="M14 30l10-10M15 39l17-17"
        stroke={p.plate}
        strokeWidth="2.5"
        opacity=".7"
        {...round}
      />
      <Rect x="47" y="18" width="9" height="6" rx="2" fill={p.gold} />
      {[30, 35.5, 41].flatMap((y) =>
        [49.5, 53.5].map((x) => <Circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" fill={p.rice} />),
      )}
      <Rect x="9" y="52" width="8" height="3" rx="1.5" fill={p.dark} />
      <Rect x="47" y="52" width="8" height="3" rx="1.5" fill={p.dark} />
    </>
  ),
  'rice cooker': (
    <>
      <Path d="M22 19c0-8 20-8 20 0" stroke={p.dark} strokeWidth="4" {...round} />
      <Path d="M8 32h48v12c0 7-6 10-13 10H21c-7 0-13-3-13-10Z" fill={p.mint} />
      <Path d="M7 33c0-10 11-16 25-16s25 6 25 16Z" fill={p.plate} />
      <Path d="M15 27c3-3 8-5 13-5" stroke={p.rice} strokeWidth="2.5" {...round} />
      <Rect x="26" y="39" width="12" height="8" rx="2.5" fill={p.rice} />
      <Circle cx="32" cy="43" r="2" fill={p.red} />
    </>
  ),
  steamer: (
    <>
      <Rect x="8" y="38" width="48" height="15" rx="4" fill={p.gold} />
      <Rect x="8" y="24" width="48" height="15" rx="4" fill={p.gold} />
      <Path d="M8 31.5h48M8 45.5h48" stroke={p.crust} strokeWidth="2.5" />
      <Path
        d="M14 26v11M22 26v11M30 26v11M38 26v11M46 26v11"
        stroke={p.crust}
        strokeWidth="1.4"
        opacity=".55"
      />
      <Path d="M8 25c3-9 13-14 24-14s21 5 24 14Z" fill={p.crust} />
      <Path
        d="M18 19c4-3 9-4 14-4M32 15c5 0 10 1 14 4"
        stroke={p.gold}
        strokeWidth="1.8"
        {...round}
      />
      <Rect x="28" y="7" width="8" height="5" rx="2.5" fill={p.brown} />
    </>
  ),
  // Blending and mixing
  blender: (
    <>
      <Path
        d="M48 15h4a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3h-6"
        stroke={p.dark}
        strokeWidth="3"
        {...round}
      />
      <Path d="M16 10h32l-5 34H21Z" fill={p.plate} />
      <Path d="M18.6 27h26.8l-2.5 17H21.1Z" fill={p.green} />
      <Path d="M27 40l5-3 5 3" stroke={p.dark} strokeWidth="2" {...round} />
      <Path d="M21 15l2 16" stroke={p.rice} strokeWidth="2.5" opacity=".8" {...round} />
      <Rect x="14" y="5" width="36" height="7" rx="3.5" fill={p.dark} />
      <Path d="M19 44h26l3 13H16Z" fill={p.dark} />
      <Circle cx="32" cy="51" r="2.6" fill={p.gold} />
    </>
  ),
  'immersion blender': (
    <>
      <Rect x="24" y="3" width="16" height="27" rx="8" fill={p.dark} />
      <Rect x="29" y="9" width="6" height="9" rx="3" fill={p.gold} />
      <Rect x="29" y="28" width="6" height="20" fill={p.steel} />
      <Path d="M21 46h22l-3 11H24Z" fill={p.blue} />
      <Path d="M26 53h12" stroke={p.dark} strokeWidth="2" {...round} />
    </>
  ),
  'food processor': (
    <>
      <Path
        d="M47 22h4a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-4"
        stroke={p.dark}
        strokeWidth="3"
        {...round}
      />
      <Rect x="33" y="5" width="9" height="12" rx="2" fill={p.plate} />
      <Rect x="34.5" y="2" width="6" height="6" rx="2" fill={p.dark} />
      <Rect x="13" y="18" width="34" height="25" rx="4" fill={p.plate} />
      <Rect x="28.5" y="22" width="3" height="16" fill={p.shade} />
      <Path d="M20 33c6-5 10 4 20-1" stroke={p.shade} strokeWidth="2.5" {...round} />
      <Circle cx="21" cy="38" r="2.4" fill={p.coral} />
      <Circle cx="38" cy="39" r="2" fill={p.mint} />
      <Rect x="11" y="15" width="38" height="5" rx="2.5" fill={p.dark} />
      <Rect x="9" y="42" width="42" height="15" rx="5" fill={p.dark} />
      <Circle cx="24" cy="49.5" r="2" fill={p.rice} />
      <Circle cx="32" cy="49.5" r="2" fill={p.gold} />
    </>
  ),
  'stand mixer': (
    <>
      <Rect x="10" y="22" width="12" height="32" rx="4" fill={p.coral} />
      <Path d="M10 26c0-10 6-14 14-14h21c7 0 11 4 11 9v3c0 3-2 5-5 5H10Z" fill={p.coral} />
      <Path d="M16 17c3-2 7-3 12-3" stroke={p.cream} strokeWidth="2.5" opacity=".7" {...round} />
      <Path d="M40 29v9" stroke={p.shade} strokeWidth="3" {...round} />
      <Path d="M26 38h28c-1 10-7 15-14 15s-13-5-14-15Z" fill={p.blue} />
      <Rect x="24" y="36" width="32" height="4" rx="2" fill={p.shade} />
      <Rect x="6" y="52" width="52" height="6" rx="3" fill={p.red} />
    </>
  ),
  'hand mixer': (
    <>
      <Path d="M19 14c0-7 4-9 11-9h8c6 0 9 3 9 8" stroke={p.coral} strokeWidth="6" {...round} />
      <Path d="M8 27c0-9 7-15 16-15h20c8 0 12 6 12 13v4H8Z" fill={p.coral} />
      <Rect x="8" y="27" width="48" height="5" rx="2.5" fill={p.red} />
      <Path d="M24 32v14M38 32v14" stroke={p.steel} strokeWidth="3" {...round} />
      <Ellipse cx="24" cy="51" rx="4.5" ry="7" stroke={p.steel} strokeWidth="2.6" fill="none" />
      <Ellipse cx="38" cy="51" rx="4.5" ry="7" stroke={p.steel} strokeWidth="2.6" fill="none" />
      <Circle cx="44" cy="19" r="2.4" fill={p.cream} />
    </>
  ),
  whisk: (
    <G transform="rotate(38 32 34)">
      <Path
        d="M32 42c-10-8-12-25-6-33 3-4 9-4 12 0 6 8 4 25-6 33Z"
        stroke={p.steel}
        strokeWidth="2.6"
        {...round}
      />
      <Path
        d="M32 42c-6-8-7-25-3-32 1.5-2 4.5-2 6 0 4 7 3 24-3 32Z"
        stroke={p.blue}
        strokeWidth="2.4"
        {...round}
      />
      <Path d="M32 42V9" stroke={p.steel} strokeWidth="2.4" {...round} />
      <Rect x="28.5" y="40" width="7" height="22" rx="3.5" fill={p.brown} />
    </G>
  ),
  // Tools
  grater: (
    <>
      <Rect
        x="25"
        y="3"
        width="14"
        height="10"
        rx="5"
        stroke={p.dark}
        strokeWidth="3"
        fill="none"
      />
      <Path d="M20 11h24l7 44H13Z" fill={p.blue} />
      <Path
        d="M22 20h4M30 20h4M38 20h4M21 28h4M30 28h4M39 28h4M20 36h4M30 36h4M40 36h4M19 44h4M30 44h4M41 44h4"
        stroke={p.shade}
        strokeWidth="2.6"
        {...round}
      />
      <Rect x="11" y="54" width="42" height="4" rx="2" fill={p.shade} />
    </>
  ),
  mandoline: (
    <>
      <Path d="M48 30l5 23M16 44l-3 11" stroke={p.dark} strokeWidth="3" {...round} />
      <Rect
        x="5"
        y="28"
        width="54"
        height="12"
        rx="4"
        fill={p.dark}
        transform="rotate(-24 32 34)"
      />
      <Rect
        x="24"
        y="31"
        width="16"
        height="3.4"
        rx="1.7"
        fill={p.steel}
        transform="rotate(-24 32 34)"
      />
      <Circle cx="31" cy="51" r="4.5" fill={p.green} />
      <Circle cx="31" cy="51" r="3" fill={p.mint} />
      <Circle cx="41" cy="56" r="4" fill={p.green} />
      <Circle cx="41" cy="56" r="2.6" fill={p.mint} />
    </>
  ),
  'rolling pin': (
    <G transform="rotate(-28 32 32)">
      <Rect x="2" y="29" width="14" height="6" rx="3" fill={p.brown} />
      <Rect x="48" y="29" width="14" height="6" rx="3" fill={p.brown} />
      <Rect x="13" y="23" width="38" height="18" rx="9" fill={p.gold} />
      <Path d="M20 28h22" stroke={p.cream} strokeWidth="2.5" opacity=".75" {...round} />
    </G>
  ),
  sieve: (
    <>
      <Path d="M46 24h15" stroke={p.dark} strokeWidth="5" {...round} />
      <Path d="M5 24h42c-1 14-10 23-21 23S6 38 5 24Z" fill={p.plate} />
      <Path
        d="M9 30c11 3 24 3 35 0M13 37c9 3 18 3 27 0M17 26l3 18M26 26v20M35 26l-3 18"
        stroke={p.blue}
        strokeWidth="1.6"
        {...round}
      />
      <Rect x="3" y="21" width="46" height="5" rx="2.5" fill={p.dark} />
    </>
  ),
  colander: (
    <>
      <Path d="M21 49h22l2 7H19Z" fill={p.red} />
      <Path d="M8 26h48c-2 15-12 23-24 23S10 41 8 26Z" fill={p.coral} />
      {[
        [18, 32],
        [25, 34],
        [32, 35],
        [39, 34],
        [46, 32],
        [22, 40],
        [29, 42],
        [36, 42],
        [43, 40],
      ].map(([x, y]) => (
        <Circle key={`${x}-${y}`} cx={x} cy={y} r="1.7" fill={p.cream} />
      ))}
      <Rect x="1" y="21" width="9" height="5" rx="2.5" fill={p.red} />
      <Rect x="54" y="21" width="9" height="5" rx="2.5" fill={p.red} />
      <Rect x="5" y="23" width="54" height="5" rx="2.5" fill={p.red} />
    </>
  ),
  thermometer: (
    <>
      <Path d="M30 33h4v21l-2 6-2-6Z" fill={p.steel} />
      <Circle cx="32" cy="20" r="15" fill={p.dark} />
      <Circle cx="32" cy="20" r="11" fill={p.rice} />
      <Path d="M24.5 27.5A10.5 10.5 0 0 1 32 9.5" stroke={p.blue} strokeWidth="2.4" {...round} />
      <Path d="M32 9.5a10.5 10.5 0 0 1 7.5 18" stroke={p.coral} strokeWidth="2.4" {...round} />
      <Path d="M32 20l6-7" stroke={p.red} strokeWidth="2.6" {...round} />
      <Circle cx="32" cy="20" r="2.2" fill={p.dark} />
    </>
  ),
  'kitchen scale': (
    <>
      <Rect x="28" y="22" width="8" height="10" fill={p.shade} />
      <Ellipse cx="32" cy="21" rx="23" ry="6.5" fill={p.plate} />
      <Ellipse cx="32" cy="20" rx="17" ry="4" fill={p.rice} />
      <Path
        d="M8 34a6 6 0 0 1 6-6h36a6 6 0 0 1 6 6v14a6 6 0 0 1-6 6H14a6 6 0 0 1-6-6Z"
        fill={p.dark}
      />
      <Rect x="17" y="35" width="30" height="11" rx="3" fill={p.gold} />
      <Path d="M23 40.5h4M30 40.5h4M37 40.5h4" stroke={p.dark} strokeWidth="2.4" {...round} />
    </>
  ),
  'mortar and pestle': (
    <>
      <Path d="M36 31L52 7" stroke={p.brown} strokeWidth="8" {...round} />
      <Path d="M17 28c1-6 5-8 9-6M45 28c-2-5-6-6-9-4" stroke={p.green} strokeWidth="3" {...round} />
      <Path d="M8 30h48c-1 13-10 20-24 20S9 43 8 30Z" fill={p.steel} />
      <Rect x="6" y="27" width="52" height="6" rx="3" fill={p.shade} />
      <Rect x="21" y="48" width="22" height="7" rx="3" fill={p.shade} />
      <Path d="M15 37c2 5 5 8 9 9" stroke={p.rice} strokeWidth="3" opacity=".6" {...round} />
    </>
  ),
  // Everyday tools, from cooks' lists
  bowl: (
    <>
      <Ellipse cx="32" cy="27" rx="26" ry="8" fill={p.plate} />
      <Path d="M6 28h52c-2 15-12 23-26 23S8 43 6 28Z" fill={p.blue} />
      <Path d="M12 34c3 7 8 11 14 12" stroke={p.rice} strokeWidth="3" opacity=".55" {...round} />
      <Rect x="24" y="50" width="16" height="4" rx="2" fill={p.blue} />
    </>
  ),
  spoon: (
    <G transform="rotate(40 32 32)">
      <Ellipse cx="32" cy="15" rx="8.5" ry="11.5" fill={p.gold} />
      <Ellipse cx="32" cy="14" rx="5.2" ry="7.6" fill={p.crust} opacity=".35" />
      <Rect x="29.5" y="24" width="5" height="36" rx="2.5" fill={p.gold} />
    </G>
  ),
  knife: (
    <G transform="rotate(38 32 32)">
      <Path d="M26 38V8c0-2 1.5-3 3-2 6 6 8 18 8 32Z" fill={p.steel} />
      <Path d="M28.5 12v24" stroke={p.rice} strokeWidth="2" opacity=".8" {...round} />
      <Rect x="25" y="37" width="13" height="4" rx="1.5" fill={p.shade} />
      <Rect x="26.5" y="40" width="10" height="21" rx="4" fill={p.dark} />
      <Circle cx="31.5" cy="46" r="1.3" fill={p.rice} />
      <Circle cx="31.5" cy="54" r="1.3" fill={p.rice} />
    </G>
  ),
  'cutting board': (
    <>
      <Path d="M48 26h7a5 5 0 0 1 5 5v2a5 5 0 0 1-5 5h-7Z" fill={p.gold} />
      <Rect x="4" y="12" width="48" height="40" rx="8" fill={p.gold} />
      <Circle cx="55.5" cy="32" r="2.2" fill="#FFFFFF" />
      <Path
        d="M12 24c8-3 16 3 26 0M12 34c10-3 18 3 30 0M14 44c8-2 14 2 22 0"
        stroke={p.crust}
        strokeWidth="1.8"
        opacity=".55"
        {...round}
      />
    </>
  ),
  spatula: (
    <G transform="rotate(35 32 32)">
      <Rect x="21" y="3" width="22" height="23" rx="4" fill={p.dark} />
      <Rect x="25.5" y="7.5" width="3" height="14" rx="1.5" fill={p.shade} />
      <Rect x="30.5" y="7.5" width="3" height="14" rx="1.5" fill={p.shade} />
      <Rect x="35.5" y="7.5" width="3" height="14" rx="1.5" fill={p.shade} />
      <Rect x="30" y="25" width="4" height="9" fill={p.steel} />
      <Rect x="28" y="33" width="8" height="27" rx="4" fill={p.brown} />
    </G>
  ),
  ladle: (
    <>
      <Path d="M41 6c4 0 7 3 4 8L31 40" stroke={p.steel} strokeWidth="5" {...round} />
      <Path d="M11 40h36c0 10-7 17-18 17S11 50 11 40Z" fill={p.blue} />
      <Ellipse cx="29" cy="40" rx="18" ry="4.5" fill={p.shade} />
      <Ellipse cx="29" cy="40" rx="14.5" ry="2.8" fill={p.coral} />
    </>
  ),
  tongs: (
    <>
      <Path d="M50 12L11 42M53 15L25 55" stroke={p.steel} strokeWidth="4.5" {...round} />
      <Path d="M44 17L35 24M47 20L40 30" stroke={p.dark} strokeWidth="7" {...round} />
      <Circle cx="53" cy="11" r="5.5" fill={p.shade} />
      <Ellipse cx="11" cy="43" rx="4.5" ry="3" fill={p.steel} transform="rotate(-38 11 43)" />
      <Ellipse cx="25" cy="55" rx="4.5" ry="3" fill={p.steel} transform="rotate(-54 25 55)" />
    </>
  ),
  'baking paper': (
    <>
      <Path
        d="M14 22h40v24c-4 6-8 3-12 7s-8 2-12 4-10 1-16-2Z"
        fill={p.cream}
        stroke={p.gold}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <Path d="M20 30h26M20 37h20" stroke={p.gold} strokeWidth="1.6" opacity=".6" {...round} />
      <Rect x="10" y="9" width="46" height="15" rx="7.5" fill={p.gold} />
      <Ellipse cx="12" cy="16.5" rx="4" ry="7.5" fill={p.crust} />
      <Ellipse cx="12" cy="16.5" rx="1.6" ry="3" fill={p.brown} />
    </>
  ),
  toaster: (
    <>
      <Path d="M17 22v-9a5 5 0 0 1 11 0v9Z" fill={p.gold} stroke={p.crust} strokeWidth="2" />
      <Path d="M36 22v-6a5 5 0 0 1 11 0v6Z" fill={p.gold} stroke={p.crust} strokeWidth="2" />
      <Rect x="7" y="20" width="50" height="33" rx="9" fill={p.coral} />
      <Rect x="15" y="20" width="15" height="3.5" rx="1.75" fill={p.dark} />
      <Rect x="34" y="20" width="15" height="3.5" rx="1.75" fill={p.dark} />
      <Rect x="56" y="30" width="5" height="9" rx="2" fill={p.dark} />
      <Path d="M13 31v13" stroke={p.cream} strokeWidth="3" opacity=".6" {...round} />
      <Rect x="12" y="52" width="8" height="4" rx="2" fill={p.dark} />
      <Rect x="44" y="52" width="8" height="4" rx="2" fill={p.dark} />
    </>
  ),
  kettle: (
    <>
      <Path
        d="M6 19c-2-3 1-5 0-8M11 17c-2-3 1-5 0-8"
        stroke={p.blue}
        strokeWidth="2.2"
        {...round}
      />
      <Path d="M17 36L7 26" stroke={p.blue} strokeWidth="6" {...round} />
      <Path d="M20 21c0-11 24-11 24 0" stroke={p.dark} strokeWidth="5" {...round} />
      <Path d="M14 52h36l-4-23c-1-6-7-10-14-10s-13 4-14 10Z" fill={p.blue} />
      <Rect x="28" y="13" width="8" height="6" rx="3" fill={p.dark} />
      <Path d="M21 30l-2 15" stroke={p.rice} strokeWidth="3" opacity=".6" {...round} />
      <Rect x="12" y="50" width="40" height="6" rx="3" fill={p.dark} />
    </>
  ),
  peeler: (
    <>
      <Path d="M44 22c6 3 9 9 7 16" stroke={p.green} strokeWidth="3.4" {...round} />
      <Path d="M32 36L18 13M32 36l14-23" stroke={p.steel} strokeWidth="4" {...round} />
      <Path d="M18 13h28" stroke={p.shade} strokeWidth="5" {...round} />
      <Path d="M22 13h20" stroke={p.rice} strokeWidth="1.4" {...round} />
      <Rect x="28.5" y="34" width="7" height="26" rx="3.5" fill={p.coral} />
      <Circle cx="32" cy="54" r="1.6" fill={p.cream} />
    </>
  ),
  platter: (
    <>
      <Ellipse cx="32" cy="34" rx="29" ry="18" fill={p.plate} />
      <Ellipse cx="32" cy="33" rx="22" ry="12.5" fill={p.rice} />
      <Path d="M18 28c4-4 10-5 15-4" stroke={p.cream} strokeWidth="3" {...round} />
      <Path d="M40 37c3-5 8-6 11-4-2 4-7 6-11 4Z" fill={p.mint} />
    </>
  ),
  'measuring cup': (
    <>
      <Path
        d="M44 20h6a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4h-8"
        stroke={p.dark}
        strokeWidth="4"
        {...round}
      />
      <Path d="M13 13h32l-3 41a4 4 0 0 1-4 4H20a4 4 0 0 1-4-4Z" fill={p.plate} />
      <Path
        d="M14.6 32h28.8l-1.6 22a2.5 2.5 0 0 1-2.5 2.4H18.7a2.5 2.5 0 0 1-2.5-2.4Z"
        fill={p.blue}
      />
      <Path
        d="M19 21h7M19 27h10M19 33h7M19 39h10M19 45h7"
        stroke={p.shade}
        strokeWidth="2"
        {...round}
      />
      <Path d="M11 13h36" stroke={p.shade} strokeWidth="3" {...round} />
    </>
  ),
};

/** The illustration of what a name on a recipe's equipment list names; utensils for anything else. */
export function EquipmentIcon({ kind, size = 44 }: { kind: string; size?: number }) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      accessible={Platform.OS === 'web' ? undefined : false}
      aria-hidden
    >
      <G>{illustrations[kind] ?? utensils}</G>
    </Svg>
  );
}

/** The kinds drawn here, for the test that every equipment key has an illustration. */
export const equipmentIconKinds = Object.keys(illustrations);
