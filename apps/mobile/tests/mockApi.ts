import type { Locator, Page, Request } from '@playwright/test';
import type {
  Capabilities,
  Creator,
  Kitchen,
  Library,
  LibraryPage,
  Recipe,
  Review,
  User,
} from '../src/lib/types';

// An in-memory Savorly API for browser tests: what the page sends changes what it reads next. It
// answers the session both ways the app asks for it (GET /me, and GET /session with
// `{ user: <me> | null }`), keeps the library and kitchen, and records every request. A test adds
// its own answers with `on()`, which are tried first, newest first.

/** One request the app made, with its path below /v1 and its JSON body (if any). */
export type Sent = { method: string; path: string; query: URLSearchParams; body: unknown };
export type Reply = { status: number; json?: unknown };
export const json = (body: unknown, status = 200): Reply => ({ status, json: body });
export const empty = (status = 204): Reply => ({ status });
/** An error as the API sends it: `{ "error": "A readable message" }`. */
export const failure = (status: number, error: string): Reply => ({ status, json: { error } });

export type Call = Sent & { params: string[]; request: Request };
type Handler = {
  method: string;
  path: string | RegExp;
  answer: (call: Call) => Reply | void | Promise<Reply | void>;
};

export const me: User = {
  id: 'me',
  name: 'Alex',
  handle: 'alex',
  bio: '',
  avatar: '',
  email: 'alex@example.test',
  emailVerified: true,
  preferences: { diets: [], allergies: [] },
  hasPassword: true,
  identities: [],
  plan: 'free',
  onboarded: true,
};
/** The signed-in cook as a recipe's author. */
export const alex: Creator = { id: 'me', name: 'Alex', handle: 'alex', bio: '', avatar: '' };
export const robin: Creator = {
  id: 'robin',
  name: 'Robin',
  handle: 'robin',
  bio: '',
  avatar: '',
  recipeCount: 1,
  followerCount: 0,
};
/** A published recipe by Robin unless `fields` say otherwise. */
export const recipe = (fields: Partial<Recipe> & Pick<Recipe, 'id' | 'title'>): Recipe => ({
  description: 'A recipe for the tests.',
  cuisine: 'Italian',
  minutes: 20,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  photos: [],
  video: '',
  ingredients: [{ name: 'Lemon', amount: 1, unit: '', category: 'Produce' }],
  steps: [{ title: 'Cook', text: 'Cook it until it is done.', seconds: 0 }],
  tags: [],
  calories: 200,
  aiGenerated: false,
  published: true,
  author: robin,
  rating: 0,
  reviewCount: 0,
  saveCount: 0,
  createdAt: '2026-10-01T12:00:00Z',
  ...fields,
});

export type MockOptions = {
  /** Signed in as `user` (the default) or a guest. */
  signedIn?: boolean;
  user?: Partial<User>;
  recipes?: Recipe[];
  creators?: Creator[];
  library?: Partial<Library>;
  kitchen?: Partial<Kitchen>;
  capabilities?: Partial<Capabilities>;
  reviews?: Record<string, Review[]>;
};

export async function mockApi(page: Page, options: MockOptions = {}) {
  const state = {
    session: options.signedIn ?? true,
    /** False aborts every API request, as a network that's down would. */
    online: true,
    user: structuredClone({ ...me, ...options.user }) as User,
    recipes: structuredClone(options.recipes ?? []),
    creators: structuredClone(options.creators ?? [robin]),
    library: structuredClone({
      savedIds: [],
      saves: [],
      collections: [],
      followingIds: [],
      recipes: [],
      cookedIds: [],
      ...options.library,
    }) as Library,
    kitchen: structuredClone({ plans: [], groceries: [], pantry: [], ...options.kitchen }),
    capabilities: structuredClone(options.capabilities ?? {}),
    reviews: structuredClone(options.reviews ?? {}),
  };
  const requests: Sent[] = [];
  const handlers: Handler[] = [];
  const known = () => {
    const all = [...state.library.recipes, ...state.recipes];
    return all.filter((r, i) => all.findIndex((x) => x.id === r.id) === i);
  };
  const shelf = (query: URLSearchParams): LibraryPage => {
    const offset = Number(query.get('offset') || 0);
    const limit = Number(query.get('limit') || 24);
    const collection = query.get('collection');
    const saved = (r: Recipe) =>
      state.library.saves.some(
        (v) => v.recipeId === r.id && (!collection || v.collectionId === collection),
      );
    const mine = (r: Recipe) => r.author.id === state.user.id;
    const scope = query.get('scope');
    const list = known().filter((r) =>
      scope === 'mine' ? mine(r) : scope === 'saved' || collection ? saved(r) : saved(r) || mine(r),
    );
    return { recipes: list.slice(offset, offset + limit), hasMore: list.length > offset + limit };
  };
  const signedIn = (reply: () => Reply) =>
    state.session ? reply() : failure(401, 'Sign in to continue.');
  const answer = ({ method, path, query }: Sent): Reply => {
    if (method === 'GET') {
      if (path === '/session') return json({ user: state.session ? state.user : null });
      if (path === '/me') return signedIn(() => json(state.user));
      if (path === '/capabilities') return json(state.capabilities);
      if (path === '/recipes') {
        const author = query.get('author');
        const q = (query.get('q') || '').toLowerCase();
        return json(
          state.recipes.filter(
            (r) => (!author || r.author.id === author) && r.title.toLowerCase().includes(q),
          ),
        );
      }
      if (path === '/feed')
        return json({
          hero: state.recipes[0] ?? null,
          trending: state.recipes,
          quick: [],
          following: [],
          newest: state.recipes,
        });
      if (path === '/creators') return json(state.creators);
      if (path === '/library') return signedIn(() => json(state.library));
      if (path === '/library/recipes') return signedIn(() => json(shelf(query)));
      if (path === '/kitchen')
        return signedIn(() => {
          const from = query.get('from');
          const to = query.get('to');
          const plans = state.kitchen.plans.filter(
            (p) => (!from || p.day >= from) && (!to || p.day <= to),
          );
          return json({ ...state.kitchen, plans });
        });
      if (path === '/household') return signedIn(() => json(null));
      const one = /^\/recipes\/([^/]+)(\/[^/]+)?$/.exec(path);
      if (one) {
        const id = decodeURIComponent(one[1]);
        if (!one[2]) {
          const found = known().find((r) => r.id === id);
          return found ? json(found) : failure(404, 'This item could not be found.');
        }
        if (one[2] === '/reviews') return json(state.reviews[id] ?? []);
      }
      return json([]);
    }
    if (method === 'POST' && path === '/auth/logout') {
      state.session = false;
      return empty();
    }
    if (method === 'POST' && (path === '/events' || path === '/client-errors')) return empty();
    return json({ ok: true });
  };
  await page.route('**/v1/**', async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': request.headers().origin ?? '*',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        },
      });
    const url = new URL(request.url());
    const path = url.pathname.replace(/^.*?\/v1(?=\/)/, '');
    let body: unknown;
    const text = request.postData();
    if (text)
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    const sent: Sent = { method, path, query: url.searchParams, body };
    requests.push(sent);
    if (!state.online) return route.abort('failed');
    let reply: Reply | void = undefined;
    for (const h of handlers) {
      if (h.method !== method) continue;
      const match =
        typeof h.path === 'string' ? (h.path === path ? [path] : null) : h.path.exec(path);
      if (!match) continue;
      reply = await h.answer({ ...sent, params: match.slice(1), request });
      if (reply) break;
    }
    reply ??= answer(sent);
    return reply.json === undefined
      ? route.fulfill({ status: reply.status, body: '' })
      : route.fulfill({
          status: reply.status,
          contentType: 'application/json',
          body: JSON.stringify(reply.json),
        });
  });
  return {
    state,
    requests,
    /** Answers `method path` (a path below /v1, or a pattern whose groups become `params`). */
    on(method: string, path: string | RegExp, answer: Handler['answer']) {
      handlers.unshift({ method, path, answer });
    },
    /** The requests to `path` other than reads, as `[method, body]`. */
    sentTo(path: string | RegExp) {
      return requests
        .filter(
          (r) =>
            r.method !== 'GET' && (typeof path === 'string' ? r.path === path : path.test(r.path)),
        )
        .map((r) => [r.method, r.body] as const);
    },
  };
}

/** A recipe card ("View <title>"), whether it's a button or, with recipe pages at their own
 * addresses, a link. */
export const recipeCard = (page: Page, title: string): Locator =>
  page
    .getByRole('button', { name: `View ${title}`, exact: true })
    .or(page.getByRole('link', { name: `View ${title}`, exact: true }));
