import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Text, View } from 'react-native';
import { ArrowLeft, BookOpen, ChevronRight, Lock, Share2 } from '../components/icons';
import { useI18n } from '../lib/i18n';
import { api, ApiError } from '../lib/api';
import { Creator, PublicCookbook, Recipe } from '../lib/types';
import { color, s } from '../lib/theme';
import { Avatar, Button, Empty, IconButton, PageHeading, Pill, Press } from '../components/ui';
import { RecipeGrid } from '../components/RecipeCard';
import { useShareCookbook } from '../components/CookbookSettings';

/** The server's answer for one cookbook: the cookbook, or the status and message it failed with. */
type Answer = { id: string; cookbook: PublicCookbook | null; status: number; error: string };

/**
 * A cookbook's own page (the web's /cookbooks/<id>): its name, description and cook, and the
 * published recipes in it. Anyone can open a public one; a private one opens only for its owner.
 * It is page content: the screen around it scrolls.
 */
export function CookbookPage({
  id,
  onOpen,
  onClose,
  onCreator,
}: {
  id: string;
  onOpen: (recipe: Recipe) => void;
  onClose: () => void;
  /** Opens the cook's profile; without it the cook is shown but isn't a link. */
  onCreator?: (creator: Creator) => void;
}) {
  const { t: tr } = useI18n();
  const share = useShareCookbook();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    api<PublicCookbook>(`/cookbooks/${encodeURIComponent(id)}`)
      .then((cookbook) => {
        if (live) setAnswer({ id, cookbook, status: 200, error: '' });
      })
      .catch((e: Error) => {
        const status = e instanceof ApiError ? e.status : 0;
        if (live) setAnswer({ id, cookbook: null, status, error: e.message });
      });
    return () => {
      live = false;
    };
  }, [id, attempt]);
  const current = answer?.id === id ? answer : null;
  const cookbook = current?.cookbook ?? null;
  // The browser tab names the cookbook while it's open.
  const title = cookbook?.name;
  useEffect(() => {
    if (Platform.OS !== 'web' || !title) return;
    const before = document.title;
    const named = `${title} · Savorly`;
    document.title = named;
    return () => {
      if (document.title === named) document.title = before;
    };
  }, [title]);
  const recipes = cookbook?.recipes ?? [];
  const owner = cookbook?.owner;
  const cook = owner && (
    <>
      <Avatar name={owner.name} uri={owner.avatar} size={44} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={s.h3}>
          {tr('by {{v0}}', { v0: owner.name })}
        </Text>
        {!!owner.handle && (
          <Text numberOfLines={1} style={s.small}>
            @{owner.handle}
          </Text>
        )}
      </View>
    </>
  );
  return (
    <View style={{ gap: 22 }}>
      <View style={[s.between, { gap: 12 }]}>
        <IconButton icon={ArrowLeft} label={tr('Back')} onPress={onClose} />
        {cookbook?.public && (
          <Button
            small
            variant="secondary"
            icon={Share2}
            title={tr('Share')}
            label={tr('Share cookbook')}
            onPress={() => void share(cookbook)}
          />
        )}
      </View>
      {!current ? (
        <View style={{ paddingVertical: 80, alignItems: 'center' }}>
          <ActivityIndicator color={color.ink} accessibilityLabel={tr('Loading…')} />
        </View>
      ) : cookbook ? (
        <>
          <PageHeading
            eyebrow={`${tr('Cookbook')} · ${tr('recipeCount', { count: recipes.length, more: '' })}`}
            title={cookbook.name}
            subtitle={cookbook.description || undefined}
          />
          <View style={[s.row, { gap: 12, flexWrap: 'wrap' }]}>
            {owner &&
              (onCreator ? (
                <Press
                  accessibilityRole="button"
                  accessibilityLabel={tr('Visit {{v0}}’s kitchen', { v0: owner.name })}
                  onPress={() => onCreator(owner)}
                  scale={0.98}
                  style={[s.card, s.row, { gap: 12, padding: 12, flexGrow: 1, maxWidth: 420 }]}
                >
                  {cook}
                  <ChevronRight size={18} color={color.soft} />
                </Press>
              ) : (
                <View style={[s.row, { gap: 12, flexGrow: 1, maxWidth: 420 }]}>{cook}</View>
              ))}
            {!cookbook.public && <Pill title={tr('Private')} icon={Lock} />}
          </View>
          {recipes.length ? (
            <RecipeGrid recipes={recipes} onOpen={onOpen} />
          ) : (
            <Empty
              title={tr('No recipes here yet')}
              text={tr('Published recipes saved to this cookbook will show up here.')}
              icon={BookOpen}
            />
          )}
        </>
      ) : current.status === 404 ? (
        <Empty
          title={tr('This cookbook isn’t available')}
          text={tr('It may be private now, or the link may be incomplete.')}
          icon={BookOpen}
          action={onClose}
          actionTitle={tr('Find recipes')}
        />
      ) : (
        <Empty
          title={tr('We couldn’t open this cookbook')}
          text={tr(current.error)}
          icon={BookOpen}
          action={() => {
            setAnswer(null);
            setAttempt((n) => n + 1);
          }}
          actionTitle={tr('Try again')}
        />
      )}
    </View>
  );
}

export default CookbookPage;
