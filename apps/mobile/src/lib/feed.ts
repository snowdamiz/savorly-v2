import type { Recipe } from './types';

/** GET /feed: the home's shelves, ranked by the server. */
export type Feed = {
  hero: Recipe | null;
  trending: Recipe[];
  quick: Recipe[];
  following: Recipe[];
  newest: Recipe[];
};

const isRecipe = (value: unknown): value is Recipe =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as Recipe).id === 'string' &&
  typeof (value as Recipe).title === 'string';
const recipes = (value: unknown) => (Array.isArray(value) ? value.filter(isRecipe) : []);

/** The feed in an answer, or null when it isn't one (anything but the shape GET /feed sends). */
export function parseFeed(value: unknown): Feed | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.trending) || !Array.isArray(v.quick)) return null;
  return {
    hero: isRecipe(v.hero) ? v.hero : null,
    trending: recipes(v.trending),
    quick: recipes(v.quick),
    following: recipes(v.following),
    newest: recipes(v.newest),
  };
}

/** What the home shows. Each recipe is on screen once: no shelf repeats an earlier one's. */
export type Shelves = {
  hero: Recipe | undefined;
  trending: Recipe[];
  quick: Recipe[];
  following: Recipe[];
};

/**
 * The home's shelves, from the server's feed when there is one. Without it (an older server, or
 * the request failed) they are worked out from the recipes the app has, as the app always did:
 * the most saved for trending, the quickest for weeknights, the followed kitchens' for following.
 * `counts` are how many each shelf shows, so a recipe one shelf leaves out can appear in the next.
 */
export function homeShelves(
  feed: Feed | null,
  all: Recipe[],
  followingIds: string[],
  counts: { trending: number; quick: number; following: number },
): Shelves {
  const shown = new Set<string>();
  const take = (list: Recipe[], count: number) => {
    const picked: Recipe[] = [];
    for (const recipe of list) {
      if (picked.length >= count) break;
      if (shown.has(recipe.id)) continue;
      shown.add(recipe.id);
      picked.push(recipe);
    }
    return picked;
  };
  const hero = feed
    ? (feed.hero ?? feed.trending[0] ?? feed.newest[0])
    : (all.find((r) => r.id === 'lemon-ricotta-pasta') ?? all[0]);
  if (hero) shown.add(hero.id);
  if (feed)
    return {
      hero,
      trending: take(feed.trending, counts.trending),
      quick: take(feed.quick, counts.quick),
      // Kitchens unfollowed since the feed came leave at once.
      following: take(
        feed.following.filter((r) => followingIds.includes(r.author?.id)),
        counts.following,
      ),
    };
  return {
    hero,
    trending: take(
      [...all].sort((a, b) => b.saveCount - a.saveCount || b.rating - a.rating),
      counts.trending,
    ),
    quick: take(
      [...all].sort((a, b) => a.minutes - b.minutes),
      counts.quick,
    ),
    following: take(
      all.filter((r) => followingIds.includes(r.author?.id)),
      counts.following,
    ),
  };
}
