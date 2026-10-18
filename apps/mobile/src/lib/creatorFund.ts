import { getLocales } from 'expo-localization';

/** A closed month of a creator's earnings (GET /me/earnings). Months are YYYY-MM-01, in UTC. */
export type EarningsMonth = {
  month: string;
  amountCents: number;
  /** Verified cooks by paying members the amount came from. */
  cooks: number;
  status: 'pending' | 'paid';
  paidAt: string | null;
};
/** A creator's payout setup with Stripe Connect. */
export type PayoutSetup = {
  connected: boolean;
  enabled: boolean;
  detailsSubmitted: boolean;
  /** An admin is holding payouts; earnings still add up. */
  held: boolean;
  /** Two letters, or '' before an account exists. */
  country: string;
};
/** GET /me/earnings: a creator's side of the creator fund (docs/CREATOR-FUND.md). */
export type Earnings = {
  /** The month so far (YYYY-MM-01). */
  month: string;
  /** Verified cooks of the creator's recipes this month, by anyone. */
  cooks: number;
  /** This month's earnings so far, by the rule that closes the month. */
  estimateCents: number;
  /** Earned in closed months and not paid out yet. */
  balanceCents: number;
  paidCents: number;
  /** The share of members' net subscription revenue the fund pays out, as a percentage. */
  sharePercent: number;
  /** Payouts wait until the balance reaches this. */
  minimumCents: number;
  /**
   * A creator's first payout waits 60 days after their first month closes; this is when, while
   * it's still ahead. Missing on older servers.
   */
  firstPayoutAt?: string | null;
  history: EarningsMonth[];
  payouts: PayoutSetup;
  /** Where Stripe can pay creators out, as two-letter codes. */
  countries: string[];
};

/**
 * The country a locale tag names ('fr-CA' is CA, 'zh-Hans-CN' is CN), upper case, or ''. The app
 * offers it first when a creator sets up payouts.
 */
export function regionOf(locale: string): string {
  const part = locale
    .split(/[-_]/)
    .slice(1)
    .find((p) => /^[a-z]{2}$/i.test(p));
  return part ? part.toUpperCase() : '';
}

/** The device's own region (not the app's language), upper case, or '' when it has none. */
export function deviceRegion(): string {
  try {
    const found = getLocales().find((l) => /^[a-z]{2}$/i.test(l.regionCode || ''));
    return found?.regionCode?.toUpperCase() || '';
  } catch {
    return '';
  }
}

/** A country's name in the app's language, or its code where the platform can't name it. */
export function countryName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}
