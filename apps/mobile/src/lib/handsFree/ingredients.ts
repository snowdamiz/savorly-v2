import type { Ingredient } from '../types';

// The ingredients hands-free cooking reads out: the whole recipe's, or the ones a step names.

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The recipe's ingredients a step names: by their whole name, or by a word of it at the start of
 * a word in the step ("the tomatoes" for "San Marzano tomatoes", "egg" for "eggs").
 */
export function ingredientsOf(step: { title: string; text: string }, ingredients: Ingredient[]) {
  const text = `${step.title} ${step.text}`.toLowerCase();
  return ingredients.filter((ingredient) => {
    const name = ingredient.name.trim().toLowerCase();
    if (!name) return false;
    if (text.includes(name)) return true;
    return name
      .split(/[\s,()/-]+/)
      .filter((word) => word.length >= 4)
      .some((word) =>
        new RegExp(`(^|[^\\p{L}])${escape(word.replace(/e?s$/, ''))}`, 'u').test(text),
      );
  });
}

/** An ingredient as it's read out: "200 g spaghetti". */
export function spokenIngredient(ingredient: Ingredient, locale: string) {
  const amount =
    ingredient.amount > 0
      ? new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(ingredient.amount)
      : '';
  return [amount, ingredient.unit, ingredient.name].filter(Boolean).join(' ');
}

/** Items as one spoken list in `locale` ("a, b and c"). */
export function spokenList(items: string[], locale: string) {
  try {
    return new Intl.ListFormat(locale, { type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}
