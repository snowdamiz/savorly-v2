import { useI18n } from '../lib/i18n';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { Check, ImagePlus, Video } from './icons';
import { Recipe, StudioProject } from '../lib/types';
import { color, radius, s } from '../lib/theme';
import { Button, Dialog, FoodImage, Pill } from './ui';
import { VideoPlayer } from './VideoPlayer';

/**
 * The recipe a conversation saved: enough of it to see it's the right one, how its photo and
 * video are coming along, and ways to open it, watch its video, or retry media that failed.
 */
export function StudioDraft({
  recipe,
  assets,
  busy,
  onOpen,
  onRetry,
}: {
  recipe: Recipe;
  assets: StudioProject['assets'];
  /** A reply is on its way, so media can't be retried yet. */
  busy: boolean;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const { t: tr } = useI18n();
  // The draft's video, open large.
  const [videoOpen, setVideoOpen] = useState(false);
  return (
    <View style={[s.card, { gap: 14 }]}>
      <View style={[s.row, { gap: 14 }]}>
        {!!recipe.image && (
          <FoodImage
            uri={recipe.image}
            style={{ width: 76, height: 88, borderRadius: radius.md }}
          />
        )}
        <View style={{ flex: 1, gap: 6 }}>
          <Pill
            title={recipe.published ? tr('Published') : tr('Private draft saved')}
            icon={Check}
          />
          <Text style={s.h2}>{recipe.title}</Text>
          <Text style={s.small}>
            {[
              tr('minuteCount', { count: recipe.minutes }),
              tr('servingCount', { count: recipe.servings }),
              tr('ingredientCount', { count: recipe.ingredients.length }),
            ].join(' · ')}
          </Text>
        </View>
      </View>
      {/* Enough of the recipe to see it's the right one, without opening it. */}
      <Text numberOfLines={2} style={[s.small, { color: color.ink }]}>
        {recipe.ingredients.map((i) => i.name).join(' · ')}
      </Text>
      {assets.map((asset) => (
        <View key={asset.kind} style={{ gap: 4 }}>
          <View style={[s.row, { gap: 8 }]}>
            {asset.kind === 'image' ? (
              <ImagePlus size={17} color={color.ink} />
            ) : (
              <Video size={17} color={color.ink} />
            )}
            <Text style={[s.body, { flex: 1 }]}>
              {asset.kind === 'image' ? tr('AI cover photo') : tr('AI recipe video')}
            </Text>
            <Text style={s.small}>
              {asset.status === 'completed'
                ? tr('Ready')
                : asset.status === 'failed'
                  ? tr('Needs attention')
                  : tr('Creating…')}
            </Text>
          </View>
          {asset.status === 'failed' && <Text style={s.muted}>{tr(asset.error)}</Text>}
        </View>
      ))}
      <View style={[s.row, { gap: 8, flexWrap: 'wrap' }]}>
        <Button title={tr('Open recipe')} small onPress={onOpen} />
        {!!recipe.video && (
          <Button
            title={tr('Watch video')}
            icon={Video}
            small
            variant="secondary"
            onPress={() => setVideoOpen(true)}
          />
        )}
        {assets.some((a) => a.status === 'failed') && (
          <Button
            title={tr('Retry media')}
            small
            variant="secondary"
            disabled={busy}
            onPress={onRetry}
          />
        )}
      </View>
      <Text style={s.small}>{tr('Media keeps creating when you close this conversation.')}</Text>
      <Dialog visible={videoOpen} onClose={() => setVideoOpen(false)} title={recipe.title}>
        {videoOpen && !!recipe.video ? <VideoPlayer uri={recipe.video} /> : null}
      </Dialog>
    </View>
  );
}
