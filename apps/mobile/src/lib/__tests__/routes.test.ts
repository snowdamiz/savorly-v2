/// <reference types="jest" />
import { Platform } from 'react-native';
import {
  cookbookPath,
  cookbookUrl,
  cookPath,
  linkHosts,
  linkTo,
  pagePath,
  parseRoute,
  pressedInApp,
  recipePath,
  recipeUrl,
} from '../routes';

const web = Platform.OS === 'web';
const recipe = (id: string, legacy = false) => ({ type: 'recipe', id, legacy });

describe('parseRoute', () => {
  test('recipe pages, on any site the web app runs on', () => {
    expect(parseRoute('https://savorly.cooking/recipes/lemon-ricotta-pasta')).toEqual(
      recipe('lemon-ricotta-pasta'),
    );
    expect(parseRoute('http://localhost:8081/recipes/abc')).toEqual(recipe('abc'));
    expect(parseRoute('/recipes/abc')).toEqual(recipe('abc'));
    expect(parseRoute('/recipes/abc/')).toEqual(recipe('abc'));
    expect(parseRoute('https://savorly.cooking/recipes/abc?utm_source=x#steps')).toEqual(
      recipe('abc'),
    );
    const uuid = '3f2b8c1e-0d4a-4c3e-9b1a-2f6d7e8a9b0c';
    expect(parseRoute(`https://staging.savorly.cooking/recipes/${uuid}`)).toEqual(recipe(uuid));
  });

  test('older links (/?recipe=<id>) still open the recipe, marked for rewriting', () => {
    expect(parseRoute('https://savorly.cooking/?recipe=lemon-ricotta-pasta')).toEqual(
      recipe('lemon-ricotta-pasta', true),
    );
    expect(parseRoute('/?recipe=abc&page=saved')).toEqual(recipe('abc', true));
    expect(parseRoute('savorly://?recipe=abc')).toEqual(recipe('abc', true));
    // An empty or malformed id is just the home page.
    expect(parseRoute('/?recipe=')).toEqual({ type: 'page', screen: null });
    expect(parseRoute('/?recipe=../admin')).toEqual({ type: 'page', screen: null });
  });

  test('a recipe link can open cooking mode', () => {
    expect(parseRoute('https://savorly.cooking/recipes/abc?cook=1')).toEqual({
      type: 'recipe',
      id: 'abc',
      legacy: false,
      cook: true,
    });
    expect(parseRoute('/recipes/abc?cook=0')).toEqual(recipe('abc'));
    expect(cookPath('a b')).toBe('/recipes/a%20b?cook=1');
  });

  test('the page where an assistant asks to connect keeps its request as sent', () => {
    expect(
      parseRoute(
        'https://savorly.cooking/oauth/authorize?client_id=https%3A%2F%2Fchatgpt.com&state=a+b',
      ),
    ).toEqual({ type: 'authorize', query: 'client_id=https%3A%2F%2Fchatgpt.com&state=a+b' });
    expect(parseRoute('/oauth/authorize')).toEqual({ type: 'authorize', query: '' });
    expect(parseRoute('/oauth/token')).toBeNull();
  });

  test('cookbooks', () => {
    expect(parseRoute('https://savorly.cooking/cookbooks/c-123')).toEqual({
      type: 'cookbook',
      id: 'c-123',
    });
    expect(parseRoute('/cookbooks/c-123/')).toEqual({ type: 'cookbook', id: 'c-123' });
    expect(parseRoute('savorly://cookbooks/c-123')).toEqual({ type: 'cookbook', id: 'c-123' });
  });

  test('screens and the home page', () => {
    expect(parseRoute('https://savorly.cooking/?page=planner')).toEqual({
      type: 'page',
      screen: 'planner',
    });
    expect(parseRoute('/?page=explore')).toEqual({ type: 'page', screen: 'explore' });
    expect(parseRoute('/?page=explore&tab=quick')).toEqual({ type: 'page', screen: 'explore' });
    expect(parseRoute('https://savorly.cooking/')).toEqual({ type: 'page', screen: null });
    expect(parseRoute('https://savorly.cooking')).toEqual({ type: 'page', screen: null });
    expect(parseRoute('/?page=nowhere')).toEqual({ type: 'page', screen: null });
    expect(parseRoute('savorly://?page=pantry')).toEqual({ type: 'page', screen: 'pantry' });
    expect(parseRoute('savorly://')).toEqual({ type: 'page', screen: null });
  });

  test('the app scheme, in each way it is written', () => {
    expect(parseRoute('savorly://recipes/abc')).toEqual(recipe('abc'));
    expect(parseRoute('savorly:///recipes/abc')).toEqual(recipe('abc'));
    expect(parseRoute('savorly:/recipes/abc')).toEqual(recipe('abc'));
    expect(parseRoute('SAVORLY://recipes/abc')).toEqual(recipe('abc'));
  });

  test('ids are decoded and checked', () => {
    expect(parseRoute('/recipes/caf%C3%A9')).toBeNull();
    expect(parseRoute('/recipes/%E0%A4%A')).toBeNull();
    expect(parseRoute('/recipes/a%2Fb')).toBeNull();
    expect(parseRoute('/recipes/-dash-first')).toBeNull();
    expect(parseRoute(`/recipes/${'a'.repeat(101)}`)).toBeNull();
    expect(parseRoute('/recipes/abc%5F1')).toEqual(recipe('abc_1'));
  });

  test("addresses that aren't the app's", () => {
    for (const address of [
      '',
      'recipes/abc',
      '//evil.example/recipes/abc',
      'javascript:alert(1)',
      'mailto:cook@example.com',
      'exp+savorly://expo-development-client/?url=http%3A%2F%2F10.0.0.2%3A8081',
      'savorly://expo-development-client/?url=x',
      'com.googleusercontent.apps.123:/oauthredirect?code=x',
      'https://savorly.cooking/recipes',
      'https://savorly.cooking/recipes/abc/reviews',
      'https://savorly.cooking/privacy',
    ])
      expect(parseRoute(address)).toBeNull();
  });

  test('on phones, only links from the app’s sites count', () => {
    expect(linkHosts).toEqual(
      expect.arrayContaining(['savorly.cooking', 'www.savorly.cooking', 'staging.savorly.cooking']),
    );
    const phone = ['savorly.cooking', 'staging.savorly.cooking'];
    expect(parseRoute('https://savorly.cooking/recipes/abc', phone)).toEqual(recipe('abc'));
    expect(parseRoute('https://SAVORLY.cooking:443/recipes/abc', phone)).toEqual(recipe('abc'));
    expect(parseRoute('https://staging.savorly.cooking/cookbooks/c1', phone)).toEqual({
      type: 'cookbook',
      id: 'c1',
    });
    expect(parseRoute('https://evil.example/recipes/abc', phone)).toBeNull();
    expect(parseRoute('https://savorly.cooking.evil.example/recipes/abc', phone)).toBeNull();
    expect(parseRoute('https://savorly.cooking@evil.example/recipes/abc', phone)).toBeNull();
    // The app's own scheme needs no site.
    expect(parseRoute('savorly://recipes/abc', phone)).toEqual(recipe('abc'));
  });
});

describe('paths and links', () => {
  test('paths', () => {
    expect(recipePath('lemon-ricotta-pasta')).toBe('/recipes/lemon-ricotta-pasta');
    expect(recipePath('a b')).toBe('/recipes/a%20b');
    expect(cookbookPath('c1')).toBe('/cookbooks/c1');
    expect(pagePath('planner')).toBe('/?page=planner');
  });

  test('shared links point at a site, never twice slashed', () => {
    expect(recipeUrl('abc', 'https://savorly.cooking')).toBe('https://savorly.cooking/recipes/abc');
    expect(recipeUrl('abc', 'https://savorly.cooking/')).toBe(
      'https://savorly.cooking/recipes/abc',
    );
    expect(cookbookUrl('c1', 'https://staging.savorly.cooking')).toBe(
      'https://staging.savorly.cooking/cookbooks/c1',
    );
    // Without a site: the web app's own, or on phones the build's web app.
    expect(recipeUrl('abc')).toMatch(/^https?:\/\/[^/]+\/recipes\/abc$/);
    // A link round-trips.
    expect(parseRoute(recipeUrl('abc'))).toEqual(recipe('abc'));
  });

  test('cards are links on the web only', () => {
    expect(linkTo('/recipes/abc')).toEqual(web ? { href: '/recipes/abc' } : {});
  });

  test('a plain click opens in the app; a modified one is the browser’s', () => {
    const click = (keys: Record<string, unknown> = {}) => {
      const preventDefault = jest.fn();
      return { event: { ...keys, preventDefault }, preventDefault };
    };
    const plain = click({ button: 0 });
    expect(pressedInApp(plain.event)).toBe(true);
    expect(plain.preventDefault).toHaveBeenCalledTimes(web ? 1 : 0);
    for (const keys of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
      const modified = click(keys);
      expect(pressedInApp(modified.event)).toBe(!web);
      expect(modified.preventDefault).not.toHaveBeenCalled();
    }
    // React Native Web hands the DOM event's keys over on nativeEvent too.
    expect(pressedInApp({ nativeEvent: { metaKey: true }, preventDefault() {} })).toBe(!web);
    expect(pressedInApp(undefined)).toBe(true);
  });
});
