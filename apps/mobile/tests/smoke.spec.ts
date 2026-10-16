import { test, expect, request as apiRequest } from '@playwright/test';
test('discovery, filters, details and mobile layout', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByText('What would you like to cook today?')).toBeVisible({
    timeout: 60000,
  });
  await page.screenshot({ path: '../../docs/discover-desktop.png', fullPage: true });
  await page.getByRole('textbox', { name: 'Search recipes' }).fill('lemon');
  await expect(
    page.getByRole('button', { name: 'View Lemon & ricotta pasta', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'View Crispy herb-roasted chicken', exact: true }),
  ).not.toBeVisible();
  await page.getByRole('button', { name: 'View Lemon & ricotta pasta', exact: true }).click();
  await expect(page.getByText('Let’s make it', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'More servings', exact: true }).click();
  await expect(page.getByText('For 3 people. Tap to check off.')).toBeVisible();
  await page.getByRole('button', { name: 'Start cooking', exact: true }).click();
  await expect(page.getByText('STEP 1 OF 3')).toBeVisible();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(page.getByText('STEP 2 OF 3')).toBeVisible();
  await page.getByRole('button', { name: 'Close cooking mode', exact: true }).click();
  await page.getByRole('button', { name: 'Close recipe', exact: true }).click();
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'My kitchen', exact: true })).toBeVisible();
  await page.screenshot({ path: '../../docs/discover-mobile.png', fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  expect(errors).toEqual([]);
});
test('register, save, groceries, plan and publish a recipe', async ({ page }) => {
  const email = `browser-${Date.now()}@example.test`;
  const password = 'a-long-browser-test-password';
  try {
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('button', { name: 'New here? Create an account', exact: true }).click();
    await page.getByRole('textbox', { name: 'Your name', exact: true }).fill('Robin Cook');
    await page.getByRole('textbox', { name: 'Email address', exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    const registration = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/auth/register') && response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Create your kitchen', exact: true }).click();
    expect((await registration).status()).toBe(200);
    // A new kitchen sets itself up: the username suggestion comes from the name, and any free one
    // works; the rest can be skipped.
    const username = page.getByRole('textbox', { name: 'Username', exact: true });
    await expect(username).toHaveValue(/^robincook\d*$/);
    const handle = `robin.${Date.now().toString(36)}`;
    await username.fill(handle);
    await expect(page.getByText(`@${handle} is available.`, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(page.getByText('How do you like to eat?', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.getByRole('button', { name: 'Let’s get started', exact: true }).click();
    await expect(
      page.getByText(`Welcome to the table, @${handle}.`, { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(/Good (morning|afternoon|evening), Robin/)).toBeVisible();
    await page.getByRole('button', { name: 'Let’s get cooking', exact: true }).click();
    await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
    await expect(page.getByText('Saved to your cookbook', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add to grocery list', exact: true }).click();
    await expect(page.getByText('Ingredients added to your grocery list.')).toBeVisible();
    await page.getByRole('button', { name: 'Plan this meal', exact: true }).click();
    await page.getByRole('button', { name: 'Add to my week', exact: true }).click();
    await expect(page.getByText('A delicious plan. Added to your week.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Close dialog', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Close recipe', exact: true }).click();
    await page.getByRole('button', { name: 'Create recipe', exact: true }).click();
    await page.getByRole('button', { name: 'Write a recipe yourself', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Recipe title', exact: true })
      .fill('Robin’s lemon toast');
    await page
      .getByRole('textbox', { name: 'The story behind it', exact: true })
      .fill('A bright, simple toast from our weekend kitchen.');
    await page.getByRole('textbox', { name: 'Ingredient 1', exact: true }).fill('Sourdough');
    await page.getByRole('textbox', { name: 'Amount', exact: true }).fill('0.5');
    await page.getByRole('textbox', { name: 'Step 1 title', exact: true }).fill('Toast the bread');
    await page
      .getByRole('textbox', { name: 'Step 1 instructions', exact: true })
      .fill('Toast until golden and finish with a squeeze of lemon.');
    const photoUpload = page.waitForResponse(
      (response) => response.url().endsWith('/v1/media') && response.request().method() === 'POST',
    );
    const photoChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload a photo', exact: true }).click();
    await (await photoChooser).setFiles('tests/fixtures/sample.png');
    expect((await photoUpload).status()).toBe(201);
    await expect(
      page.getByRole('textbox', { name: 'Or use an image URL', exact: true }),
    ).toHaveValue(/localhost:8333\/savorly-media\//);
    const extraUpload = page.waitForResponse(
      (response) => response.url().endsWith('/v1/media') && response.request().method() === 'POST',
    );
    const extraChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Add another photo', exact: true }).click();
    await (await extraChooser).setFiles('tests/fixtures/sample.png');
    expect((await extraUpload).status()).toBe(201);
    await expect(page.getByRole('button', { name: 'Remove photo 2', exact: true })).toBeVisible();
    const videoUpload = page.waitForResponse(
      (response) => response.url().endsWith('/v1/media') && response.request().method() === 'POST',
    );
    const videoChooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload a recipe video', exact: true }).click();
    await (await videoChooser).setFiles('tests/fixtures/sample.mp4');
    expect((await videoUpload).status()).toBe(201);
    await expect(
      page.getByRole('textbox', { name: 'Or use a direct video URL', exact: true }),
    ).toHaveValue(/localhost:8333\/savorly-media\//);
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll('video')).some((video) => video.readyState >= 2),
    );
    await page.getByRole('button', { name: 'Share my recipe', exact: true }).click();
    await expect(page.getByText('Your recipe is at the table. Thanks for sharing.')).toBeVisible();
    await expect(page.getByText('Robin’s lemon toast', { exact: true }).last()).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Show photo 2 of 2', exact: true }),
    ).toBeVisible();
  } finally {
    // A test timeout closes fixture contexts; cleanup needs its own connection.
    const cleanup = await apiRequest.newContext({ timeout: 60000 });
    try {
      const response = await cleanup.post('http://localhost:8080/v1/auth/login', {
        data: { email, password },
      });
      if (response.ok()) {
        const session = await response.json();
        await cleanup.delete('http://localhost:8080/v1/me', {
          headers: { Authorization: `Bearer ${session.token}` },
          data: { password },
        });
      }
    } finally {
      await cleanup.dispose();
    }
  }
});
