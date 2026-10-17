// Shapes returned by the admin API (services/api/internal/app/admin*.go).
import { AIJob, AIKind, PlanID, Recipe } from './types';

export type AdminSection =
  'overview' | 'reports' | 'members' | 'recipes' | 'reviews' | 'ai' | 'settings' | 'audit';
export type Paged<T> = { items: T[]; total: number; offset: number; limit: number };

export type AdminSettings = {
  aiPaused: boolean;
  aiDailyBudgetUSD: number | null;
  aiFreeDailyBudgetUSD: number | null;
  signupsPaused: boolean;
  announcement: string;
  announcementTone: 'info' | 'warning';
};
export type SettingsReply = {
  settings: AdminSettings;
  defaults: { aiDailyBudgetUSD: number; aiFreeDailyBudgetUSD: number };
  /** The highest overrides allowed: ten times the defaults. Missing from older APIs. */
  budgetLimits?: { aiDailyBudgetUSD: number; aiFreeDailyBudgetUSD: number };
  /** Only owners change the budgets. Missing from older APIs. */
  canChangeBudgets?: boolean;
  /** Send it back unchanged as expectedUpdatedAt, so a stale save answers 409. */
  updatedAt: string | null;
  updatedBy: string | null;
};

export type Day = { day: string; signups: number; recipes: number; jobs: number; spend: number };
/**
 * GET /admin/insights?days=7|30: the app's own anonymous events (services/api/internal/app/events.go).
 * Setup steps count people; the rest count events. `onboarding` ends with `done` and `skipped`.
 */
export type Insights = {
  days: number;
  topSearches: { query: string; count: number }[];
  zeroResultSearches: { query: string; count: number }[];
  onboarding: { step: string; count: number }[];
  events: { name: string; count: number }[];
};
export type Overview = {
  stats: {
    members: {
      total: number;
      new24h: number;
      new7d: number;
      new30d: number;
      verified: number;
      suspended: number;
      admins: number;
      withPassword: number;
      active7d: number;
    };
    samples: number;
    plans: Partial<Record<PlanID, number>>;
    comped: number;
    identities: Partial<Record<'apple' | 'google', number>>;
    recipes: {
      published: number;
      drafts: number;
      aiGenerated: number;
      new7d: number;
      withVideo: number;
    };
    community: {
      reviews: number;
      reviews7d: number;
      follows: number;
      saves: number;
      cookbooks: number;
      mealPlans: number;
    };
    reports: { open: number; recipes: number };
    jobs: {
      queued: number;
      running: number;
      processing: number;
      failed24h: number;
      completed24h: number;
      oldestQueuedSeconds: number;
    };
    assistant: { queued: number; running: number; failed24h: number; turns24h: number };
    conversations: { total: number; active7d: number };
    voiceLive: number;
    spend: { last24h: number; free24h: number; last7d: number; last30d: number };
    spendBySource: {
      media: number;
      tools: number;
      assistant: number;
      narration: number;
      voice: number;
    };
    migration: string;
    databaseBytes: number;
  };
  series: Day[];
  budget: {
    daily: number;
    freeDaily: number;
    baseDaily: number;
    baseFreeDaily: number;
    memberFreeShare: number;
    memberPaidShare: number;
    paused: boolean;
  };
  settings: AdminSettings;
  system: {
    environment: string;
    owners: string[];
    ownersMustVerify: boolean;
    paidPlans: boolean;
    billing: boolean;
    media: boolean;
    email: boolean;
    appleSignIn: boolean;
    googleSignIn: boolean;
    textAI: boolean;
    videoAI: boolean;
    voiceAI: boolean;
    narration: boolean;
    models: Record<string, string>;
  };
};

export type AdminMember = {
  id: string;
  name: string;
  email: string;
  handle: string;
  avatar: string;
  createdAt: string;
  plan: PlanID;
  planStatus: string;
  comped: boolean;
  emailVerified: boolean;
  /** False while the new-kitchen setup is waiting for them. */
  onboarded?: boolean;
  hasPassword: boolean;
  /** A fixture cook from SEED_DATA. */
  sample: boolean;
  identities: ('apple' | 'google')[];
  admin: boolean;
  owner: boolean;
  /** The address is in ADMIN_EMAILS, verified or not. */
  ownerEmail: boolean;
  suspendedAt: string | null;
  suspendedReason: string;
  recipeCount: number;
  publishedCount: number;
  openReports: number;
  spend30d: number;
  lastSignInAt: string | null;
};
export type AuditEntry = {
  id: number;
  adminId: string | null;
  adminEmail: string;
  action: string;
  targetType: '' | 'user' | 'recipe' | 'review' | 'job' | 'voice' | 'settings';
  targetId: string;
  summary: string;
  detail: Record<string, unknown>;
  createdAt: string;
};
export type AdminMemberDetail = AdminMember & {
  bio: string;
  preferences: { diets: string[]; allergies: string[] };
  planInterval: string;
  planRenewsAt: string | null;
  planCancels: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string;
  appointedAdmin: boolean;
  activeSessions: number;
  counts: Record<
    | 'reviews'
    | 'saves'
    | 'cookbooks'
    | 'followers'
    | 'following'
    | 'conversations'
    | 'mealPlans'
    | 'pantry'
    | 'reportsFiled'
    | 'aiJobs',
    number
  >;
  recipes: {
    id: string;
    title: string;
    image: string;
    published: boolean;
    aiGenerated: boolean;
    createdAt: string;
    openReports: number;
  }[];
  reviews: {
    id: string;
    rating: number;
    body: string;
    createdAt: string;
    recipe: { id: string; title: string };
  }[];
  jobs: {
    id: string;
    kind: AIKind;
    status: AIJob['status'];
    error: string;
    cost: number;
    createdAt: string;
  }[];
  reportsFiled: {
    id: string;
    reason: string;
    status: ReportStatus;
    createdAt: string;
    recipe: { id: string; title: string };
  }[];
  history: AuditEntry[];
  usage: {
    assistant: number;
    voiceSeconds: number;
    images: number;
    videos: number;
    narration: number;
  };
  /** Null while paid plans are off and everyone is unlimited. */
  limits: {
    assistant: number;
    voiceMinutes: number;
    images: number;
    videos: number;
    narration: number;
    spendCap: number;
  } | null;
};

type Person = { id: string; name: string; email: string; avatar: string };
export type ReportStatus = 'open' | 'resolved' | 'dismissed';
export type Report = {
  id: string;
  reason: string;
  status: ReportStatus;
  createdAt: string;
  resolution: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  reporter: Person;
};
export type ReportGroup = {
  recipe: { id: string; title: string; image: string; published: boolean; createdAt: string };
  author: Person & { suspended: boolean };
  count: number;
  latestAt: string;
  reports: Report[];
};
export type AdminRecipe = {
  id: string;
  title: string;
  image: string;
  cuisine: string;
  published: boolean;
  aiGenerated: boolean;
  video: boolean;
  createdAt: string;
  updatedAt: string;
  /** Set while an admin's unpublish holds it out of public view. Missing from older APIs. */
  unpublishedByAdminAt?: string | null;
  author: Person & { handle: string; suspended: boolean };
  rating: number;
  reviewCount: number;
  saveCount: number;
  openReports: number;
  reportCount: number;
};
export type AdminRecipeDetail = Recipe & {
  updatedAt: string;
  /** Set while an admin's unpublish holds it out of public view. Missing from older APIs. */
  unpublishedByAdminAt?: string | null;
  unpublishedBy?: string;
  authorEmail: string;
  authorSuspended: boolean;
  conversations: number;
  reports: Report[];
  history: AuditEntry[];
};
export type AdminReview = {
  id: string;
  rating: number;
  body: string;
  createdAt: string;
  author: Person & { suspended: boolean };
  recipe: { id: string; title: string; image: string; published: boolean };
};
export type AdminJob = {
  id: string;
  kind: AIKind;
  status: AIJob['status'];
  error: string;
  cost: number;
  providerId: string;
  createdAt: string;
  updatedAt: string;
  user: Person;
  prompt?: string;
  result?: { text?: string; url?: string; recipe?: { title?: string } };
};
/** A sous-chef turn, as the console lists it; one turn's own read adds trace, step and reply. */
export type AdminTurn = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  channel: 'text' | 'voice';
  cost: number;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  project: string;
  model: string;
  /** How long the worker spent on it, once it settled. */
  ms: number | null;
  rounds: number;
  tools: string[];
  toolErrors: number;
  user: Person;
  trace?: {
    model?: string;
    channel?: string;
    ms: number;
    error?: string;
    rounds: { ms: number; cost: number; tools?: { name: string; ms: number; error?: string }[] }[];
  };
  step?: string;
  reply?: string;
};
export type AdminAI = {
  voice: {
    id: string;
    status: string;
    createdAt: string;
    heartbeatAt: string;
    reservedSeconds: number;
    seconds: number;
    closeRequested: boolean;
    user: Person;
  }[];
  spenders: (Person & { plan: PlanID; spend: number })[];
  kinds: { kind: AIKind; jobs: number; failed: number; spend: number }[];
  assistant: { turns: number; failed: number; spend: number };
  narration: { clips: number; spend: number };
  voiceTotals: { sessions: number; minutes: number };
};
