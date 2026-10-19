import { expect, Page, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { empty, failure, json, mockApi, recipe } from './mockApi';
import { afterPageTimers, stopsMoving } from './waits';

// Savorly in ChatGPT and Claude (docs/ASSISTANTS.md): the page where an assistant asks to connect
// (/oauth/authorize), Settings → Connected apps, the "Cook it in Savorly" link (?cook=1), and
// the recipe card the MCP server hands the assistant. Screenshots land in test-results/.

const phone = { width: 390, height: 844 };
/** Saves a screenshot once the open dialog has come to rest and faded in. */
async function shot(page: Page, name: string) {
  await stopsMoving(page.getByRole('dialog').last());
  await afterPageTimers(page, 400);
  await page.screenshot({ path: `test-results/assistants-${name}.png` });
}
const query =
  'client_id=https%3A%2F%2Fchatgpt.com%2Foauth%2Fclient.json&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector_platform_oauth_redirect&response_type=code&code_challenge=abc&code_challenge_method=S256&state=s1&scope=cookbooks+planner+groceries';
const chatgpt = {
  client: {
    id: 'https://chatgpt.com/oauth/client.json',
    name: 'ChatGPT',
    host: 'chatgpt.com',
    verified: true,
  },
  redirectHost: 'chatgpt.com',
  localhost: false,
  scopes: ['cookbooks', 'planner', 'groceries'],
};
const back = 'https://chatgpt.com/connector_platform_oauth_redirect';

const linkedApps = [
  {
    id: 'g1',
    name: 'ChatGPT',
    host: 'chatgpt.com',
    verified: true,
    scopes: ['cookbooks', 'planner', 'groceries'],
    connectedAt: '2026-10-12T09:00:00Z',
    lastUsedAt: '2026-10-17T18:30:00Z',
  },
  {
    id: 'g2',
    name: 'Claude',
    host: 'claude.ai',
    verified: true,
    scopes: ['planner'],
    connectedAt: '2026-10-02T09:00:00Z',
    lastUsedAt: '2026-10-03T08:00:00Z',
  },
  {
    id: 'g3',
    name: 'Recipe bot',
    host: 'bot.example.org',
    verified: false,
    scopes: ['groceries'],
    connectedAt: '2026-09-20T09:00:00Z',
    lastUsedAt: '2026-09-21T08:00:00Z',
  },
];

/** The assistant's side: where the member lands after answering. */
async function assistantSite(page: Page) {
  await page.route(`${back}**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>Back in ChatGPT</p>' }),
  );
}

test('a signed-in member connects ChatGPT and goes back to it with a code', async ({ page }) => {
  const api = await mockApi(page);
  api.on('GET', '/oauth/authorize', () => json(chatgpt));
  api.on('POST', '/oauth/authorize', ({ body }) =>
    json({
      redirect: `${back}?${(body as { approve: boolean }).approve ? 'code=c1' : 'error=access_denied'}&state=s1&iss=x`,
    }),
  );
  await assistantSite(page);
  await page.goto(`/oauth/authorize?${query}`);
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT to Savorly' })).toBeVisible();
  for (const line of [
    'Save recipes and see what you saved',
    'Plan meals and read your meal plan',
    'Add to your grocery list and read it',
  ])
    await expect(page.getByText(line, { exact: true })).toBeVisible();
  await expect(page.getByText('You’ll go back to chatgpt.com.', { exact: false })).toBeVisible();
  // ChatGPT is one Savorly knows: no caution.
  await expect(page.getByText('Connect only apps you trust', { exact: false })).toHaveCount(0);
  await shot(page, 'consent-desktop');
  // The request goes to the API exactly as the assistant sent it.
  expect(api.requests.find((r) => r.path === '/oauth/authorize')?.query.toString()).toBe(query);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.waitForURL(`${back}?code=c1&state=s1&iss=x`);
  expect(api.sentTo('/oauth/authorize')).toEqual([['POST', { request: query, approve: true }]]);
});

test('cancelling sends the member back with a no', async ({ page }) => {
  const api = await mockApi(page);
  api.on('GET', '/oauth/authorize', () => json(chatgpt));
  api.on('POST', '/oauth/authorize', () =>
    json({ redirect: `${back}?error=access_denied&state=s1` }),
  );
  await assistantSite(page);
  await page.goto(`/oauth/authorize?${query}`);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForURL(`${back}?error=access_denied&state=s1`);
  expect(api.sentTo('/oauth/authorize')).toEqual([['POST', { request: query, approve: false }]]);
});

test('an app Savorly doesn’t know, on this device, comes with a caution', async ({ page }) => {
  const api = await mockApi(page);
  api.on('GET', '/oauth/authorize', () =>
    json({
      client: { id: 'x', name: 'Kitchen helper', host: '127.0.0.1', verified: false },
      redirectHost: '127.0.0.1',
      localhost: true,
      scopes: ['planner'],
    }),
  );
  await page.goto(`/oauth/authorize?${query}`);
  await expect(
    page.getByRole('heading', { name: 'Connect Kitchen helper to Savorly' }),
  ).toBeVisible();
  await expect(
    page.getByText('This app runs on this device. Connect it only if you started it yourself.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText('Save recipes and see what you saved', { exact: true })).toHaveCount(
    0,
  );
  await shot(page, 'consent-localhost-desktop');
});

test('a guest signs in first', async ({ page }) => {
  const api = await mockApi(page, { signedIn: false });
  api.on('GET', '/oauth/authorize', () => json(chatgpt));
  await page.goto(`/oauth/authorize?${query}`);
  await expect(
    page.getByText('Sign in to choose what ChatGPT can do in your kitchen.', { exact: true }),
  ).toBeVisible();
  await shot(page, 'consent-guest-desktop');
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click();
  await expect(page.getByRole('heading', { name: 'Connect ChatGPT to Savorly' })).toHaveCount(0);
});

test('a link that isn’t valid explains itself', async ({ page }) => {
  const api = await mockApi(page);
  api.on('GET', '/oauth/authorize', () =>
    failure(400, "This app isn't registered with Savorly. Start again from the app you came from."),
  );
  await page.goto(`/oauth/authorize?client_id=nope`);
  await expect(
    page.getByText(
      "This app isn't registered with Savorly. Start again from the app you came from.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connect an app' })).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect an app' })).toHaveCount(0);
});

test('Connected apps lists the linked assistants and disconnects one', async ({ page }) => {
  const api = await mockApi(page);
  let apps = [...linkedApps];
  api.on('GET', '/me/connected-apps', () => json(apps));
  api.on('DELETE', /^\/me\/connected-apps\/(.+)$/, ({ params }) => {
    apps = apps.filter((a) => a.id !== params[0]);
    return empty();
  });
  await page.goto('/?page=settings');
  await page.getByRole('button', { name: 'Connected apps', exact: true }).click();
  await expect(page.getByText('ChatGPT', { exact: true })).toBeVisible();
  await expect(page.getByText('Recipe bot · bot.example.org', { exact: true })).toBeVisible();
  await expect(
    page.getByText(/^Connected Oct 12(, 2026)? · last used Oct 17(, 2026)?$/),
  ).toBeVisible();
  await shot(page, 'connected-desktop');
  await page.getByRole('button', { name: 'Disconnect Claude', exact: true }).click();
  await expect(page.getByText('That app is disconnected.', { exact: true })).toBeVisible();
  await expect(page.getByText('Claude', { exact: true })).toHaveCount(0);
  expect(api.sentTo(/^\/me\/connected-apps\//)).toEqual([['DELETE', undefined]]);

  apps = [];
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('button', { name: 'Connected apps', exact: true }).click();
  await expect(page.getByText(/^No apps are connected\./)).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({ viewport: phone });
  test('the consent page and Connected apps fit a phone', async ({ page }) => {
    const api = await mockApi(page);
    api.on('GET', '/oauth/authorize', () => json(chatgpt));
    api.on('GET', '/me/connected-apps', () => json(linkedApps));
    await page.goto(`/oauth/authorize?${query}`);
    await expect(page.getByRole('heading', { name: 'Connect ChatGPT to Savorly' })).toBeVisible();
    await shot(page, 'consent-phone');
    await page.goto('/?page=settings');
    await page.getByRole('button', { name: 'Connected apps', exact: true }).click();
    await expect(page.getByText('Recipe bot · bot.example.org', { exact: true })).toBeVisible();
    await shot(page, 'connected-phone');
  });
});

test('“Cook it in Savorly” opens the recipe in cooking mode', async ({ page }) => {
  await mockApi(page, { recipes: [recipe({ id: 'lemon', title: 'Lemon toast' })] });
  await page.goto('/recipes/lemon?cook=1');
  await expect(page.getByRole('button', { name: 'Close cooking mode', exact: true })).toBeVisible();
  // Its own address, so Back or a reload doesn't start cooking again.
  await expect(page).toHaveURL(/\/recipes\/lemon$/);
});

// The card the MCP server serves (services/api/internal/app/assistant_card.html), in a frame of
// a stand-in host that speaks the MCP Apps bridge: it answers ui/initialize with its theme and
// sends the tool's result.
const card = readFileSync(
  path.resolve('../../services/api/internal/app/assistant_card.html'),
  'utf8',
);
const photo = readFileSync(path.resolve('public/og-image.png'));
const pasta = {
  id: 'lemon-pasta',
  title: 'Lemon ricotta pasta',
  url: 'https://savorly.cooking/recipes/lemon-pasta',
  cookUrl: 'https://savorly.cooking/recipes/lemon-pasta?cook=1',
  image: 'https://media.example.test/lemon.png',
  minutes: 20,
  cuisine: 'Italian',
  cookTested: true,
  verifiedCooks: 214,
  cookedMinutes: 25,
};
const soup = {
  ...pasta,
  id: 'soup',
  title: 'Tomato soup with a long name that keeps going',
  cookTested: false,
  verifiedCooks: 1,
  cookedMinutes: null,
  minutes: 35,
  image: '',
};

async function host(page: Page, structured: unknown, theme: 'light' | 'dark', locale = 'en-US') {
  await page.route('https://media.example.test/**', (route) =>
    route.fulfill({ contentType: 'image/png', body: photo }),
  );
  const opened: string[] = [];
  await page.exposeFunction('opened', (url: string) => opened.push(url));
  await page.setContent(`<!doctype html><body style="margin:0;padding:24px;background:${theme === 'dark' ? '#212121' : '#fff'}">
<iframe id="card" style="width:min(100%,420px);height:520px;border:1px solid ${theme === 'dark' ? '#3a3a3a' : '#e5e5e5'};border-radius:16px"></iframe>
<script>
const frame = document.getElementById('card');
window.addEventListener('message', (event) => {
  const m = event.data;
  if (!m || m.jsonrpc !== '2.0') return;
  const reply = (result) => frame.contentWindow.postMessage({ jsonrpc: '2.0', id: m.id, result }, '*');
  if (m.method === 'ui/initialize') reply({ protocolVersion: '2026-01-26', hostContext: { theme: '${theme}', locale: '${locale}' } });
  if (m.method === 'ui/notifications/initialized')
    frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [], structuredContent: ${JSON.stringify(structured)} } }, '*');
  if (m.method === 'ui/open-link') { window.opened(m.params.url); reply({}); }
  if (m.method === 'ui/notifications/size-changed') frame.style.height = m.params.height + 'px';
});
frame.srcdoc = ${JSON.stringify(card).replace(/<\//g, '<\\/')};
</script></body>`);
  return opened;
}

test('the recipe card shows a photo, the title, one line of facts and Cook it in Savorly', async ({
  page,
}) => {
  const opened = await host(page, { recipe: pasta }, 'light');
  const frame = page.frameLocator('#card');
  await expect(frame.getByRole('heading', { name: 'Lemon ricotta pasta' })).toBeVisible();
  await expect(frame.getByText('Cook-tested · 214 cooks · usually 25 min')).toBeVisible();
  await page.screenshot({ path: 'test-results/assistants-card-one-light.png' });
  await frame.getByRole('link', { name: 'Cook it in Savorly' }).click();
  await expect.poll(() => opened).toEqual(['https://savorly.cooking/recipes/lemon-pasta?cook=1']);
});

test('the recipe card lists search results, in the host’s theme and language', async ({ page }) => {
  await host(page, { recipes: [pasta, soup] }, 'dark', 'fr-FR');
  const frame = page.frameLocator('#card');
  await expect(
    frame.getByRole('link', { name: 'Cuisiner Lemon ricotta pasta dans Savorly' }),
  ).toBeVisible();
  await expect(frame.getByText('35 min · Italian')).toBeVisible();
  await page.screenshot({ path: 'test-results/assistants-card-list-dark.png' });
});
