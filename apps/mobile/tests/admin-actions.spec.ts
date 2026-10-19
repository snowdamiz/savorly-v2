import { expect, Page, test } from '@playwright/test';
import type {
  AdminAI,
  AdminJob,
  AdminMemberDetail,
  AdminRecipe,
  AdminRecipeDetail,
  AdminTurn,
} from '../src/lib/admin';
import { empty, failure, json, mockApi, recipe } from './mockApi';

// Admin console actions beyond admin.spec.ts, each behind its confirmation: suspending a member and
// lifting it, making one an admin or a founding creator, deleting one by typing their email back,
// unpublishing a recipe with a note and restoring it, cancelling an AI job and ending a live voice
// session.

const owner = {
  id: 'owner',
  name: 'Olive',
  handle: 'olive',
  email: 'owner@example.test',
  admin: true,
  adminOwner: true,
};
const sam = { id: 'sam', name: 'Sam Spam', email: 'sam@example.test', avatar: '' };
const at = '2026-10-15T09:00:00Z';
const paged = <T>(items: T[]) => ({ items, total: items.length, offset: 0, limit: 50 });

const member = (): AdminMemberDetail => ({
  ...sam,
  handle: 'sam',
  createdAt: '2026-09-01T10:00:00Z',
  plan: 'free',
  planStatus: '',
  comped: false,
  emailVerified: true,
  onboarded: true,
  hasPassword: true,
  sample: false,
  identities: [],
  admin: false,
  owner: false,
  ownerEmail: false,
  suspendedAt: null,
  suspendedReason: '',
  recipeCount: 1,
  publishedCount: 1,
  openReports: 0,
  spend30d: 0.5,
  lastSignInAt: at,
  bio: '',
  preferences: { diets: [], allergies: [] },
  planInterval: '',
  planRenewsAt: null,
  planCancels: false,
  stripeCustomerId: null,
  stripeSubscriptionId: '',
  appointedAdmin: false,
  activeSessions: 2,
  counts: {
    reviews: 0,
    saves: 0,
    cookbooks: 0,
    followers: 0,
    following: 0,
    conversations: 0,
    mealPlans: 0,
    pantry: 0,
    reportsFiled: 0,
    aiJobs: 0,
  },
  recipes: [],
  reviews: [],
  jobs: [],
  reportsFiled: [],
  history: [],
  usage: { assistant: 0, voiceSeconds: 0, images: 0, videos: 0, narration: 0 },
  limits: null,
});
const carbonara = recipe({
  id: 'carbonara',
  title: 'Copied carbonara',
  author: { id: sam.id, name: sam.name, handle: 'sam', bio: '', avatar: '' },
});
const job = (id: string, kind: AdminJob['kind'], status: AdminJob['status']): AdminJob => ({
  id,
  kind,
  status,
  error: '',
  cost: 0.8,
  providerId: `task-${id}`,
  createdAt: at,
  updatedAt: at,
  user: sam,
  prompt: 'A slow cinematic reveal',
  result: {},
});

/** The console as its owner sees it, over an API that keeps what the actions change. */
async function adminConsole(page: Page, tab: string) {
  const api = await mockApi(page, { user: owner });
  let record: AdminMemberDetail | null = member();
  api.on('GET', '/admin/overview', () => json({ stats: { reports: { open: 0, recipes: 0 } } }));
  api.on('GET', '/admin/users', () => json(paged(record ? [record] : [])));
  api.on('GET', '/admin/users/sam', () =>
    record ? json(record) : failure(404, 'This item could not be found.'),
  );
  const change = (fields: Partial<AdminMemberDetail>) => {
    record = { ...record!, ...fields };
    return json(record);
  };
  api.on('POST', '/admin/users/sam/suspend', ({ body }) =>
    change({ suspendedAt: at, suspendedReason: (body as { reason: string }).reason }),
  );
  api.on('DELETE', '/admin/users/sam/suspend', () =>
    change({ suspendedAt: null, suspendedReason: '' }),
  );
  api.on('PUT', '/admin/users/sam/admin', ({ body }) => {
    const { admin } = body as { admin: boolean };
    return change({ admin, appointedAdmin: admin });
  });
  api.on('PUT', '/admin/users/sam/founding', ({ body }) =>
    change({ foundingCreatorAt: (body as { founding: boolean }).founding ? at : null }),
  );
  api.on('DELETE', '/admin/users/sam', () => {
    record = null;
    return empty();
  });

  let held: string | null = null;
  const moderated = (): AdminRecipeDetail => ({
    ...carbonara,
    published: !held,
    updatedAt: at,
    unpublishedByAdminAt: held,
    unpublishedBy: held ? owner.email : '',
    authorEmail: sam.email,
    authorSuspended: false,
    conversations: 0,
    reports: [],
    history: [],
  });
  api.on('GET', '/admin/recipes', () => {
    const r = moderated();
    const listed: AdminRecipe = {
      id: r.id,
      title: r.title,
      image: r.image,
      cuisine: r.cuisine,
      published: r.published,
      aiGenerated: r.aiGenerated,
      video: false,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      unpublishedByAdminAt: r.unpublishedByAdminAt,
      author: { ...sam, handle: 'sam', suspended: false },
      rating: 0,
      reviewCount: 0,
      saveCount: 0,
      openReports: 0,
      reportCount: 0,
    };
    return json(paged([listed]));
  });
  api.on('GET', '/admin/recipes/carbonara', () => json(moderated()));
  api.on('PUT', '/admin/recipes/carbonara/published', ({ body }) => {
    held = (body as { published: boolean }).published ? null : at;
    return json(moderated());
  });

  let ending = false;
  const jobs: Record<string, AdminJob> = {
    clip: job('clip', 'video', 'processing'),
    draft: job('draft', 'recipe', 'running'),
  };
  api.on('GET', '/admin/ai', () =>
    json({
      voice: [
        {
          id: 'call',
          status: 'active',
          createdAt: at,
          heartbeatAt: at,
          reservedSeconds: 600,
          seconds: 120,
          closeRequested: ending,
          user: sam,
        },
      ],
      spenders: [],
      kinds: [],
      assistant: { turns: 0, failed: 0, spend: 0 },
      narration: { clips: 0, spend: 0 },
      voiceTotals: { sessions: 3, minutes: 12 },
    } satisfies AdminAI),
  );
  api.on('POST', '/admin/voice/call/end', () => {
    ending = true;
    return empty();
  });
  const turn: AdminTurn = {
    id: 'turn-1',
    status: 'completed',
    channel: 'text',
    cost: 0.002,
    createdAt: at,
    startedAt: at,
    updatedAt: at,
    project: 'chat-1',
    model: 'openai/gpt-6-luna',
    ms: 2400,
    rounds: 2,
    tools: ['get_recipe', 'plan_meal'],
    toolErrors: 1,
    user: sam,
  };
  api.on('GET', '/admin/turns', () => json(paged([turn])));
  api.on('GET', '/admin/turns/turn-1', () =>
    json({
      ...turn,
      reply: 'That recipe isn’t there any more.',
      trace: {
        ms: 2400,
        rounds: [
          {
            ms: 1200,
            cost: 0.001,
            tools: [
              { name: 'get_recipe', ms: 40 },
              { name: 'plan_meal', ms: 35, error: 'Recipe not found.' },
            ],
          },
          { ms: 900, cost: 0.001 },
        ],
      },
    } satisfies AdminTurn),
  );
  api.on('GET', '/admin/jobs', () => json(paged(Object.values(jobs))));
  api.on('GET', /^\/admin\/jobs\/([^/]+)$/, ({ params: [id] }) => json(jobs[id]));
  api.on('POST', '/admin/jobs/clip/cancel', () => {
    jobs.clip = {
      ...jobs.clip,
      status: 'failed',
      error: 'Cancelled by an admin. The provider may still finish and bill this task.',
    };
    return json(jobs.clip);
  });
  await page.goto(`/?page=admin&tab=${tab}`);
  return api;
}
/** Asks for an action from the open record, and waits for the confirmation to take its place. */
const ask = async (page: Page, action: string, title: string) => {
  await page.getByRole('button', { name: action, exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
};
/** The open record or confirmation; the list behind it repeats some of its words. */
const sheet = (page: Page) => page.getByRole('dialog');
const openSam = async (page: Page) => {
  await page.getByRole('button', { name: 'Open Sam Spam', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sam Spam', exact: true })).toBeVisible();
  // The record's actions are under Manage.
  await page.getByRole('tab', { name: 'Manage', exact: true }).click();
};

test('a member is suspended with a reason, then the suspension is lifted', async ({ page }) => {
  const api = await adminConsole(page, 'members');
  await openSam(page);
  await ask(page, 'Suspend', 'Suspend Sam Spam?');
  await expect(
    page.getByText(/^They’re signed out everywhere and can’t sign back in\./),
  ).toBeVisible();
  const reason = page.getByRole('textbox', { name: 'Reason (only admins see it)', exact: true });
  const suspend = page.getByRole('button', { name: 'Suspend', exact: true });
  // The reason is required: three characters at least.
  await expect(suspend).toBeDisabled();
  await reason.fill('  ab  ');
  await expect(suspend).toBeDisabled();
  await reason.fill('Spam recipes');
  await suspend.click();
  // Back on the record, which says so and offers the way back.
  await expect(sheet(page).getByText('Sam Spam is suspended.', { exact: true })).toBeVisible();
  await expect(sheet(page).getByText(/: Spam recipes\. They can't sign in/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sam Spam', exact: true })).toBeVisible();
  // A suspended member can't be made an admin.
  await expect(page.getByRole('button', { name: 'Make admin' })).toHaveCount(0);
  await ask(page, 'Lift suspension', 'Lift Sam Spam’s suspension?');
  await page.getByRole('button', { name: 'Lift suspension', exact: true }).click();
  await expect(sheet(page).getByText('Sam Spam can sign in again.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Suspend', exact: true })).toBeVisible();
  await expect(sheet(page).getByText(/They can't sign in/)).toHaveCount(0);
  expect(
    api.requests
      .filter((r) => r.method !== 'GET' && r.path.startsWith('/admin/'))
      .map((r) => [r.method, r.path, r.body]),
  ).toEqual([
    ['POST', '/admin/users/sam/suspend', { reason: 'Spam recipes' }],
    ['DELETE', '/admin/users/sam/suspend', undefined],
  ]);
});

test('an owner makes a member an admin after confirming', async ({ page }) => {
  const api = await adminConsole(page, 'members');
  await openSam(page);
  await ask(page, 'Make admin', 'Make Sam Spam an admin?');
  await expect(
    page.getByText(/^Admins can moderate content, suspend and delete members/),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Make admin', exact: true }).click();
  await expect(sheet(page).getByText('Sam Spam is now an admin.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove as admin', exact: true })).toBeVisible();
  expect(api.sentTo('/admin/users/sam/admin')).toEqual([['PUT', { admin: true }]]);
});

test('an admin marks a founding creator, and can take the mark back', async ({ page }) => {
  const api = await adminConsole(page, 'members');
  await openSam(page);
  await ask(page, 'Make founding creator', 'Make Sam Spam a founding creator?');
  await expect(page.getByText(/they join the cook-along’s rotation/)).toBeVisible();
  await page.getByRole('button', { name: 'Make founding creator', exact: true }).click();
  await expect(
    sheet(page).getByText('Sam Spam is a founding creator.', { exact: true }),
  ).toBeVisible();
  await expect(sheet(page).getByText('Founding creator', { exact: true })).toBeVisible();
  await ask(page, 'Remove founding creator', 'Remove Sam Spam as a founding creator?');
  await page.getByRole('button', { name: 'Remove the mark', exact: true }).click();
  await expect(
    sheet(page).getByText('Sam Spam is no longer a founding creator.', { exact: true }),
  ).toBeVisible();
  expect(api.sentTo('/admin/users/sam/founding')).toEqual([
    ['PUT', { founding: true }],
    ['PUT', { founding: false }],
  ]);
});

test('deleting a member takes their email typed back', async ({ page }) => {
  const api = await adminConsole(page, 'members');
  await openSam(page);
  await ask(page, 'Delete account', 'Delete Sam Spam’s account?');
  const typed = page.getByRole('textbox', {
    name: 'Type sam@example.test to confirm',
    exact: true,
  });
  const remove = page.getByRole('button', { name: 'Delete permanently', exact: true });
  await expect(remove).toBeDisabled();
  await typed.fill('sam@example');
  await expect(remove).toBeDisabled();
  // Any case does.
  await typed.fill('SAM@example.test');
  await expect(remove).toBeEnabled();
  await remove.click();
  // The record closes, and the member is gone from the list.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('No members match.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Sam Spam' })).toHaveCount(0);
  expect(api.sentTo('/admin/users/sam')).toEqual([['DELETE', { confirm: 'SAM@example.test' }]]);
});

test('a recipe is unpublished with a note, then restored', async ({ page }) => {
  const api = await adminConsole(page, 'recipes');
  await page.getByRole('button', { name: 'Copied carbonara', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Copied carbonara', exact: true })).toBeVisible();
  await expect(sheet(page).getByText('Published', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Moderation', exact: true }).click();
  await ask(page, 'Unpublish', 'Unpublish this recipe?');
  await page
    .getByRole('textbox', { name: 'Note for other admins (optional)', exact: true })
    .fill('Copied from another site');
  await page.getByRole('button', { name: 'Unpublish', exact: true }).click();
  await expect(sheet(page).getByText('Recipe unpublished.', { exact: true })).toBeVisible();
  await expect(sheet(page).getByText('Unpublished by an admin', { exact: true })).toBeVisible();
  await expect(
    sheet(page).getByText(/by owner@example\.test; its author can’t publish it/),
  ).toBeVisible();
  await ask(page, 'Restore to public', 'Restore this recipe?');
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(sheet(page).getByText('Recipe restored.', { exact: true })).toBeVisible();
  await expect(sheet(page).getByText('Published', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore to public' })).toHaveCount(0);
  expect(api.sentTo('/admin/recipes/carbonara/published')).toEqual([
    ['PUT', { published: false, note: 'Copied from another site' }],
    ['PUT', { published: true }],
  ]);
});

test('a job with the provider is cancelled, and a live voice session ended', async ({ page }) => {
  const api = await adminConsole(page, 'ai');
  // The live session ends within seconds; the console says it's ending.
  await ask(page, 'End Sam Spam’s voice session', 'End this voice session?');
  await expect(
    page.getByText(
      'Sam Spam’s live conversation closes within a few seconds. The chat history is kept.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Ending Sam Spam’s voice session.', { exact: true })).toBeVisible();
  await expect(page.getByText('Ending', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'End Sam Spam’s voice session' })).toHaveCount(0);
  expect(api.sentTo('/admin/voice/call/end')).toEqual([['POST', undefined]]);

  // A job still running at the provider can't be cancelled (the API refuses), so none is offered.
  await page.getByRole('tab', { name: 'Jobs', exact: true }).click();
  const jobRow = (kind: string) =>
    page.getByRole('button', { name: kind, exact: true }).filter({ hasText: sam.email });
  await jobRow('Recipe draft').click();
  await expect(page.getByRole('heading', { name: 'Recipe draft job', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel job' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // One the provider is processing can, keeping its reserved cost.
  await jobRow('Video').click();
  await expect(page.getByRole('heading', { name: 'Video job', exact: true })).toBeVisible();
  await ask(page, 'Cancel job', 'Cancel this job?');
  await expect(
    page.getByText(
      'The provider already has this task and may still finish and bill it, so its reserved cost stays.',
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Cancel job', exact: true }).click();
  await expect(sheet(page).getByText('Job cancelled.', { exact: true })).toBeVisible();
  await expect(
    sheet(page).getByText(
      'Cancelled by an admin. The provider may still finish and bill this task.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel job' })).toHaveCount(0);
  expect(api.sentTo('/admin/jobs/clip/cancel')).toEqual([['POST', undefined]]);
  expect(api.sentTo(/^\/admin\/jobs\/draft/)).toEqual([]);
});

test('a sous-chef turn shows its rounds, tools and reply', async ({ page }) => {
  await adminConsole(page, 'ai');
  await page.getByRole('tab', { name: 'Turns', exact: true }).click();
  const row = page.getByRole('button', { name: /^Chat turn · Sam Spam/ });
  await expect(row).toContainText('2 rounds · get_recipe, plan_meal · 1 tool error');
  await row.click();
  await expect(page.getByRole('heading', { name: 'Chat turn', exact: true })).toBeVisible();
  await expect(sheet(page).getByText('2.4 s', { exact: true })).toBeVisible();
  await expect(sheet(page).getByText('get_recipe · 40 ms', { exact: true })).toBeVisible();
  await expect(
    sheet(page).getByText('plan_meal · 35 ms · Recipe not found.', { exact: true }),
  ).toBeVisible();
  await expect(sheet(page).getByText('Answered in text.', { exact: true })).toBeVisible();
  await expect(
    sheet(page).getByText('That recipe isn’t there any more.', { exact: true }),
  ).toBeVisible();
});
