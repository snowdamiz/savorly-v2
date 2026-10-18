// Printing is a web feature (printRecipe.web.ts); the apps share recipes instead.

/** A recipe as the printed page shows it, with every label already in the reader's language. */
export type PrintableRecipe = {
  /** The document's language, such as "fr-FR". */
  lang: string;
  title: string;
  /** "by Robin". */
  byline: string;
  /** Short facts under the title: time, servings. */
  facts: string[];
  description: string;
  /** The cover photo's address, or ''. */
  image: string;
  ingredientsTitle: string;
  /** Each ingredient with its amount in the units and servings on screen ('' for none). */
  ingredients: { name: string; amount: string }[];
  equipmentTitle?: string;
  /** What else to get out: the cook's list, or what the method mentions. Left out for none. */
  equipment?: string[];
  methodTitle: string;
  steps: { title: string; text: string }[];
  /** Attribution lines at the end, such as where the recipe was adapted or imported from. */
  credits: string[];
  /** The recipe's address on the web. */
  link: string;
};

/** Whether this platform can print a recipe. */
export const canPrint = false;

/** Prints the recipe; does nothing where printing isn't offered. */
export function printRecipe(recipe: PrintableRecipe): void {
  void recipe;
}
