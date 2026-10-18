/// <reference types="jest" />
import { translator } from '../i18n/core';
import en from '../i18n/locales/en.json';
import ru from '../i18n/locales/ru.json';
import { countryName, regionOf } from '../creatorFund';

describe('the payout country a creator is offered first', () => {
  test('comes from the region in a locale tag', () => {
    expect(regionOf('fr-CA')).toBe('CA');
    expect(regionOf('zh-Hans-CN')).toBe('CN');
    expect(regionOf('pt_br')).toBe('BR');
    expect(regionOf('en')).toBe('');
    expect(regionOf('')).toBe('');
  });
  test('is named in the app’s language, or by its code', () => {
    expect(countryName('DE', 'en-US')).toMatch(/Germany|DE/);
    expect(countryName('not a code', 'en-US')).toBe('not a code');
  });
});

describe('creator fund messages', () => {
  test('count cooks and minutes in each language’s plural forms', () => {
    const t = translator('ru', 'ru-RU', ru, en);
    expect(t('verifiedCooksThisMonth', { count: 1 })).toBe(
      'Подтверждённое приготовление в этом месяце',
    );
    expect(t('verifiedCooksThisMonth', { count: 3 })).toBe(
      'Подтверждённых приготовления в этом месяце',
    );
    expect(t('paidCookCount', { count: 5 })).toBe('5 приготовлений платными участниками');
    const english = translator('en', 'en-US', en, en);
    expect(english('cooksUsuallyTake', { count: 45 })).toBe('Cooks usually take about 45 min');
    expect(
      english(
        'Each month, {{percent}}% of what members pay goes to the cooks whose recipes they actually cooked.',
        { percent: 20 },
      ),
    ).toBe(
      'Each month, 20% of what members pay goes to the cooks whose recipes they actually cooked.',
    );
  });
});
