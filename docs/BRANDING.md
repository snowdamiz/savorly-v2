# Savorly — The Curious Chef

The selected identity pairs chef-hat concept **06, The Curious Chef**, with a flowing, hand-lettered
`savorly` wordmark for the web sidebar and standalone brand artwork. Mobile screens and sheets
use only the chef icon, directly on the surrounding surface without a colored tile.
The tilted crown, curved fold, raised eyebrows, and visible pupils preserve the chosen character.
The logo palette is charcoal (`#1B1C1A`) and cream (`#F7F8F5`).

![Curious Chef logo and platform variants](brand/preview.png)

## Artwork and use

- `apps/mobile/assets/brand-artwork.json` is the shared vector source for the app and icon renderer.
- `BrandMark` and `BrandWordmark` in `src/components/Brand.tsx` render the shared artwork with the
  existing `react-native-svg` dependency. The wordmark is outlined artwork and requires no additional font.
- The web sidebar shows the chef and wordmark together. The welcome screen, sign-in dialog,
  signed-out kitchen, and native navigation use only the chef icon, without a background tile. Cooking
  controls and recipe placeholders keep their functional Lucide icons.
- `brand-mark.svg` and `brand-wordmark.svg` are transparent exports. `brand.svg` is the square
  app icon with its neutral cream background.
- The approved chef concept sheet and its built-in image-generation prompt are in `docs/brand/`.
  The large **06** drawing was traced directly into clean vector paths; the handwritten wordmark
  retains its existing artwork and transparent master. Production rendering requires no image service.
- The loading screen animates the eyes and pupils together over the solid hat, with the blink
  centered on the chef's eye position. The eyebrows stay still.

## Regenerate platform assets

After installing the mobile app's existing dependencies, run from the repository root:

```sh
npm run brand
```

The renderer uses installed Google Chrome locally and Playwright Chromium in CI. It emits the
SVG exports and these PNGs:

| Asset                         | Size        | Use                                                                   |
| ----------------------------- | ----------- | --------------------------------------------------------------------- |
| `icon.png`                    | 1024 × 1024 | Opaque iOS / default app icon                                         |
| `favicon.png`                 | 64 × 64     | Browser icon, with a larger chef to retain facial detail at 16–32 px  |
| `android-icon-foreground.png` | 512 × 512   | Transparent adaptive foreground                                       |
| `android-icon-monochrome.png` | 512 × 512   | Alpha-only themed icon with light-detail cutouts and opaque pupils    |
| `splash-icon.png`             | 1024 × 1024 | Native launch frame matching the animated splash's resting chef and shadow |

Android's adaptive background in `app.json` must match the cream brand color; the renderer checks
this. The adaptive chef is smaller than the default icon to fit the guaranteed 66/108 safe circle.
See [Android's adaptive icon guidelines](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive).
Launcher icon changes require a new native build; updating JavaScript alone does not replace the
installed launcher icon. See [Expo's icon documentation](https://docs.expo.dev/develop/user-interface/splash-screen-and-app-icon/).

The native splash uses the app's `#F4F4F4` background and a 160px image. It stays visible until
the animated overlay is laid out; both frames share the same chef size, position and shadow.
Changing this native splash configuration requires a new app build, not just an OTA update.
