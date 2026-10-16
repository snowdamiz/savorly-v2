import React from 'react';
import { Platform } from 'react-native';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';
import { Cuisine, allCuisines, cuisineFilters } from '../lib/cuisines';

// Original food illustrations. Fixed colors keep the artwork legible on both
// white and selected black surfaces; all shapes share a 64-unit drawing grid.
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
};

function Plate({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Ellipse cx="32" cy="35" rx="27" ry="21" fill={p.plate} />
      <Ellipse cx="32" cy="34" rx="22" ry="16" fill={p.rice} />
      {children}
    </>
  );
}

function Bowl({ children, fill = p.blue }: { children: React.ReactNode; fill?: string }) {
  return (
    <>
      <Ellipse cx="32" cy="29" rx="26" ry="13" fill={p.cream} />
      {children}
      <Path d="M6 30h52c-2 15-12 23-26 23S8 45 6 30Z" fill={fill} />
      <Path d="M12 35c3 8 8 12 14 13" fill="none" stroke={p.rice} strokeWidth="3" opacity=".55" />
      <Rect x="24" y="52" width="16" height="4" rx="2" fill={fill} />
    </>
  );
}

const illustrations: Record<Cuisine | typeof allCuisines, React.ReactNode> = {
  'All cuisines': (
    <>
      <Circle cx="32" cy="31" r="25" fill={p.plate} />
      <Path d="m15 14 10-5 7 5-2 8-8 3-2 9-9-4-3-8Z" fill={p.green} />
      <Path d="m39 9 9 6 8 12-8 4-3-7-9-2Z" fill={p.mint} />
      <Path d="m29 33 9-4 10 8-6 14-10 5-5-11Z" fill={p.green} />
      <Path
        d="M7 32h50M32 6c-14 13-14 37 0 50M32 6c14 13 14 37 0 50"
        fill="none"
        stroke={p.rice}
        strokeWidth="1.5"
        opacity=".7"
      />
    </>
  ),
  Italian: (
    <>
      <Path d="M12 15 54 27 21 57Z" fill={p.crust} />
      <Path d="m15 19 34 10-26 23Z" fill={p.gold} />
      <Path d="m17 21 29 9-23 20Z" fill={p.cream} />
      <Path
        d="M11 15Q34 11 54 27"
        fill="none"
        stroke={p.crust}
        strokeWidth="9"
        strokeLinecap="round"
      />
      <Path
        d="M12 13Q35 11 53 24"
        fill="none"
        stroke={p.gold}
        strokeWidth="5"
        strokeLinecap="round"
      />
      <Circle cx="25" cy="29" r="5" fill={p.red} />
      <Circle cx="36" cy="32" r="4" fill={p.red} />
      <Circle cx="26" cy="42" r="3.5" fill={p.red} />
      <Path d="M31 21q9-3 8 5-7 3-8-5M19 34q-5 5 0 8 5-3 0-8" fill={p.green} />
    </>
  ),
  Japanese: (
    <>
      <Ellipse cx="32" cy="50" rx="27" ry="7" fill={p.plate} />
      <Rect x="7" y="28" width="31" height="21" rx="9" fill={p.rice} />
      <Path d="M7 34c-5-8 0-15 10-16h14c8 0 12 7 9 14Z" fill={p.coral} />
      <Path d="m15 21 8 11m3-13 8 12" stroke={p.cream} strokeWidth="3" strokeLinecap="round" />
      <Rect x="38" y="30" width="20" height="22" rx="7" fill={p.dark} />
      <Ellipse cx="48" cy="31" rx="10" ry="7" fill={p.rice} />
      <Ellipse cx="48" cy="31" rx="5" ry="3.5" fill={p.coral} />
      <Path d="m48 28 5 2-4 4Z" fill={p.green} />
    </>
  ),
  Mexican: (
    <>
      <Path d="M6 48C5 8 50 4 58 42Z" fill={p.crust} />
      <Path d="M9 42q3-21 20-24 18-2 26 23" fill={p.brown} />
      <Path d="m9 35 7-8 5 4 6-8 7 5 7-6 5 8 8 2 2 11H9Z" fill={p.green} />
      <Path d="m16 31 8-2 2 7-8 3m18-9 8 2-2 7-8-2" fill={p.red} />
      <Path d="M6 48q8-29 24-28c16 0 26 13 28 28Z" fill={p.gold} />
      <Path d="M12 44q8-20 19-20c11 0 19 9 22 20" fill="none" stroke={p.cream} strokeWidth="3" />
      <Circle cx="22" cy="39" r="1.5" fill={p.crust} />
      <Circle cx="34" cy="31" r="1.5" fill={p.crust} />
      <Circle cx="41" cy="41" r="1.5" fill={p.crust} />
    </>
  ),
  Indian: (
    <>
      <Path d="M39 10c13-5 24 6 20 19L41 43 30 30Z" fill={p.gold} />
      <Path
        d="m43 16 6-1m1 8 4 2m-14 4 4 2"
        stroke={p.crust}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <Ellipse cx="27" cy="32" rx="23" ry="12" fill={p.crust} />
      <Ellipse cx="27" cy="30" rx="20" ry="9" fill={p.red} />
      <Path d="M5 33h44l-5 15q-17 10-34 0Z" fill={p.gold} />
      <Path d="M13 42h28" stroke={p.cream} strokeWidth="2" strokeLinecap="round" />
      <Path
        d="M17 30c5-6 16 6 21-1"
        stroke={p.cream}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
      <Path d="M25 23q-6-6-9 0 4 5 9 0m0 0q3-7 8-3-1 6-8 3" fill={p.green} />
    </>
  ),
  French: (
    <>
      <Path
        d="M8 48C-2 35 7 17 22 12q10-5 23 3c14 8 17 22 11 33L43 37c1-7-4-12-11-12S19 30 21 37Z"
        fill={p.crust}
      />
      <Path d="M6 35 11 24l12 8-6 13Zm52 0-5-11-12 8 6 13Z" fill={p.gold} />
      <Path d="m11 23 10-9 12 9-12 14Zm42 0-10-9-12 9 12 14Z" fill={p.gold} />
      <Path d="m21 13 11-3 11 3-4 18-14 1Z" fill={p.crust} />
      <Path d="m24 14 8-2 8 2-3 14-10 1Z" fill={p.gold} />
      <Path
        d="m28 17 8-1m-6 6 4-1M16 24l5 4m22 0 5-4"
        stroke={p.cream}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </>
  ),
  Chinese: (
    <>
      <Ellipse cx="32" cy="48" rx="27" ry="11" fill={p.crust} />
      <Path d="M5 32h54v15c-5 15-49 15-54 0Z" fill={p.gold} />
      <Ellipse cx="32" cy="32" rx="27" ry="16" fill={p.crust} />
      <Ellipse cx="32" cy="31" rx="23" ry="12" fill={p.cream} />
      <Path d="M11 33q4-17 15-13 10 4 3 17-11 5-18-4Z" fill={p.rice} />
      <Path d="m18 25 2 8m4-11 1 12" stroke={p.gold} strokeWidth="2" strokeLinecap="round" />
      <Path d="M32 29q6-18 17-7 9 10-3 14-9 1-14-7Z" fill={p.rice} />
      <Path
        d="m39 21 1 10m5-7 1 7M12 46q20 9 40 0"
        stroke={p.gold}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
      />
    </>
  ),
  Korean: (
    <>
      <Ellipse cx="32" cy="37" rx="27" ry="21" fill={p.dark} />
      <Ellipse cx="32" cy="32" rx="23" ry="17" fill={p.cream} />
      <Path d="m13 25 14-6 3 13-18 3Z" fill={p.green} />
      <Path d="m35 18 15 6-3 10-16-4Z" fill={p.coral} />
      <Path d="m13 37 17-4-2 12-12-2Z" fill={p.brown} />
      <Path d="m38 34 13 3-9 10-12-4Z" fill={p.red} />
      <Path
        d="m16 27 9-4m-9 9 10-5m14-6 7 5m-8-1 7 6"
        stroke={p.rice}
        strokeWidth="1.5"
        opacity=".6"
      />
      <Path d="M24 24c5-6 16-3 18 4 4 8-4 16-12 12-9 0-12-11-6-16Z" fill={p.rice} />
      <Circle cx="32" cy="31" r="6" fill={p.gold} />
    </>
  ),
  Thai: (
    <Plate>
      <Path
        d="M15 36c-4-10 27-20 33-5s-24 19-30 9 30-15 24-4-22 6-18-1 16-7 12 0"
        fill="none"
        stroke={p.gold}
        strokeWidth="4"
        strokeLinecap="round"
      />
      <Path d="M40 19c12-3 16 10 7 14l-5-4c6-2 5-5 1-5" fill={p.coral} />
      <Path d="M13 22 28 12a16 16 0 0 1-4 19Z" fill={p.green} />
      <Path d="m17 22 10-7-4 12Z" fill={p.mint} />
      <Path d="m22 38 5-10m7 15 5-10" stroke={p.green} strokeWidth="3" strokeLinecap="round" />
      <Path d="m47 6-6 18M55 9 44 26" stroke={p.brown} strokeWidth="2.5" strokeLinecap="round" />
    </Plate>
  ),
  Greek: (
    <>
      <Path d="M10 19Q33 7 54 20L41 55H25Z" fill={p.gold} />
      <Path d="m12 23 8-7 9 5 7-7 8 5 9-1-9 22H24Z" fill={p.green} />
      <Path
        d="m22 22 6-2 13 18-6 3m-2-21 6-2 10 11-5 5"
        stroke={p.brown}
        strokeWidth="6"
        strokeLinecap="round"
      />
      <Circle cx="20" cy="24" r="4" fill={p.red} />
      <Circle cx="44" cy="23" r="4" fill={p.red} />
      <Path
        d="m21 24 8 4 6-4 7 5"
        stroke={p.rice}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
      <Path d="m12 31 17 11 18-6-6 20H25Z" fill={p.cream} />
      <Path d="m30 42 3 12" stroke={p.gold} strokeWidth="2" />
    </>
  ),
  Spanish: (
    <>
      <Path
        d="M9 31H3v12h10m42-12h6v12H51"
        fill="none"
        stroke={p.dark}
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <Ellipse cx="32" cy="36" rx="25" ry="20" fill={p.dark} />
      <Ellipse cx="32" cy="34" rx="21" ry="15" fill={p.gold} />
      <Path
        d="M19 23c-8 1-10 11-2 12l4-4c-5 0-5-4-1-4m18 9c8-4 14 4 8 9l-5-2c5-2 2-5 0-4"
        fill={p.coral}
      />
      <Path d="M33 20q13 6 3 14-10-1-3-14M26 34q9 9-3 13-8-6 3-13" fill={p.dark} />
      <Path d="m34 24 1 6m-9 8-1 5" stroke={p.blue} strokeWidth="2" strokeLinecap="round" />
      <Circle cx="25" cy="24" r="2" fill={p.green} />
      <Circle cx="17" cy="41" r="2" fill={p.green} />
      <Circle cx="47" cy="31" r="2" fill={p.green} />
    </>
  ),
  'Middle Eastern': (
    <Plate>
      <Ellipse cx="30" cy="34" rx="18" ry="12" fill={p.gold} />
      <Path
        d="M35 27c-17-6-24 12-7 14 12 2 16-12 5-12-9-1-13 8-5 8"
        stroke={p.cream}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
      <Circle cx="47" cy="21" r="8" fill={p.brown} />
      <Circle cx="52" cy="32" r="7" fill={p.crust} />
      <Path d="m44 20 3-3m4 14 3 2" stroke={p.green} strokeWidth="3" strokeLinecap="round" />
      <Path d="m9 17 13-8 2 16Z" fill={p.cream} />
      <Path d="M20 41q-8-8-11-2 1 8 11 2m0 0q-2 9 5 8 4-6-5-8" fill={p.green} />
      <Circle cx="30" cy="31" r="2" fill={p.red} />
    </Plate>
  ),
  Vietnamese: (
    <Bowl fill={p.plate}>
      <Ellipse cx="32" cy="27" rx="23" ry="10" fill={p.crust} />
      <Path
        d="M18 29c-9-11 31-12 26-2S17 21 18 29m4-8c1 11 23 12 21 1"
        fill="none"
        stroke={p.cream}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <Path d="m13 20 10-7 6 6-9 8" fill={p.brown} />
      <Path d="M36 24q-5-10 2-11 8 1 4 10m0 0q7-10 11-3-1 7-11 3" fill={p.green} />
      <Path d="m41 6-3 14M53 7 43 21" stroke={p.brown} strokeWidth="2.5" strokeLinecap="round" />
      <Circle cx="29" cy="26" r="3" fill={p.red} />
    </Bowl>
  ),
  Turkish: (
    <>
      <Ellipse cx="32" cy="48" rx="26" ry="8" fill={p.plate} />
      <Path d="M8 38Q31 26 54 36L48 47H15Z" fill={p.cream} />
      <Path d="m16 11 30 40M32 8 22 44" stroke={p.brown} strokeWidth="2.5" strokeLinecap="round" />
      <Path d="m18 15 8 10-7 6-8-11Zm11 15 9 10-7 6-9-11Z" fill={p.crust} />
      <Path d="m29 13 10 3-3 11-10-3Zm-5 17 10 3-3 10-10-3Z" fill={p.brown} />
      <Path d="m23 23 5-4 5 6-5 4" fill={p.red} />
      <Path d="m26 25 11 3-2 5-10-3" fill={p.green} />
      <Path d="m42 20 11 6-6 8-11-6Z" fill={p.red} />
      <Path d="m16 18 4 5m11 12 4 5" stroke={p.gold} strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  Moroccan: (
    <>
      <Ellipse cx="32" cy="48" rx="27" ry="10" fill={p.brown} />
      <Path d="M5 43h54l-5 9c-12 7-32 7-44 0Z" fill={p.crust} />
      <Path d="M10 41 28 10h8l18 31q-21 11-44 0Z" fill={p.coral} />
      <Path d="M18 40 30 17" stroke={p.cream} strokeWidth="3" strokeLinecap="round" opacity=".7" />
      <Path d="M14 35q18 9 36 0m-30-9q12 5 24 0" stroke={p.crust} strokeWidth="2" fill="none" />
      <Rect x="26" y="7" width="12" height="7" rx="3" fill={p.brown} />
      <Path d="M16 48q16 6 32 0" stroke={p.gold} strokeWidth="2" fill="none" />
    </>
  ),
  Ethiopian: (
    <>
      <Circle cx="32" cy="33" r="27" fill={p.crust} />
      <Circle cx="32" cy="32" r="24" fill={p.cream} />
      <Path
        d="M15 20h3m24-3h3M11 37h2m38-7h2M36 51h2m-17-3h2"
        stroke={p.gold}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <Path d="M22 17c12-4 19 6 10 12s-20-7-10-12Z" fill={p.red} />
      <Path d="M39 25c12-2 15 15 4 17S30 30 39 25Z" fill={p.green} />
      <Path d="M20 34c9-5 18 7 8 13s-19-7-8-13Z" fill={p.gold} />
      <Ellipse cx="15" cy="29" rx="5" ry="6" fill={p.brown} />
      <Circle cx="28" cy="22" r="3.5" fill={p.rice} />
      <Path d="m38 31 5 5m-23 3 5 2" stroke={p.mint} strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  Jamaican: (
    <Plate>
      <Path d="M13 25c-4-11 15-12 21-6 6 5 4 15-5 20l-9 6-10-9Z" fill={p.brown} />
      <Path
        d="m17 24 10 5m-12 2 8 5m4-16 7 6"
        stroke={p.crust}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <Path
        d="M42 26q-6 9 4 16M50 28q-3 10 4 11"
        stroke={p.gold}
        strokeWidth="7"
        fill="none"
        strokeLinecap="round"
      />
      <Path d="m39 15 13 4-8 7Z" fill={p.green} />
      <Path d="m43 18 6 2-5 4Z" fill={p.mint} />
      <Path d="m24 43 5-8m-9-12 5-4" stroke={p.green} strokeWidth="2.5" strokeLinecap="round" />
    </Plate>
  ),
  Brazilian: (
    <Bowl fill={p.green}>
      <Ellipse cx="32" cy="28" rx="23" ry="10" fill={p.brown} />
      <Path d="M12 27c-1-12 22-12 22 2Z" fill={p.rice} />
      <Path d="m17 23 3 1m4-3 3 1" stroke={p.cream} strokeWidth="2" strokeLinecap="round" />
      <Ellipse cx="39" cy="25" rx="4" ry="2.5" fill={p.dark} />
      <Ellipse cx="45" cy="29" rx="4" ry="2.5" fill={p.dark} />
      <Path d="M41 18 51 9a14 14 0 0 1 8 16Z" fill={p.gold} />
      <Path d="m46 17 5-5 4 9Z" fill={p.cream} />
      <Path d="m33 22 4-7 7 4-5 4" fill={p.green} />
    </Bowl>
  ),
  Peruvian: (
    <Bowl fill={p.blue}>
      <Path d="m11 24 7-7 9 4-4 10m10-9 9-5 6 10-10 5" fill={p.rice} />
      <Path d="m18 22 4 2m14 2 4 2" stroke={p.coral} strokeWidth="2" strokeLinecap="round" />
      <Path
        d="M22 17c-1-11 19-8 18 2M20 22c0-10 17-8 17 1"
        fill="none"
        stroke="#A77997"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <Path d="m45 18 11-9 5 14Z" fill={p.green} />
      <Path d="m49 18 6-5 2 8Z" fill={p.mint} />
      <Circle cx="17" cy="28" r="3" fill={p.gold} />
      <Circle cx="28" cy="25" r="2" fill={p.green} />
      <Path d="m44 24 6 3-3 3-6-3" fill={p.red} />
    </Bowl>
  ),
  Indonesian: (
    <Plate>
      <Path d="M13 39q0-21 19-21t19 21Z" fill={p.crust} />
      <Path
        d="m21 31 4 2m4 4 3-2m9 2 3-2m-4-9 3 2"
        stroke={p.gold}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <Path d="M20 19c2-9 16-10 21-3 11 3 8 18-3 17-10 7-27-5-18-14Z" fill={p.rice} />
      <Circle cx="32" cy="23" r="6.5" fill={p.gold} />
      <Circle cx="50" cy="43" r="6" fill={p.green} />
      <Circle cx="50" cy="43" r="3.5" fill={p.mint} />
      <Path d="m12 40 6-3 4 7-6 3" fill={p.red} />
    </Plate>
  ),
  Filipino: (
    <Plate>
      <Path d="M10 30q3-14 17-13c9 0 12 9 9 15Z" fill={p.rice} />
      <Path d="M25 30c4-13 25-11 28 0 3 8-5 17-13 14l-8 5-13-8Z" fill={p.brown} />
      <Path
        d="M31 31q8-10 16-3m-20 8 10 6"
        stroke={p.crust}
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
      />
      <Path d="M35 22q9-14 15-7-2 9-15 7" fill={p.green} />
      <Circle cx="43" cy="36" r="1.5" fill={p.dark} />
      <Circle cx="33" cy="29" r="1.5" fill={p.dark} />
      <Circle cx="14" cy="42" r="6" fill={p.green} />
      <Circle cx="14" cy="42" r="3.5" fill={p.gold} />
    </Plate>
  ),
  American: (
    <>
      <Path d="M9 27C8 4 56 4 55 27Z" fill={p.gold} />
      <Path
        d="m23 17 2-2m9 2 2 1m6 0 2 2"
        stroke={p.cream}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <Path d="m7 30 9-4 8 4 8-3 8 3 9-4 8 4-4 6H11Z" fill={p.green} />
      <Rect x="8" y="34" width="48" height="6" rx="3" fill={p.red} />
      <Rect x="7" y="39" width="50" height="9" rx="4.5" fill={p.brown} />
      <Path d="m13 38 17 12 17-12Z" fill={p.gold} />
      <Path d="M9 49h46q0 9-10 9H19Q9 58 9 49Z" fill={p.gold} />
      <Path d="M14 52h35" stroke={p.cream} strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  Russian: (
    <>
      <Ellipse cx="32" cy="49" rx="27" ry="8" fill={p.plate} />
      <Ellipse cx="30" cy="42" rx="23" ry="11" fill={p.crust} />
      <Ellipse cx="30" cy="38" rx="23" ry="10" fill={p.gold} />
      <Path d="M9 38q20 9 42 0M10 43q20 9 40 0" fill="none" stroke={p.cream} strokeWidth="2" />
      <Ellipse cx="30" cy="32" rx="23" ry="11" fill={p.crust} />
      <Ellipse cx="30" cy="30" rx="23" ry="10" fill={p.gold} />
      <Path
        d="M15 29q13-6 26 0"
        stroke={p.cream}
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
      <Path d="M27 27c-6-5 1-12 6-10 7-4 14 6 8 11Z" fill={p.rice} />
      <Circle cx="38" cy="22" r="2.5" fill={p.red} />
      <Circle cx="44" cy="25" r="2.5" fill={p.red} />
      <Path d="M25 20q-11-1-8-8 8-1 8 8m0 0q-3-10 5-11 5 8-5 11" fill={p.green} />
    </>
  ),
  Ukrainian: (
    <Bowl fill={p.plate}>
      <Ellipse cx="32" cy="27" rx="23" ry="10" fill="#9E3849" />
      <Path
        d="m17 26 7-6m14 4 9 4m-23 1 4-5"
        stroke={p.coral}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <Path d="M24 25c-3-5 6-11 10-6 8-1 10 8 1 10Z" fill={p.rice} />
      <Path
        d="m32 21 1-12m0 6-5-4m5 7 5-5"
        stroke={p.green}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <Path d="m47 4 6 2-5 20-5-2Z" fill={p.brown} />
    </Bowl>
  ),
  Georgian: (
    <>
      <Path d="M4 34Q12 11 32 9q20 2 28 25-9 23-28 23T4 34Z" fill={p.crust} />
      <Path d="M9 33Q20 16 32 15t23 18Q43 51 32 51T9 33Z" fill={p.gold} />
      <Path d="M13 33q12-13 19-12t19 12Q37 45 32 45T13 33Z" fill={p.cream} />
      <Path d="M25 25c6-6 20-1 19 8 2 9-15 12-20 5-7-4-6-11 1-13Z" fill={p.rice} />
      <Circle cx="32" cy="33" r="7" fill={p.gold} />
      <Path d="m17 36 4 2m22-11 3 2" stroke={p.crust} strokeWidth="2" strokeLinecap="round" />
      <Path d="m40 42 5-4" stroke={p.green} strokeWidth="3" strokeLinecap="round" />
    </>
  ),
  Polish: (
    <Plate>
      <Path d="M9 28q4-19 21-9 7 14-21 9Z" fill={p.gold} />
      <Path
        d="M12 26q5-13 15-7"
        fill="none"
        stroke={p.cream}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <Path d="M31 30q7-22 23-5 2 15-23 5Z" fill={p.gold} />
      <Path
        d="M35 28q5-13 14-6"
        fill="none"
        stroke={p.cream}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <Path d="M18 42q7-20 25-5 0 16-25 5Z" fill={p.gold} />
      <Path
        d="M22 41q7-12 16-6"
        fill="none"
        stroke={p.cream}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <Path
        d="m22 19 3 3m20 3 3 3m-14 7 2 3"
        stroke={p.crust}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <Path d="m15 35 4-3m28 10 3 2" stroke={p.green} strokeWidth="3" strokeLinecap="round" />
    </Plate>
  ),
  German: (
    <>
      <Path
        d="M31 44C6 47 3 12 18 12c12 0 14 30 26 30 18 0 17-30 4-30-13 0-16 32-29 32C8 44 14 57 31 50c17 8 27-9 19-14"
        fill="none"
        stroke={p.crust}
        strokeWidth="11"
        strokeLinecap="round"
      />
      <Path
        d="M31 42C9 43 8 17 17 17c9 0 12 28 27 28 15 0 15-29 4-29-9 0-17 31-29 31"
        fill="none"
        stroke={p.gold}
        strokeWidth="6"
        strokeLinecap="round"
      />
      <Path
        d="m13 24 3 1m4-7 1 3m28 0 3 1M15 37l2 2m26 7 3-1m-17 3 2 1"
        stroke={p.rice}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </>
  ),
  British: (
    <Plate>
      <Path
        d="m36 16 5-2 8 29-5 2m-4-29 5-1 7 27-5 2M32 20l5-1 6 27-5 1"
        stroke={p.gold}
        strokeWidth="4"
        strokeLinejoin="round"
      />
      <Path d="M12 19c10-8 24 3 19 15l-6 15-13-3-3-13Z" fill={p.crust} />
      <Path d="M15 21c7-5 16 4 12 12l-5 11-8-1-2-12Z" fill={p.gold} />
      <Path d="m16 28 4-1m-5 10 4 1" stroke={p.cream} strokeWidth="3" strokeLinecap="round" />
      <Circle cx="43" cy="45" r="3" fill={p.green} />
      <Circle cx="50" cy="43" r="3" fill={p.green} />
      <Circle cx="48" cy="49" r="3" fill={p.mint} />
    </Plate>
  ),
  Portuguese: (
    <>
      <Ellipse cx="32" cy="50" rx="26" ry="7" fill={p.plate} />
      <Path d="m7 29 5 20q20 13 40 0l5-20Z" fill={p.crust} />
      <Path
        d="m14 34 3 16m5-14 2 17m8-16v18m9-19-2 17m10-19-3 16"
        stroke={p.gold}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <Ellipse cx="32" cy="28" rx="25" ry="16" fill={p.gold} />
      <Ellipse cx="32" cy="28" rx="20" ry="12" fill={p.cream} />
      <Path d="M18 23q7-8 12-3l-2 5-8 3m19-9q9 2 10 9l-8 3-6-5m-11 9 6-5 7 4-4 5" fill={p.crust} />
      <Circle cx="35" cy="22" r="2" fill={p.gold} />
    </>
  ),
  Lebanese: (
    <Plate>
      <Path d="M11 29q6-12 17-11t22 13l-9 15-24-4Z" fill={p.green} />
      <Path
        d="m20 22 5 4m10-4 3 5m-12 7 4 3m12-5 4 3m-25 0 2 5"
        stroke={p.mint}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <Path d="m16 29 6-2 3 6-6 2m15 1 7-1 2 7-7 1m0-19 6-2 3 6-6 2" fill={p.red} />
      <Path
        d="m28 21 2 2m-3 6 2 2m4 8 2 2m-12 0 2 2m19-12 2 2"
        stroke={p.cream}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <Path d="m8 18 9-9 8 13Z" fill={p.gold} />
      <Path d="m12 18 5-5 4 6Z" fill={p.cream} />
    </Plate>
  ),
  Iranian: (
    <Plate>
      <Path d="M13 37q2-22 19-22t19 22q-19 12-38 0Z" fill={p.rice} />
      <Path d="M24 20q7-8 14-1l5 17-7 6-8-2Z" fill={p.gold} />
      <Path
        d="m18 30 3 2m19-7 3 2m-24 9 3 1m22 1 3-1m-18-9 3 2m3-10 2 2"
        stroke={p.cream}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <Path
        d="m26 33 2 2m8-8 2 2m-5 11 2-2m-7-14 2 2"
        stroke={p.red}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <Path d="m12 22 3-7m31 27 3-6" stroke={p.green} strokeWidth="3" strokeLinecap="round" />
    </Plate>
  ),
  Nigerian: (
    <Plate>
      <Path d="M11 37q0-23 19-23t20 24q-23 15-39-1Z" fill={p.red} />
      <Path
        d="m20 24 3 2m8-6 3 2m6 8 3 2m-25 1 3 2m8-8 3 2m-6 7 3 2m11-1 3 2m-15 2 3 2"
        stroke={p.coral}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <Path
        d="M46 22q-7 9 3 16M52 24q-3 6 2 9"
        stroke={p.gold}
        strokeWidth="6"
        strokeLinecap="round"
        fill="none"
      />
      <Path d="m20 35 5 2m11-17 4 2" stroke={p.green} strokeWidth="3" strokeLinecap="round" />
    </Plate>
  ),
  Malaysian: (
    <>
      <Path d="M4 40 15 12l41 7 4 26-30 13Z" fill={p.green} />
      <Path
        d="m9 42 42-19M20 35l-2-13m13 7 2-10m-5 15 12 11"
        stroke={p.mint}
        strokeWidth="1.5"
        fill="none"
      />
      <Path d="M16 37q0-21 15-21t16 21q-15 10-31 0Z" fill={p.rice} />
      <Ellipse cx="17" cy="44" rx="8" ry="5" fill={p.red} />
      <Ellipse cx="48" cy="38" rx="7" ry="10" fill={p.rice} />
      <Ellipse cx="48" cy="38" rx="4" ry="5" fill={p.gold} />
      <Circle cx="34" cy="47" r="5" fill={p.mint} />
      <Circle cx="34" cy="47" r="2.5" fill={p.cream} />
      <Path d="m19 26 2 2m8 2 2-2" stroke={p.cream} strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  Argentinian: (
    <>
      <Ellipse cx="32" cy="49" rx="27" ry="8" fill={p.plate} />
      <Path d="M6 35q10-28 33-10Q33 48 6 35Z" fill={p.crust} />
      <Path d="M10 33q11-20 25-7Q26 42 10 33Z" fill={p.gold} />
      <Path
        d="m12 29 2 3m5-8 1 4m6-4-1 4m7-1-2 3"
        stroke={p.cream}
        strokeWidth="2"
        strokeLinecap="round"
      />
      <Path d="M24 46q11-29 34-10Q50 59 24 46Z" fill={p.crust} />
      <Path d="M28 44q11-20 25-7Q43 53 28 44Z" fill={p.gold} />
      <Path
        d="m31 40 2 3m5-8 1 4m6-4-1 4m7-1-2 3"
        stroke={p.cream}
        strokeWidth="2"
        strokeLinecap="round"
      />
    </>
  ),
  Caribbean: (
    <>
      <Path d="M8 25Q29 5 55 20l-2 26-33 10Z" fill={p.green} />
      <Path d="m15 31 31-7m-24 6 2 16m9-18 4 17" stroke={p.mint} strokeWidth="2" fill="none" />
      <Path d="M16 31q0-10 13-11t20 14q-6 17-23 13-12-4-10-16Z" fill={p.gold} />
      <Path
        d="m21 29 11-2m-10 8 15-4m-9 11 12-5"
        stroke={p.crust}
        strokeWidth="3"
        strokeLinecap="round"
      />
      <Path d="m40 15 10-8 8 13Z" fill={p.gold} />
      <Path d="m45 15 5-4 4 6Z" fill={p.cream} />
    </>
  ),
  Mediterranean: (
    <Plate>
      <Path d="M13 33q15-20 33-2l11-9v23l-11-8q-18 17-33-4Z" fill={p.blue} />
      <Path d="M28 25q-6 8 0 16m7-14q-5 6 0 12" stroke={p.plate} strokeWidth="2" fill="none" />
      <Circle cx="20" cy="32" r="2" fill={p.dark} />
      <Path d="M14 16 26 8a14 14 0 0 1 6 14Z" fill={p.gold} />
      <Path d="m19 16 6-4 3 7Z" fill={p.cream} />
      <Path
        d="M20 49q12-3 21-1m-16 0-1-5m8 5 1-5m3 5 4 4"
        stroke={p.green}
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
      />
    </Plate>
  ),
  Asian: (
    <Bowl>
      <Path
        d="M13 27c-4-12 35-14 34-2s-29 10-30 0 25-9 24 0-18 6-18 0 13-5 11 0"
        stroke={p.gold}
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
      <Path d="m30 4 4 17M42 4l-3 18" stroke={p.brown} strokeWidth="2.5" strokeLinecap="round" />
      <Path d="M30 16v9m5-8v8" stroke={p.gold} strokeWidth="2" strokeLinecap="round" />
      <Path d="M43 24q-2-12 5-10 5 5-5 10" fill={p.green} />
    </Bowl>
  ),
  Other: (
    <>
      <Ellipse cx="32" cy="53" rx="26" ry="5" fill={p.plate} />
      <Path d="M9 34h46v10q-2 12-23 12T9 44Z" fill={p.coral} />
      <Path
        d="M9 36H3v9h8m44-9h6v9H53"
        stroke={p.brown}
        strokeWidth="3"
        fill="none"
        strokeLinejoin="round"
      />
      <Path
        d="M7 31h50M13 29q2-13 19-13t19 13"
        stroke={p.brown}
        strokeWidth="4"
        strokeLinecap="round"
        fill={p.gold}
      />
      <Rect x="27" y="10" width="10" height="6" rx="3" fill={p.brown} />
      <Path
        d="M18 40v5q0 5 7 5"
        fill="none"
        stroke={p.cream}
        strokeWidth="3"
        strokeLinecap="round"
      />
    </>
  ),
};

export function CuisineIcon({ name, size = 28 }: { name: string; size?: number }) {
  const key = cuisineFilters.find((c) => c.toLowerCase() === name.trim().toLowerCase()) || 'Other';
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      accessible={Platform.OS === 'web' ? undefined : false}
      aria-hidden
    >
      <G>{illustrations[key]}</G>
    </Svg>
  );
}
