export type Ingredient = { name: string; amount: number; unit: string; category: string };
export type RecipeStep = {
  title: string;
  text: string;
  seconds: number;
  /** A photo of this step (a media URL); missing or '' for none. */
  image?: string;
  /** A short clip of this step (a media URL); missing or '' for none. */
  video?: string;
};
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
  /**
   * The language the recipe is written in ('en', 'fr'…), '' when nobody said. Left out or '', the
   * server keeps what's saved.
   */
  language?: string;
  /** The page an imported recipe came from; '' for none. Left out, the server keeps what's saved. */
  sourceUrl?: string;
  /**
   * The recipe this one adapts. A save sends the original's id (left out, the server keeps what's
   * saved); recipes from the server carry the original itself, or null.
   */
  derivedFrom?: string | RecipeOrigin | null;
};
/** The recipe an adaptation came from, as recipes from the server name it. */
export type RecipeOrigin = {
  id: string;
  title: string;
  author: { id: string; name: string; handle: string };
};
export type Recipe = Omit<RecipeInput, 'derivedFrom'> & {
  id: string;
  author: Creator;
  rating: number;
  reviewCount: number;
  saveCount: number;
  createdAt: string;
  /** The recipe this one adapts; null or missing for an original. */
  derivedFrom?: RecipeOrigin | null;
  /** Published recipes adapted from this one. Missing on older servers. */
  variationCount?: number;
  /** Comments, replies included. Missing on older servers. */
  commentCount?: number;
  /** Cooks who marked it as cooked. Missing on older servers. */
  cookedCount?: number;
  /** Its allergen and diet groups, read from the ingredient names. Missing on older servers. */
  allergens?: string[];
  /** What each ingredient is, in the same order as `ingredients`. Missing on older servers. */
  ingredientFood?: IngredientFood[];
};
/**
 * What the server's ingredient lexicon reads in one ingredient line: what it is (`key`, which the
 * pantry's `pantryCover` names too), its allergen and diet groups (`milk`, `peanut`, `pork`…), and
 * the words an avoid list's terms are matched against.
 */
export type IngredientFood = { key: string; allergens: string[]; terms: string[] };
/**
 * What a member avoids, read from their diets and allergies: groups (`peanut`) and their own words
 * (`kiwi`, or an ingredient's key like `cilantro`), each with what they wrote that leads to it.
 */
export type Avoid = { groups: Record<string, string[]>; terms: Record<string, string[]> };
/** How recipe amounts show: as their cooks wrote them (''), or converted. */
export type Units = '' | 'metric' | 'imperial';
/** The same choice, as the recipe page names it. */
export type UnitChoice = Units;
/** Which push notifications the member wants; each is on unless turned off. */
export type NotificationPreferences = {
  follows: boolean;
  pantry: boolean;
  reviews: boolean;
  comments: boolean;
};
export type Preferences = {
  diets: string[];
  allergies: string[];
  /** Older servers leave these out: as written, no language yet, everything on. */
  units?: Units;
  /** The app's language, which notifications are written in ('' until one is chosen). */
  language?: string;
  notifications?: Partial<NotificationPreferences>;
};
export type User = Creator & {
  email: string;
  /** False until the address is confirmed with a code; older servers leave it out. */
  emailVerified?: boolean;
  preferences: Preferences;
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
  /** What recipe pages warn this member about. Missing on older servers. */
  avoid?: Avoid;
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
  /** Later than createdAt once the review is rewritten. Missing on older servers. */
  updatedAt?: string;
  author: Creator;
  /** The recipe author's answer; null or missing when there is none. */
  reply?: ReviewReply | null;
};
export type ReviewReply = { body: string; repliedAt: string };
/** Who wrote a comment or a cook's note. */
export type Commenter = { id: string; name: string; handle: string; avatar: string };
export type RecipeComment = {
  id: string;
  body: string;
  /** The comment this replies to; replies go one level deep. */
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
  author: Commenter;
  /** The signed-in cook may delete it: their own comment, or any on their recipe. */
  canDelete: boolean;
};
/** One cook's "I cooked this", with an optional photo and note. */
export type RecipeCook = {
  id: string;
  photo: string;
  note: string;
  createdAt: string;
  author: Commenter;
};
export type Library = {
  savedIds: string[];
  saves: { recipeId: string; collectionId: string | null }[];
  collections: Collection[];
  followingIds: string[];
  recipes: Recipe[];
  /** Recipes the cook marked as cooked. Missing on older servers. */
  cookedIds?: string[];
  /** Every recipe the cook wrote, drafts too, newest first. Missing on older servers. */
  ownIds?: string[];
  /** How many of the cook's recipes are published. Missing on older servers. */
  publishedCount?: number;
  /**
   * More recipes than `recipes` holds (GET /library?limit=); page through them with
   * GET /library/recipes. Older servers send the whole library and leave this out.
   */
  hasMore?: boolean;
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
  /** Who put it on a household's shared list; null for older items (and missing on older servers). */
  addedBy?: { id: string; name: string } | null;
};
export type PantryItem = { id: string; name: string; quantity: string; expiresOn: string | null };
export type Kitchen = {
  plans: Plan[];
  groceries: Grocery[];
  pantry: PantryItem[];
  /** The ingredient keys the pantry has (cheddar also covers cheese). Missing on older servers. */
  pantryCover?: string[];
};
/** A recipe the pantry goes far toward (GET /kitchen/pantry-recipes), with ingredient names. */
export type PantryMatch = { recipe: Recipe; have: string[]; missing: string[]; expiring: string[] };
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
/** A photo or clip to make from a description (the editor's Create a cover photo or clip). */
export type AIRequest = {
  kind: 'image' | 'video';
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
  /** Password-reset email is configured, and with it email confirmation and email changes. */
  passwordRecovery?: boolean;
  /** Cloudflare Turnstile's public site key; '' (or missing) when sign-up has no check. */
  turnstileSiteKey?: string;
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
/** What a start of the sous-chef brings besides its mode. */
export type StudioStart = {
  /** A screen's prompt (the home's ideas, the planner), sent as the first message. */
  message?: string;
  /** From Create a recipe: the conversation is for writing a new recipe. */
  recipe?: boolean;
};
export type StudioEvent = {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  imageCount: number;
  /** Recipe cards the sous-chef showed with this reply. */
  recipes?: { id: string; title: string; image: string; minutes: number; cuisine: string }[];
  /** Things the sous-chef does on screen when this reply arrives. */
  actions?: AppAction[];
  /** The reply's turn changed the member's data. Older servers leave it out. */
  changed?: boolean;
  /** What the reply's turn did, as receipts under it. Older servers leave it out. */
  effects?: StudioEffect[];
  /** The reply says its turn failed (or was stopped). */
  failed?: boolean;
};
/** Something a sous-chef reply did to the member's data, shown as a receipt under it. */
export type StudioEffect = {
  kind:
    | 'groceries'
    | 'plan'
    | 'pantry'
    | 'saved'
    | 'unsaved'
    | 'followed'
    | 'unfollowed'
    | 'cookbook'
    | 'checked'
    | 'unchecked'
    | 'removed'
    | 'recipe'
    | 'deleted'
    | 'draft'
    | 'published'
    | 'profile'
    | 'review'
    | 'report'
    | 'media'
    | 'cooked';
  count?: number;
  title?: string;
  /** A recipe to open from the receipt. */
  recipe?: string;
  /** A page to open from the receipt. */
  page?: Screen;
  undoable?: boolean;
  undone?: boolean;
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
  /** The interface language for replies the server writes itself; defaults to the app's. */
  language?: string;
};
export type StudioProject = {
  voiceSession?: { id: string; status: string } | null;
  id: string;
  /** The conversation's first message. */
  title?: string | null;
  /** What the app last opened it for: "recipe" from Create a recipe. Older servers leave it out. */
  purpose?: string;
  /**
   * What the sous-chef waits for a yes to: an action it proposed, or publishing the draft it just
   * read back. Answering with a tap sends `answer` and this `seq`. Older servers leave it out.
   */
  question?: { kind: 'action' | 'publish'; seq: number; description?: string } | null;
  /** The reply on its way: what it's doing now, and whether it was asked to stop. */
  turn?: { step: string; stopping: boolean } | null;
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

/** One of the member's cookbooks (a library collection). Older servers leave out the last two. */
export type Collection = {
  id: string;
  name: string;
  /** Anyone with the link can see the cookbook and the published recipes in it. */
  public?: boolean;
  description?: string;
};
/** A cookbook page, GET /cookbooks/:id: public ones for everyone, private ones for their owner. */
export type PublicCookbook = {
  id: string;
  name: string;
  description: string;
  public: boolean;
  owner: Creator;
  recipes: Recipe[];
};
/** A cook's public cookbook as their profile lists it (GET /creators/:id/cookbooks). */
export type CookbookSummary = {
  id: string;
  name: string;
  description: string;
  recipeCount: number;
  /** A photo from the cookbook, or ''. */
  cover: string;
};
/** One page of the library: GET /library/recipes. */
export type LibraryPage = { recipes: Recipe[]; hasMore: boolean };
/** What putting recipes on the grocery list did: new lines, and lines folded into matching ones. */
export type GroceryMerge = {
  added: number;
  merged: number;
  /** With skipPantry: the ingredients left off because the pantry (or any kitchen) has them. */
  skipped?: string[];
};
export type HouseholdRole = 'owner' | 'member';
export type HouseholdMember = {
  id: string;
  name: string;
  handle: string;
  avatar: string;
  role: HouseholdRole;
};
/** The kitchen's household (GET /household), whose members share one grocery list. */
export type Household = {
  id: string;
  name: string;
  /** The signed-in member's role. */
  role: HouseholdRole;
  members: HouseholdMember[];
};
/** An invite code (8 letters and digits) and when it stops working. */
export type HouseholdInvite = { code: string; expiresAt: string };
/** A signed-in device, as GET /me/sessions lists it (this one first). */
export type DeviceSession = {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  userAgent: string;
  /** Savorly, a browser's name, or '' when unknown. */
  client: string;
  /** iPhone, iPad, iOS, Android, macOS, Windows, ChromeOS, Linux, or ''. */
  system: string;
  current: boolean;
};
