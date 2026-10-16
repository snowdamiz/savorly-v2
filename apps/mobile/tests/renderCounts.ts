import { Page } from '@playwright/test';

// Observe committed renders in the real development app, without adding production counters.
// This uses the same PerformedWork flag and unchanged-child bailout as the installed React
// DevTools backend (react-devtools-core/dist/backend.js). Revisit when upgrading React.
export async function observeRenders(page: Page) {
  await page.addInitScript(() => {
    type Fiber = {
      type: { name?: string; displayName?: string } | null;
      flags: number;
      child: Fiber | null;
      sibling: Fiber | null;
      alternate: Fiber | null;
    };
    const counts: Record<string, number> = {};
    const names = new Set([
      'Shell',
      'Discover',
      'RecipeGrid',
      'RecipeTile',
      'RecipeRow',
      'Save',
      'RecipeDetail',
      'Toast',
    ]);
    const visit = (fiber: Fiber) => {
      const name = fiber.type?.displayName || fiber.type?.name;
      if (name && names.has(name) && (fiber.flags & 1) !== 0) {
        counts[name] = (counts[name] || 0) + 1;
      }
      if (fiber.child !== fiber.alternate?.child) {
        for (let child = fiber.child; child; child = child.sibling) visit(child);
      }
    };
    Object.assign(window, {
      renderCounts: counts,
      __REACT_DEVTOOLS_GLOBAL_HOOK__: {
        supportsFiber: true,
        renderers: new Map(),
        inject(renderer: unknown) {
          const id = this.renderers.size + 1;
          this.renderers.set(id, renderer);
          return id;
        },
        onCommitFiberRoot(_id: number, root: { current: Fiber }) {
          visit(root.current);
        },
        onCommitFiberUnmount() {},
      },
    });
  });
}

export const renderCounts = (page: Page) =>
  page.evaluate(() => ({
    ...(window as unknown as { renderCounts: Record<string, number> }).renderCounts,
  }));

export const resetRenderCounts = (page: Page) =>
  page.evaluate(() => {
    const counts = (window as unknown as { renderCounts: Record<string, number> }).renderCounts;
    for (const name of Object.keys(counts)) delete counts[name];
  });
