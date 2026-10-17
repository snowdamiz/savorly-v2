import { useChrome } from './ui';

// The sous-chef's corner: its launcher sits here, and in a desktop browser the panel pops out of it.
// Apart from RecipeStudio, so the shell can place the launcher without loading the sous-chef itself
// (a separate chunk on the web, loaded the first time it opens).
export function useSousChefDock() {
  const { compact, width, height, insets, webPage } = useChrome();
  const bar = Math.min(width - 32, 400);
  return {
    right: compact ? (width - bar) / 2 : 28,
    // Phones keep it above the tab bar.
    bottom: compact ? Math.max(16, insets.bottom) + 82 : 28,
    /** The floating panel, clear of the header; the apps and narrow windows use a sheet instead. */
    panel: webPage ? { width: 400, height: Math.min(680, height - 128) } : null,
  };
}
