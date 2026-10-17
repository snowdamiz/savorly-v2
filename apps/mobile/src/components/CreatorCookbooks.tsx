import React, { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { ChevronRight } from './icons';
import { useI18n } from '../lib/i18n';
import { api } from '../lib/api';
import { CookbookSummary } from '../lib/types';
import { color, font, radius, s, shadow } from '../lib/theme';
import { FoodImage, Press } from './ui';

function CookbookRow({ cookbook, onPress }: { cookbook: CookbookSummary; onPress: () => void }) {
  const { t: tr } = useI18n();
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={tr('Open the cookbook {{v0}}', { v0: cookbook.name })}
      onPress={onPress}
      scale={0.98}
      style={[
        s.row,
        {
          backgroundColor: color.white,
          borderRadius: radius.lg,
          padding: 10,
          paddingRight: 14,
          gap: 14,
          boxShadow: shadow.card,
        },
      ]}
    >
      <FoodImage uri={cookbook.cover || ''} style={{ width: 76, height: 76, borderRadius: 20 }} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text numberOfLines={1} style={s.h3}>
          {cookbook.name}
        </Text>
        {!!cookbook.description && (
          <Text numberOfLines={2} style={[s.small, { fontFamily: font.medium }]}>
            {cookbook.description}
          </Text>
        )}
        <Text style={s.small}>
          {tr('recipeCount', { count: cookbook.recipeCount ?? 0, more: '' })}
        </Text>
      </View>
      <ChevronRight size={18} color={color.soft} />
    </Press>
  );
}

/** A cook's public cookbooks on their profile; nothing at all when they have none to show. */
export function CreatorCookbooks({
  creatorId,
  onOpen,
}: {
  creatorId: string;
  onOpen: (id: string) => void;
}) {
  const { t: tr } = useI18n();
  const [list, setList] = useState<{ creatorId: string; cookbooks: CookbookSummary[] } | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    api<CookbookSummary[]>(`/creators/${encodeURIComponent(creatorId)}/cookbooks`)
      .then((cookbooks) => {
        if (live) setList({ creatorId, cookbooks: Array.isArray(cookbooks) ? cookbooks : [] });
      })
      // An older server has no public cookbooks to list.
      .catch(() => {
        if (live) setList({ creatorId, cookbooks: [] });
      });
    return () => {
      live = false;
    };
  }, [creatorId]);
  const cookbooks = list?.creatorId === creatorId ? list.cookbooks : [];
  if (!cookbooks.length) return null;
  // Laid out like the recipes under it: a heading, then the rows.
  return (
    <>
      <Text style={[s.h2, { marginTop: 8 }]}>{tr('Cookbooks')}</Text>
      <View style={{ gap: 10 }}>
        {cookbooks.map((c) => (
          <CookbookRow key={c.id} cookbook={c} onPress={() => onOpen(c.id)} />
        ))}
      </View>
    </>
  );
}
