import { Linking, Platform, Share } from 'react-native';
import type { Grocery } from './types';

/**
 * Instacart delivers in the United States and Canada, so ordering is offered where the app's
 * locale says the cook is (en-US, fr-CA…). Elsewhere the list is shared as text, which works with
 * any store's app.
 */
export const orderingRegion = (locale: string) => /-(US|CA)\b/i.test(locale);

/** Instacart's page opens beside the app: a new tab on the web, the browser or its app on phones. */
export async function openOrder(url: string) {
  if (Platform.OS === 'web') window.open(url, '_blank', 'noopener');
  else await Linking.openURL(url);
}

/** The list as plain text, one line each with its quantity, for a message or another app. */
export const groceryText = (title: string, groceries: Grocery[]) =>
  [
    title,
    ...groceries
      .filter((g) => !g.checked)
      .map((g) => `• ${g.name}${g.quantity ? ` — ${g.quantity}` : ''}`),
  ].join('\n');

/**
 * Shares text through the system's share sheet, or copies it on a desktop browser without one.
 * Answers whether it was copied, so the caller can say so.
 */
export async function shareText(text: string): Promise<'shared' | 'copied'> {
  if (Platform.OS === 'web' && !navigator.share) {
    await navigator.clipboard.writeText(text);
    return 'copied';
  }
  if (Platform.OS === 'web') await navigator.share({ text });
  else await Share.share({ message: text });
  return 'shared';
}
