import { Linking, Platform } from 'react-native';
import { storefrontCountry } from '../../modules/storefront';

/**
 * Where the app may show plan prices and link to web checkout without a store commission:
 * the web, and iOS on the US App Store storefront (allowed at 0% since Epic v. Apple).
 * Android stays consumption-only, since Play's in-app links cost 10% even in the US, and
 * so does iOS on other storefronts, where steering to the web isn't allowed. Plans bought
 * on the web unlock everywhere. See docs/PRICING.md.
 */
export async function canSellHere(): Promise<boolean> {
  if (Platform.OS === 'web') return true;
  if (Platform.OS === 'ios') return (await storefrontCountry()) === 'USA';
  return false;
}

/** Stripe pages open in the browser, never inside the app. */
export async function openBilling(url: string) {
  if (Platform.OS === 'web') window.location.assign(url);
  else await Linking.openURL(url);
}
