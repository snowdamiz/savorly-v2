import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

const native = requireOptionalNativeModule<{ countryCode(): Promise<string | null> }>('Storefront');

/** The App Store storefront's alpha-3 country ("USA"), or null off iOS or when unknown. */
export async function storefrontCountry(): Promise<string | null> {
  if (Platform.OS !== 'ios' || !native) return null;
  return native.countryCode().catch(() => null);
}
