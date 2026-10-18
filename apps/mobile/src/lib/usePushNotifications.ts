import { useEffect, useEffectEvent, useRef } from 'react';
import { api } from './api';
import { useI18n } from './i18n';
import { onPushTap, onPushTokenChange, pushSupported, refreshPush } from './push';
import { useApp } from './store';
import { AppAction } from './types';

/**
 * Notifications for the app shell, mounted once:
 * - a tapped notification becomes an app action: a recipe opens, a pantry reminder goes to the
 *   pantry and a renewal reminder to My kitchen, where the plan is (`onAction` is the shell's own
 *   handler, as for the sous-chef's actions);
 * - while someone is signed in, this phone registers its push token again whenever notifications
 *   are already allowed, since the token can change (asking happens only in NotificationSettings);
 * - the account's language follows the app's, since notifications are written in it: a change made
 *   here is sent (the last of quick changes, and failures are ignored), and a phone also fills in
 *   an account that has no language yet.
 * The web has only the language part.
 */
export function usePushNotifications(onAction: (action: AppAction) => void) {
  const app = useApp();
  const { t, language } = useI18n();
  const userId = app.user?.id;
  const stored = app.user?.preferences.language ?? '';
  // Android's name for the channel the notifications arrive on, shown in its settings.
  const channel = t('Recipes and reminders');
  const follow = useEffectEvent(onAction);
  useEffect(
    () =>
      onPushTap((target) =>
        follow(
          target.type === 'recipe'
            ? { type: 'open_recipe', recipeId: target.recipeId }
            : { type: 'go_to', page: target.type === 'plan' ? 'profile' : 'pantry' },
        ),
      ),
    [],
  );
  useEffect(() => {
    if (!userId || !pushSupported) return;
    void refreshPush(channel);
    return onPushTokenChange(() => void refreshPush(channel));
  }, [userId, channel]);
  // The language last seen, a change made here that isn't sent yet, and what this app last sent.
  const seen = useRef(language);
  const wanted = useRef<string | null>(null);
  const sent = useRef<{ userId: string; language: string } | null>(null);
  useEffect(() => {
    if (seen.current !== language) {
      seen.current = language;
      wanted.current = language;
    }
    if (!userId) return;
    const account = sent.current?.userId === userId ? sent.current.language : stored;
    const next = wanted.current ?? (pushSupported && !account ? language : null);
    if (!next || next === account) {
      wanted.current = null;
      return;
    }
    const timer = setTimeout(() => {
      wanted.current = null;
      sent.current = { userId, language: next };
      void api('/me/preferences', { method: 'PATCH', body: { language: next } }).catch(() => {
        if (sent.current?.language === next) sent.current = null;
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, [userId, language, stored]);
}
