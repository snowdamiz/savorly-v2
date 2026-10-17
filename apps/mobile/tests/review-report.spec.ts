import { expect, Page, test } from '@playwright/test';
import { alex, json, mockApi, recipe } from './mockApi';

// On another cook's recipe page: a review (rating and notes, PUT /recipes/:id/review) and a report
// (POST /recipes/:id/report), each refused until its text is long enough.

const soup = recipe({
  id: 'soup',
  title: 'Pumpkin soup',
  steps: [{ title: 'Simmer', text: 'Simmer the pumpkin until soft.', seconds: 0 }],
});

async function soupPage(page: Page) {
  const api = await mockApi(page, { recipes: [soup] });
  api.on('PUT', '/recipes/soup/review', ({ body }) => {
    const sent = body as { rating: number; body: string };
    const now = new Date().toISOString();
    api.state.reviews.soup = [
      { id: 'mine', rating: sent.rating, body: sent.body.trim(), createdAt: now, author: alex },
    ];
    return json({ ok: true });
  });
  api.on('POST', '/recipes/soup/report', () => json({ ok: true }));
  await page.goto(`/?recipe=${soup.id}`);
  await expect(page.getByText('Simmer the pumpkin until soft.', { exact: true })).toBeVisible();
  return api;
}

test('a review sends the rating and notes, once the notes say something', async ({ page }) => {
  const api = await soupPage(page);
  await expect(page.getByText('How did it turn out?', { exact: true })).toBeVisible();
  const notes = page.getByRole('textbox', { name: 'Your cooking notes', exact: true });
  const share = page.getByRole('button', { name: 'Share your review', exact: true });
  // At least three characters, not counting spaces around them.
  await expect(share).toBeDisabled();
  await notes.fill('ok');
  await expect(share).toBeDisabled();
  await notes.fill('   ok   ');
  await expect(share).toBeDisabled();
  await page.getByRole('button', { name: 'Rate 4 stars', exact: true }).click();
  await notes.fill('Lovely with crusty bread.');
  await expect(share).toBeEnabled();
  await share.click();
  await expect(
    page.getByText('Thanks for sharing a little kitchen wisdom.', { exact: true }),
  ).toBeVisible();
  expect(api.sentTo('/recipes/soup/review')).toEqual([
    ['PUT', { rating: 4, body: 'Lovely with crusty bread.' }],
  ]);
  // The review is listed as Alex's, and the form is ready for another.
  await expect(page.getByText('Lovely with crusty bread.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete your review', exact: true })).toBeVisible();
  await expect(notes).toHaveValue('');
  await expect(share).toBeDisabled();
});

test('a report needs a reason of five characters, then goes to the moderators', async ({
  page,
}) => {
  const api = await soupPage(page);
  await page
    .getByRole('button', { name: 'Report a problem with this recipe', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Report this recipe' })).toBeVisible();
  const reason = page.getByRole('textbox', { name: 'What needs a closer look?', exact: true });
  const submit = page.getByRole('button', { name: 'Submit report', exact: true });
  await expect(submit).toBeDisabled();
  await reason.fill('Copy');
  await expect(submit).toBeDisabled();
  await reason.fill('    Copy    ');
  await expect(submit).toBeDisabled();
  await reason.fill('Copied from another blog');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(
    page.getByText('Your report has been recorded for review.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(api.sentTo('/recipes/soup/report')).toEqual([
    ['POST', { reason: 'Copied from another blog' }],
  ]);
});
