export type Ingredient = { name: string; amount: number; unit: string; category: string };
export type RecipeStep = { title: string; text: string; seconds: number };
export type Creator = {
  id: string;
  name: string;
  handle: string;
  bio: string;
  avatar: string;
  recipeCount?: number;
  followerCount?: number;
};
export type RecipeInput = {
  title: string;
  description: string;
  cuisine: string;
  minutes: number;
  servings: number;
  difficulty: 'Easy' | 'Medium' | 'Advanced';
  image: string;
  /** Extra gallery photos after the cover. Left out, the server keeps whatever is saved. */
  photos?: string[];
  video: string;
  ingredients: Ingredient[];
  steps: RecipeStep[];
  tags: string[];
  calories: number;
  aiGenerated: boolean;
  published: boolean;
};
export type Recipe = RecipeInput & {
  id: string;
  author: Creator;
  rating: number;
  reviewCount: number;
  saveCount: number;
  createdAt: string;
};
export type User = Creator & {
  email: string;
  preferences: { diets: string[]; allergies: string[] };
  /** False for kitchens made with Apple or Google until a password is set by email. */
  hasPassword: boolean;
  identities: ('apple' | 'google')[];
  plan: PlanID;
  /** False until a new kitchen finishes or skips its setup. */
  onboarded?: boolean;
  /** Can open the admin console. */
  admin?: boolean;
  /** An admin listed in ADMIN_EMAILS, who also appoints other admins. */
  adminOwner?: boolean;
  /** An owner's address (ADMIN_EMAILS) that must be verified before the console opens. */
  adminPending?: boolean;
};
export type PlanID = 'free' | 'plus' | 'pro';
/** A subscription plan; `Plan` is a meal-plan entry. */
export type PricePlan = {
  id: PlanID;
  monthlyUSD: number;
  yearlyUSD: number;
  assistant: number;
  voiceMinutes: number;
  images: number;
  videos: number;
  narration: number;
};
export type Billing = {
  plan: PlanID;
  status: string;
  interval: '' | 'monthly' | 'yearly';
  renewsAt: string | null;
  cancels: boolean;
  usage: {
    assistant: number;
    voiceSeconds: number;
    images: number;
    videos: number;
    narration: number;
  };
  plans: PricePlan[];
  /** Stripe checkout is configured on the server. */
  checkout: boolean;
  /** There's a Stripe customer whose subscription can be managed. */
  manage: boolean;
};
export type Review = {
  id: string;
  rating: number;
  body: string;
  createdAt: string;
  author: Creator;
};
export type Library = {
  savedIds: string[];
  saves: { recipeId: string; collectionId: string | null }[];
  collections: { id: string; name: string }[];
  followingIds: string[];
  recipes: Recipe[];
};
export type Plan = {
  id: string;
  recipeId: string;
  day: string;
  meal: string;
  servings: number;
  recipe: Recipe;
};
export type Grocery = {
  id: string;
  name: string;
  quantity: string;
  category: string;
  checked: boolean;
};
export type PantryItem = { id: string; name: string; quantity: string; expiresOn: string | null };
export type Kitchen = { plans: Plan[]; groceries: Grocery[]; pantry: PantryItem[] };
export type AIKind =
  'recipe' | 'adapt' | 'substitute' | 'nutrition' | 'plan' | 'assistant' | 'image' | 'video';
export type AIJob = {
  id: string;
  kind: AIKind;
  prompt: string;
  /** The photo a touch-up started from; empty for everything made from a prompt. */
  source?: string;
  status: 'queued' | 'running' | 'processing' | 'completed' | 'failed';
  result: { text?: string; recipe?: RecipeInput; url?: string };
  error: string;
  createdAt: string;
};
// One request to the sous-chef sheet. `prompt` runs immediately; `suggestions` run on one tap.
export type AIRequest = {
  kind: AIKind;
  title: string;
  context?: string;
  prompt?: string;
  suggestions?: string[];
  placeholder?: string;
  onMedia?: (url: string) => void;
};
export type Announcement = { text: string; tone: 'info' | 'warning' };
export type Capabilities = {
  /** Set from the admin console; shown to everyone until dismissed. */
  announcement?: Announcement | null;
  cookingNarration?: boolean;
  cookingNarrationModel?: string;
  voiceAI: boolean;
  voiceModel: string;
  voicePerMinuteUSD: number;
  recipeChat: boolean;
  recipePhotos: boolean;
  textAI: boolean;
  imageAI: boolean;
  videoAI: boolean;
  videoProvider: string;
  videoModel: string;
  videoEstimateUSD: number;
  /** Plans and allowances are live (PAID_PLANS); until then everyone has unlimited use. */
  plans?: boolean;
  billing?: boolean;
  /** Password-reset email is configured. */
  passwordRecovery?: boolean;
  appleSignIn?: boolean;
  googleSignIn?: boolean;
  auth?: {
    googleWebClientId: string;
    googleIosClientId: string;
    appleServicesId: string;
    appleRedirectUri: string;
  };
};
export type Screen =
  | 'discover'
  | 'explore'
  | 'saved'
  | 'planner'
  | 'pantry'
  | 'profile'
  | 'create'
  | 'community'
  | 'admin';
export const emptyRecipe = (): RecipeInput => ({
  title: '',
  description: '',
  cuisine: 'Italian',
  minutes: 20,
  servings: 2,
  difficulty: 'Easy',
  image: '',
  photos: [],
  video: '',
  ingredients: [{ name: '', amount: 1, unit: '', category: 'Produce' }],
  steps: [{ title: '', text: '', seconds: 0 }],
  tags: [],
  calories: 0,
  aiGenerated: false,
  published: true,
});

export type StudioMode = 'voice' | 'photo' | 'chat';
export type StudioEvent = {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  imageCount: number;
  /** Recipe cards the sous-chef showed with this reply. */
  recipes?: { id: string; title: string; image: string; minutes: number; cuisine: string }[];
  /** Things the sous-chef does on screen when this reply arrives. */
  actions?: AppAction[];
};
export type AppAction =
  | { type: 'open_recipe'; recipeId: string }
  | { type: 'start_cooking'; recipeId: string; step?: number }
  | { type: 'cooking_step'; step: number }
  | { type: 'start_timer' }
  | { type: 'go_to'; page: Screen }
  | { type: 'set_language'; language: string };
/** A sous-chef request to cooking mode; `n` makes each request distinct. */
export type CookCommand = { step?: number; timerFrom?: number; n: number };
/** What the user has open, so "this recipe" and "next step" mean something. */
export type StudioContext = {
  screen: Screen;
  /** The page's name as the user sees it. */
  title: string;
  recipe: { id: string; title: string } | null;
  cookingStep: number | null;
};
export type StudioProject = {
  voiceSession?: { id: string; status: string } | null;
  id: string;
  /** The conversation's first message. */
  title?: string | null;
  recipeId: string | null;
  recipe: Recipe | null;
  revision: number;
  status: 'listening' | 'draft' | 'generating' | 'ready' | 'needs_attention' | 'published';
  busy: boolean;
  reply: string;
  error: string;
  updatedAt: string;
  assets: { kind: 'image' | 'video'; status: AIJob['status']; error: string; url?: string }[];
};
