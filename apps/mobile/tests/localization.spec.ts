/// <reference types="node" />
import { expect, test, type Page } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { languages, resolveLocale, translator, type Messages } from '../src/lib/i18n/core';
import { cuisineFilters } from '../src/lib/cuisines';
import en from '../src/lib/i18n/locales/en.json';
import ru from '../src/lib/i18n/locales/ru.json';

const author = {
  id: 'cook',
  name: 'French',
  handle: 'cook',
  avatar: '',
  bio: '',
  recipeCount: 1,
  followerCount: 0,
};
const recipe = {
  id: 'lemon-ricotta-pasta',
  title: 'Breakfast',
  description: 'Original recipe content.',
  cuisine: 'French',
  minutes: 20,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  video: '',
  ingredients: [{ name: 'Butter', amount: 0.5, unit: 'g', category: 'Dairy' }],
  steps: [{ title: 'Toast', text: 'Toast the bread.', seconds: 60 }],
  tags: ['Vegetarian'],
  calories: 120,
  aiGenerated: false,
  published: true,
  author,
  rating: 4.5,
  reviewCount: 0,
  saveCount: 1,
  createdAt: '2026-10-01T12:00:00Z',
};
async function mockAPI(page: Page, signedIn = false) {
  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    let json: unknown = [];
    let status = 200;
    if (url.pathname === '/v1/recipes')
      json = route.request().method() === 'GET' ? [recipe] : recipe;
    if (url.pathname === `/v1/recipes/${recipe.id}`) json = recipe;
    if (url.pathname === '/v1/creators') json = [author];
    if (url.pathname === '/v1/capabilities')
      json = { textAI: false, voiceAI: false, recipeChat: false };
    if (url.pathname === '/v1/me') {
      status = signedIn ? 200 : 401;
      json = signedIn
        ? { ...author, email: 'cook@example.test', preferences: { diets: [], allergies: [] } }
        : { error: 'Sign in to your kitchen to continue.' };
    }
    if (url.pathname === '/v1/library')
      json = { savedIds: [], saves: [], collections: [], followingIds: [], recipes: [] };
    if (url.pathname === '/v1/kitchen') json = { plans: [], groceries: [], pantry: [] };
    await route.fulfill({ status, json });
  });
}

test('locale negotiation respects preference order, regional tags, overrides and fallbacks', () => {
  expect(resolveLocale('system', ['zz-ZZ', 'fr-CA', 'de-DE'])).toEqual({
    language: 'fr',
    locale: 'fr-CA',
  });
  expect(resolveLocale('de', ['fr-FR', 'de-AT'])).toEqual({ language: 'de', locale: 'de-AT' });
  expect(resolveLocale('ru', ['fr-FR'])).toEqual({ language: 'ru', locale: 'ru-RU' });
  expect(resolveLocale('system', ['xx', 'invalid--tag'])).toEqual({
    language: 'en',
    locale: 'en-US',
  });
  expect(resolveLocale('system', ['zh_Hans_CN'])).toEqual({ language: 'zh', locale: 'zh-Hans-CN' });
  expect(resolveLocale('system', ['zh-TW', 'ja-JP']).language).toBe('ja');
});

test('all catalogs cover the same messages, retain placeholders, and include every static UI key', () => {
  const directory = path.resolve('src/lib/i18n/locales');
  const expected = Object.keys(en).sort();
  for (const key of [
    ...cuisineFilters,
    'Publish',
    'Read it back',
    'Find me a quick dinner',
    'Plan my dinners for this week',
    'What can I make with my pantry?',
    'Help me create a recipe',
    'Make this vegetarian',
    'Add this to my grocery list',
    'What should I serve with it?',
    'Can I make it ahead?',
    'How do I know this step is done?',
    'I don’t have the right pan',
    'Something went wrong — can I fix it?',
    'What can I make with what’s in my fridge?',
    'Make it vegetarian, for six.',
    'Plan my week and add the groceries.',
    'Turn this photo into a recipe.',
    'Free',
    'Plus',
    'Pro',
    'Sous-chef messages',
    'Live voice minutes',
    'AI photos',
    'AI videos',
    'Natural-voice read-alouds',
    'Baking',
    'Easy',
    'Medium',
    'Advanced',
  ]) {
    expect(expected).toContain(key);
  }
  const variables = (message: string) =>
    [...message.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
  for (const { code } of languages) {
    const catalog: Messages = JSON.parse(
      readFileSync(path.join(directory, `${code}.json`), 'utf8'),
    );
    expect(Object.keys(catalog).sort(), code).toEqual(expected);
    for (const [key, english] of Object.entries(en)) {
      expect(catalog[key].trim().length, `${code}: ${key}`).toBeGreaterThan(0);
      expect(variables(catalog[key]), `${code}: ${key}`).toEqual(variables(english));
    }
  }
  const files = [
    'App.tsx',
    ...['src/components', 'src/screens'].flatMap((dir) =>
      readdirSync(dir)
        .filter((file) => file.endsWith('.tsx'))
        .map((file) => path.join(dir, file)),
    ),
  ];
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ['t', 'tr'].includes(node.expression.getText(source)) &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        expect(expected, `${file}: ${node.arguments[0].text}`).toContain(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test('Russian plural forms, interpolation and English fallback', () => {
  const t = translator('ru', 'ru-RU', ru, en);
  for (const unknown of ['constructor', 'toString', '__proto__']) expect(t(unknown)).toBe(unknown);
  for (const [count, expected] of [
    [1, '1 рецепт'],
    [2, '2 рецепта'],
    [5, '5 рецептов'],
    [21, '21 рецепт'],
    [22, '22 рецепта'],
    [0, '0 рецептов'],
  ] as const) {
    expect(t('recipeCount', { count, more: '' })).toBe(expected);
  }
  expect(translator('de', 'de-DE', {}, en)('servingHint', { count: 1 })).toBe(
    'For 1 person. Tap to check off.',
  );
  expect(t('View {{v0}}', { v0: '{{original}} <recipe>' })).toBe(
    'Посмотреть {{original}} <recipe>',
  );
});

for (const [locale, heading, profile, setting] of [
  ['en-GB', 'What would you like to cook today?', 'Open my kitchen', 'Language settings'],
  ['fr-CA', 'Que voulez-vous cuisiner aujourd’hui ?', 'Ouvrir ma cuisine', 'Paramètres de langue'],
  ['de-DE', 'Was möchtest du heute kochen?', 'Meine Küche öffnen', 'Spracheinstellungen'],
  ['ru-RU', 'Что приготовим сегодня?', 'Открыть мою кухню', 'Настройки языка'],
  ['es-MX', '¿Qué te gustaría cocinar hoy?', 'Abrir mi cocina', 'Ajustes de idioma'],
  ['it-IT', 'Cosa vuoi cucinare oggi?', 'Apri la mia cucina', 'Impostazioni lingua'],
  ['pt-PT', 'O que você quer cozinhar hoje?', 'Abrir minha cozinha', 'Configurações de idioma'],
  ['zh-CN', '今天想做什么菜？', '打开我的厨房', '语言设置'],
  ['ja-JP', '今日は何を作りますか？', 'マイキッチンを開く', '言語設定'],
]) {
  test.describe(locale, () => {
    test.use({ locale });
    test('detects browser language and offers settings without sign-in', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await mockAPI(page);
      await page.goto('/');
      await expect(page.getByText(heading, { exact: true })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('lang', locale);
      await page.getByRole('button', { name: profile, exact: true }).click();
      await page.getByRole('button', { name: setting, exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Français', exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    });
  });
}

test.describe('French browser', () => {
  test.use({ locale: 'fr-FR' });
  test('manual language survives reload and switching back to automatic follows the browser', async ({
    page,
  }) => {
    await mockAPI(page);
    await page.goto('/?page=profile');
    await page.getByRole('button', { name: 'Paramètres de langue' }).click();
    await page.getByRole('radio', { name: 'Русский', exact: true }).click();
    await expect(page.getByRole('radio', { name: 'Русский' })).toBeChecked();
    await expect(page.getByText('Определённый язык: Français', { exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'ru-RU');
    await page.screenshot({ path: 'test-results/language-settings-desktop-ru.png' });
    await page.reload();
    await page.getByRole('button', { name: 'Настройки языка' }).click();
    await expect(page.getByRole('radio', { name: 'Русский' })).toBeChecked();
    await page.getByRole('radio', { name: 'Язык устройства', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'fr-FR');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Paramètres de langue' })).toBeVisible();
    await expect(page).toHaveTitle('Ma cuisine · Savorly');
  });
  test('localized cuisines keep canonical API filters and user content stays original', async ({
    page,
  }) => {
    await mockAPI(page);
    await page.goto('/?page=explore');
    const search = page.waitForRequest(
      (request) => new URL(request.url()).searchParams.get('category') === 'French',
    );
    await page
      .getByRole('button', { name: 'Explorer les recettes : Française', exact: true })
      .click();
    await search;
    await expect(
      page.getByRole('button', { name: 'Explorer les recettes : Française', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Filtrer les recettes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Française', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Voir 1 recettes', exact: true }).click();
    await page.getByRole('button', { name: 'Voir Breakfast', exact: true }).click();
    await expect(page.getByText('Original recipe content.', { exact: true })).toBeVisible();
    await expect(page.getByText('0,5 g', { exact: true })).toBeVisible();
    await expect(
      page.getByText('Pour 2 personnes. Touchez pour cocher.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Moins de portions', exact: true }).click();
    await expect(
      page.getByText('Pour 1 personne. Touchez pour cocher.', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Commencer à cuisiner', exact: true }).click();
    await expect(page.getByText('ÉTAPE 1 SUR 1', { exact: true })).toBeVisible();
    await expect(
      page.locator('[aria-modal="true"]').last().getByText('Toast the bread.', { exact: true }),
    ).toBeVisible();
  });
});

test('unsupported locale falls back safely and mobile language selection fits', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { get: () => ['xx-ZZ'] });
    localStorage.setItem('savorly.language', 'not-a-language');
  });
  await mockAPI(page);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Language settings' }).click();
  await page.getByRole('radio', { name: 'Deutsch', exact: true }).click();
  await expect(page.getByText('Erkannte Sprache: English', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/language-settings-mobile-de.png' });
});

test('automatic mode follows browser changes while an explicit choice wins', async ({ page }) => {
  await mockAPI(page);
  await page.goto('/?page=profile');
  await expect(page.getByRole('button', { name: 'Language settings' })).toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['ja-JP'] });
    window.dispatchEvent(new Event('languagechange'));
  });
  await page.getByRole('button', { name: '言語設定' }).click();
  await page.getByRole('radio', { name: 'Deutsch', exact: true }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['fr-FR'] });
    window.dispatchEvent(new Event('languagechange'));
  });
  await expect(page.locator('html')).toHaveAttribute('lang', 'de-DE');
  await expect(page.getByText('Erkannte Sprache: Français', { exact: true })).toBeVisible();
});

test.describe('German kitchen', () => {
  test.use({ locale: 'de-DE' });
  test('decimal commas are editable and recipe data keeps canonical cuisine and difficulty', async ({
    page,
  }) => {
    await mockAPI(page, true);
    await page.goto('/?page=create');
    await page.getByRole('textbox', { name: 'Rezepttitel', exact: true }).fill('Breakfast');
    await page
      .getByRole('button', { name: 'Küche wählen, aktuell Italienisch', exact: true })
      .click();
    await expect(page.getByRole('button', { name: 'Italienisch', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Französisch', exact: true }).click();
    const amount = page.getByRole('textbox', { name: 'Menge', exact: true });
    await amount.fill('1,25');
    await expect(amount).toHaveValue('1,25');
    const submission = page.waitForRequest(
      (request) => request.url().endsWith('/v1/recipes') && request.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Entwurf speichern', exact: true }).click();
    const data = (await submission).postDataJSON();
    expect(data.ingredients[0].amount).toBe(1.25);
    expect(data.title).toBe('Breakfast');
    expect(data.cuisine).toBe('French');
    expect(data.difficulty).toBe('Easy');
    await expect(
      page.getByText('Entwurf in deinem Konto gespeichert.', { exact: true }).first(),
    ).toBeVisible();
  });
  test('planner displays localized weekdays and dates', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-07T12:00:00Z'));
    await mockAPI(page, true);
    await page.goto('/?page=planner');
    await expect(page.getByText('5. Okt. – 11. Okt.', { exact: true })).toBeVisible();
    await expect(page.getByText('Mo', { exact: true })).toBeVisible();
    await expect(page.getByText('Frühstück', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Frühstück hinzufügen', exact: true }).first().click();
    const submission = page.waitForRequest(
      (request) => request.url().endsWith('/v1/planner') && request.method() === 'POST',
    );
    await page.getByRole('button', { name: 'Breakfast einplanen', exact: true }).click();
    expect((await submission).postDataJSON()).toMatchObject({
      meal: 'Breakfast',
      recipeId: recipe.id,
      servings: 2,
    });
  });
});

test('blocked storage does not prevent language changes and reports failure to save', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'savorly.language')
        throw new DOMException('Storage blocked', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await mockAPI(page);
  await page.goto('/?page=profile');
  await page.getByRole('button', { name: 'Language settings' }).click();
  await page.getByRole('radio', { name: 'Français', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr-FR');
  await expect(page.getByRole('alert')).toContainText(
    'La langue a changé, mais n’a pas pu être enregistrée.',
  );
});

test('Expo declares each supported native language with localized permission descriptions', () => {
  const config = JSON.parse(readFileSync('app.json', 'utf8')).expo;
  const plugin = config.plugins.find(
    (entry: unknown) => Array.isArray(entry) && entry[0] === 'expo-localization',
  );
  for (const { code } of languages) {
    const nativeCode = code === 'zh' ? 'zh-Hans' : code;
    expect(plugin[1].supportedLocales).toContain(nativeCode);
    const resource = JSON.parse(readFileSync(config.locales[nativeCode], 'utf8')).ios;
    for (const key of [
      'NSCameraUsageDescription',
      'NSMicrophoneUsageDescription',
      'NSPhotoLibraryUsageDescription',
    ]) {
      expect(resource[key].length, `${nativeCode}: ${key}`).toBeGreaterThan(10);
    }
  }
});
