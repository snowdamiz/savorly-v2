import React, { useState } from 'react';
import { View } from 'react-native';
import { useI18n } from '../lib/i18n';
import { useApp } from '../lib/store';
import { api } from '../lib/api';
import { groceryText, openOrder, orderingRegion, shareText } from '../lib/groceryCheckout';
import { s } from '../lib/theme';
import { Share2, ShoppingBasket } from './icons';
import { Button } from './ui';

/**
 * What to do with the list once it's written: order it through Instacart where it delivers, or
 * share it as text with anyone or any store's app. Ordering opens Instacart's page, where the cook
 * picks a store and checks out; nothing is bought in Savorly.
 */
export function GroceryCheckout() {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  const [busy, setBusy] = useState(false);
  const left = app.kitchen.groceries.filter((g) => !g.checked);
  if (!left.length) return null;
  const ordering = app.capabilities?.groceryCheckout === 'instacart' && orderingRegion(locale);
  const order = () => {
    if (busy) return;
    setBusy(true);
    void app
      .act(async () => {
        const { url } = await api<{ url: string }>('/groceries/checkout', { method: 'POST' });
        await openOrder(url);
      })
      .finally(() => setBusy(false));
  };
  const share = () =>
    void app.act(async () => {
      const how = await shareText(groceryText(tr('Groceries'), app.kitchen.groceries));
      if (how === 'copied') app.notify(tr('List copied to your clipboard.'));
    });
  return (
    <View style={[s.row, { gap: 10, flexWrap: 'wrap' }]}>
      {ordering && (
        <Button
          title={tr('Order with Instacart')}
          icon={ShoppingBasket}
          busy={busy}
          onPress={order}
          style={{ flexGrow: 1 }}
        />
      )}
      <Button
        title={tr('Share list')}
        icon={Share2}
        variant="secondary"
        onPress={share}
        style={{ flexGrow: 1 }}
      />
    </View>
  );
}

/** A recipe page's way to order what it needs, less what the pantry has, where ordering works. */
export function RecipeOrder({ recipeId, servings }: { recipeId: string; servings: number }) {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  const [busy, setBusy] = useState(false);
  if (app.capabilities?.groceryCheckout !== 'instacart' || !orderingRegion(locale)) return null;
  return (
    <Button
      title={tr('Get the ingredients delivered')}
      icon={ShoppingBasket}
      variant="secondary"
      busy={busy}
      onPress={() => {
        if (busy || !app.requireUser()) return;
        setBusy(true);
        void app
          .act(async () => {
            const { url } = await api<{ url: string }>(`/recipes/${recipeId}/checkout`, {
              method: 'POST',
              body: { servings, skipPantry: true },
            });
            await openOrder(url);
          })
          .finally(() => setBusy(false));
      }}
    />
  );
}
