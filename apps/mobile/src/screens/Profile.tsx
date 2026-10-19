import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import {
  CalendarDays,
  Check,
  HouseHeart,
  Leaf,
  LucideIcon,
  PencilLine,
  Plus,
  Settings,
  ShieldCheck,
  ShoppingBasket,
  Sparkles,
  Users,
} from '../components/icons';
import { useApp } from '../lib/store';
import { useShelf } from '../lib/shelf';
import { BrandMark } from '../components/Brand';
import { api } from '../lib/api';
import { Creator, Recipe, RecipeInput, Screen } from '../lib/types';
import { color, s } from '../lib/theme';
import {
  Avatar,
  Button,
  Dialog,
  Empty,
  Field,
  IconButton,
  PageHeading,
  Pill,
  Press,
  SectionTitle,
  useChrome,
} from '../components/ui';
import { RecipeGrid, RecipeRow } from '../components/RecipeCard';
import { CreatorCookbooks } from '../components/CreatorCookbooks';
import { SousChefHistory } from '../components/SousChef';
import { CreatorEarnings } from '../components/CreatorEarnings';
import { HandleField, useHandle } from '../components/Username';
import { PhotoButton, ProfilePhoto } from '../components/ProfilePhoto';
import { useSaveProfile } from '../lib/profile';
import { foodIcon } from '../lib/icons';
import { HouseholdSheet, useHousehold } from '../components/HouseholdSheet';
import { FoundingMark } from '../components/FoundingMark';
import { VerifyEmail } from '../components/VerifyEmail';
export function Community({ onCreator }: { onCreator: (c: Creator) => void }) {
  const { t: tr } = useI18n();
  const app = useApp();
  return (
    <View style={{ gap: 22 }}>
      <PageHeading
        title={tr('Community')}
        subtitle={tr('Find cooks who inspire you, and follow their kitchens.')}
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {app.creators.map((c) => {
          const following = app.library.followingIds.includes(c.id);
          return (
            <Press
              key={c.id}
              accessibilityRole="button"
              accessibilityLabel={tr('Visit {{v0}}’s kitchen', { v0: c.name })}
              onPress={() => onCreator(c)}
              scale={0.985}
              style={[
                s.card,
                {
                  flexGrow: 1,
                  flexBasis: 300,
                  gap: 14,
                },
              ]}
            >
              <View style={[s.row, { gap: 14 }]}>
                <Avatar uri={c.avatar} name={c.name} size={56} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.h3}>{c.name}</Text>
                  <Text style={s.small}>
                    {[`@${c.handle}`, c.founding && tr('Founding creator')]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                {following && <Pill title={tr('Following')} icon={Check} tone="dark" />}
              </View>
              <Text numberOfLines={3} style={s.muted}>
                {c.bio}
              </Text>
              <Text style={[s.small, { color: color.ink }]}>
                {[
                  tr('recipeCount', { count: c.recipeCount ?? 0, more: '' }),
                  tr('followerCount', { count: c.followerCount ?? 0 }),
                ].join(' · ')}
              </Text>
            </Press>
          );
        })}
      </View>
    </View>
  );
}
export function CreatorDialog({
  creator,
  onClose,
  onOpen,
  onCookbook,
}: {
  creator: Creator;
  onClose: () => void;
  onOpen: (r: Recipe) => void;
  /** Opens one of the cook's public cookbooks (by id); without it they aren't listed. */
  onCookbook?: (id: string) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<Recipe[]>(`/recipes?author=${encodeURIComponent(creator.id)}`)
      .then(setRecipes)
      .catch((e) => setError(e.message));
  }, [creator.id]);
  const following = app.library.followingIds.includes(creator.id);
  return (
    <Dialog visible onClose={onClose}>
      <View style={{ gap: 12, alignItems: 'center' }}>
        <Avatar uri={creator.avatar} name={creator.name} size={88} />
        <View style={{ alignItems: 'center', gap: 2 }}>
          <Text style={[s.h1, { fontSize: 26, textAlign: 'center' }]}>{creator.name}</Text>
          <Text style={s.small}>@{creator.handle}</Text>
        </View>
        <FoundingMark creator={creator} />
        {!!creator.bio && (
          <Text style={[s.muted, { textAlign: 'center', maxWidth: 440 }]}>{creator.bio}</Text>
        )}
        {app.user?.id !== creator.id && (
          <Button
            title={following ? tr('Following') : tr('Follow')}
            label={following ? tr('Following') : tr('Follow this kitchen')}
            icon={following ? Check : Plus}
            variant={following ? 'secondary' : 'primary'}
            style={{ alignSelf: 'stretch', marginTop: 6 }}
            onPress={() => void app.toggleFollow(creator)}
          />
        )}
      </View>
      {onCookbook && <CreatorCookbooks creatorId={creator.id} onOpen={onCookbook} />}
      <Text style={[s.h2, { marginTop: 8 }]}>{tr('Recipes')}</Text>
      {!!error && <Text style={{ color: color.error }}>{tr(error)}</Text>}
      <View style={{ gap: 10 }}>
        {recipes.map((r) => (
          <RecipeRow key={r.id} recipe={r} onOpen={onOpen} />
        ))}
      </View>
    </Dialog>
  );
}
/** One of the kitchen's places in My kitchen: the planner, the grocery list, the household… */
type Place = {
  key: string;
  icon: LucideIcon;
  title: string;
  text: string;
  /** What a screen reader says, when it should differ from the title. */
  label?: string;
  onPress: () => void;
};
function PlaceTile({ place }: { place: Place }) {
  const { icon: Icon } = place;
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={place.label || place.title}
      onPress={place.onPress}
      scale={0.97}
      style={[s.card, { flexGrow: 1, flexBasis: 150, padding: 14, gap: 12 }]}
    >
      <View style={styles.badge}>
        <Icon size={18} color={color.white} strokeWidth={2} />
      </View>
      <View style={{ gap: 1 }}>
        <Text numberOfLines={1} style={[s.h3, { fontSize: 14, lineHeight: 19 }]}>
          {place.title}
        </Text>
        <Text numberOfLines={1} style={[s.small, { fontSize: 11 }]}>
          {place.text}
        </Text>
      </View>
    </Press>
  );
}
/**
 * The household's tile: its name once there is one, or the invitation to share the kitchen, and
 * the sheet to start, join or manage it. Hidden on a server without households.
 */
function HouseholdTile() {
  const { t: tr } = useI18n();
  const app = useApp();
  const state = useHousehold(app.user?.id ?? null);
  const [open, setOpen] = useState(false);
  if (!state.supported) return null;
  const { household } = state;
  return (
    <>
      <PlaceTile
        place={{
          key: 'household',
          icon: HouseHeart,
          title: tr('Household'),
          text: household ? household.name : tr('Share your kitchen'),
          label: household
            ? tr('Shared kitchen: {{v0}}', { v0: household.name })
            : tr('Share your kitchen'),
          onPress: () => setOpen(true),
        }}
      />
      <HouseholdSheet visible={open} onClose={() => setOpen(false)} state={state} />
    </>
  );
}
export function Profile({
  onOpen,
  navigate,
  onRecipe,
  onGroceries,
}: {
  onOpen: (r: Recipe) => void;
  navigate: (s: Screen) => void;
  onRecipe: (r: RecipeInput) => void;
  /** Opens the meal planner on its grocery list. */
  onGroceries: () => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const { desktop } = useChrome();
  const [name, setName] = useState(app.user?.name || '');
  const [bio, setBio] = useState(app.user?.bio || '');
  const [avatar, setAvatar] = useState(app.user?.avatar || '');
  const handle = useHandle(app.user?.handle || '');
  const [edit, setEdit] = useState(false);
  const [history, setHistory] = useState(false);
  // The photo sheet either saves the profile photo at once, or fills in the Edit profile form.
  const [photo, setPhoto] = useState<'profile' | 'form' | null>(null);
  const saveProfile = useSaveProfile();
  const [busy, setBusy] = useState(false);
  // The cook's own recipes, drafts too, a page at a time; the count of published ones is whole.
  const own = useShelf('mine');
  const mine = own.recipes;
  const shared = app.library.publishedCount ?? mine.filter((r) => r.published).length;
  const saved = app.library.savedIds.length;
  const following = app.library.followingIds.length;
  const toBuy = app.kitchen.groceries.filter((g) => !g.checked).length;
  // A desktop's sidebar already leads to the planner, the pantry, the household and the community.
  const places: (Place & { inSidebar?: boolean })[] = [
    {
      key: 'planner',
      icon: CalendarDays,
      title: tr('Meal planner'),
      text: tr('Your week'),
      inSidebar: true,
      onPress: () => navigate('planner'),
    },
    {
      key: 'groceries',
      icon: ShoppingBasket,
      title: tr('Groceries'),
      text: toBuy ? tr('toBuyCount', { count: toBuy }) : tr('Your shopping list'),
      onPress: onGroceries,
    },
    {
      key: 'pantry',
      icon: Leaf,
      title: tr('Pantry'),
      text: tr('What you have'),
      inSidebar: true,
      onPress: () => navigate('pantry'),
    },
    {
      key: 'history',
      icon: Sparkles,
      title: tr('Sous-chef history'),
      text: tr('What you asked for'),
      onPress: () => setHistory(true),
    },
    {
      key: 'community',
      icon: Users,
      title: tr('Community'),
      text: tr('Cooks to follow'),
      inSidebar: true,
      onPress: () => navigate('community'),
    },
    ...(app.user?.admin
      ? [
          {
            key: 'admin',
            icon: ShieldCheck,
            title: tr('Admin console'),
            // The console is English only (docs/ADMIN.md).
            text: 'Moderation and members',
            inSidebar: true,
            onPress: () => navigate('admin'),
          },
        ]
      : []),
  ].filter((p) => !desktop || !p.inSidebar);
  const kitchen = app.user && (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
      {places.slice(0, 3).map((p) => (
        <PlaceTile key={p.key} place={p} />
      ))}
      {!desktop && <HouseholdTile />}
      {places.slice(3).map((p) => (
        <PlaceTile key={p.key} place={p} />
      ))}
    </View>
  );
  const identity = !app.user ? (
    <View style={[s.card, { alignItems: 'center', gap: 10, paddingVertical: 32 }]}>
      <View
        style={{
          width: 72,
          height: 72,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 6,
        }}
      >
        <BrandMark size={54} />
      </View>
      <Text style={[s.h2, { textAlign: 'center' }]}>{tr('A kitchen to call your own')}</Text>
      <Text style={[s.muted, { textAlign: 'center', maxWidth: 340 }]}>
        {tr('Join to save recipes, plan your week and share dishes of your own.')}
      </Text>
      <Button
        title={tr('Sign in or join')}
        onPress={() => app.setAuthOpen(true)}
        style={{ alignSelf: 'stretch', marginTop: 10 }}
      />
    </View>
  ) : (
    <View style={[s.card, { alignItems: 'center', gap: 14, paddingVertical: 28 }]}>
      <PhotoButton
        name={app.user.name}
        uri={app.user.avatar}
        size={88}
        onPress={() => setPhoto('profile')}
      />
      <View style={{ alignItems: 'center', gap: 2 }}>
        <Text style={[s.h1, { fontSize: 24, textAlign: 'center' }]}>{app.user.name}</Text>
        <Text style={s.small}>@{app.user.handle}</Text>
      </View>
      <FoundingMark creator={app.user} />
      {!!app.user.bio && (
        <Text style={[s.muted, { textAlign: 'center', maxWidth: 440 }]}>{app.user.bio}</Text>
      )}
      <View style={[s.row, { alignSelf: 'stretch', marginTop: 4 }]}>
        {/* Each label agrees with its number, and with what it counts (recipes, or kitchens). */}
        {[
          { key: 'shared', n: shared, label: tr('sharedStat', { count: shared }) },
          { key: 'saved', n: saved, label: tr('savedStat', { count: saved }) },
          { key: 'following', n: following, label: tr('followingStat', { count: following }) },
        ].map((x, i) => (
          <View
            key={x.key}
            style={[
              { flex: 1, alignItems: 'center', gap: 2 },
              i > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderColor: color.line },
            ]}
          >
            <Text style={[s.h1, { fontSize: 24 }]}>{x.n}</Text>
            <Text style={s.small}>{x.label}</Text>
          </View>
        ))}
      </View>
      {!!app.user.preferences.diets?.length && (
        <View style={[s.wrap, { gap: 6, justifyContent: 'center' }]}>
          {app.user.preferences.diets.map((d) => (
            <Pill key={d} title={tr(d)} icon={foodIcon(d)} tone="dark" />
          ))}
        </View>
      )}
      <Button
        title={tr('Edit profile')}
        label={tr('Edit your profile')}
        icon={PencilLine}
        variant="secondary"
        small
        onPress={() => {
          setName(app.user?.name || '');
          setBio(app.user?.bio || '');
          setAvatar(app.user?.avatar || '');
          handle.setValue(app.user?.handle || '');
          setEdit(true);
        }}
      />
    </View>
  );
  const earnings = app.user && app.capabilities?.creatorFund && shared > 0 && <CreatorEarnings />;
  const recipes = app.user && (
    <View>
      <SectionTitle
        title={tr('Your recipes')}
        subtitle={tr('Published recipes and private drafts.')}
        action={() => navigate('create')}
        actionTitle={tr('New recipe')}
      />
      {mine.length ? (
        <>
          <RecipeGrid recipes={mine} onOpen={onOpen} />
          {own.hasMore && (
            <Button
              title={tr('Show more')}
              variant="secondary"
              busy={own.busy}
              onPress={() => void own.showMore()}
              style={{ alignSelf: 'center', minWidth: 220, marginTop: 16 }}
            />
          )}
        </>
      ) : !own.settled ? (
        <View style={{ paddingVertical: 40, alignItems: 'center' }}>
          <ActivityIndicator color={color.ink} accessibilityLabel={tr('Loading…')} />
        </View>
      ) : (
        <Empty
          title={tr('Your first recipe is waiting')}
          text={tr('Start with the dish your friends always ask you to make.')}
          action={() => navigate('create')}
          actionTitle={tr('Share a recipe')}
        />
      )}
    </View>
  );
  return (
    <View style={{ gap: 22 }}>
      {/* Settings have a page of their own; My kitchen is the cook, their kitchen and recipes. */}
      <PageHeading title={tr('My kitchen')}>
        {desktop ? (
          <Button
            title={tr('Settings')}
            icon={Settings}
            variant="secondary"
            small
            onPress={() => navigate('settings')}
          />
        ) : (
          <IconButton icon={Settings} label={tr('Settings')} onPress={() => navigate('settings')} />
        )}
      </PageHeading>
      {desktop && app.user ? (
        // Who you are and your kitchen down the side; your recipes get the room.
        <View style={{ flexDirection: 'row', gap: 32, alignItems: 'flex-start' }}>
          <View style={{ width: 360, gap: 16 }}>
            <VerifyEmail />
            {identity}
            {kitchen}
            {earnings}
          </View>
          <View style={{ flex: 1 }}>{recipes}</View>
        </View>
      ) : (
        <View style={{ gap: 22, width: '100%', maxWidth: desktop ? 560 : undefined }}>
          <VerifyEmail />
          {identity}
          {kitchen}
          {earnings}
          {recipes}
        </View>
      )}
      <SousChefHistory visible={history} onClose={() => setHistory(false)} onRecipe={onRecipe} />
      <Dialog visible={edit} onClose={() => setEdit(false)} title={tr('Edit profile')}>
        <View style={[s.row, { gap: 16 }]}>
          <PhotoButton name={name} uri={avatar} size={68} onPress={() => setPhoto('form')} />
          <View style={{ flex: 1, alignItems: 'flex-start', gap: 6 }}>
            <Text style={s.h3}>{tr('Profile photo')}</Text>
            <Button
              title={avatar ? tr('Change photo') : tr('Add a photo')}
              variant="secondary"
              small
              onPress={() => setPhoto('form')}
            />
          </View>
        </View>
        <Field label={tr('Your name')} value={name} onChangeText={setName} maxLength={70} />
        <HandleField handle={handle} />
        <Field
          label={tr('About you')}
          value={bio}
          onChangeText={setBio}
          multiline
          maxLength={1000}
          placeholder={tr('What do you love to cook?')}
        />
        <Button
          title={tr('Save profile')}
          icon={Check}
          busy={busy}
          disabled={!handle.ready}
          onPress={() => {
            setBusy(true);
            void app
              .act(async () => {
                // Diets and allergies are Settings' (Food preferences); they stay as they are.
                await saveProfile({ name, bio, avatar, handle: handle.value });
                setEdit(false);
              }, 'Your profile is updated.')
              .finally(() => setBusy(false));
          }}
        />
      </Dialog>
      <ProfilePhoto
        visible={!!photo}
        onClose={() => setPhoto(null)}
        name={photo === 'form' ? name : app.user?.name || ''}
        value={photo === 'form' ? avatar : app.user?.avatar || ''}
        onSave={async (url) => {
          if (photo === 'form') return setAvatar(url);
          await saveProfile({ avatar: url });
          app.notify(url ? 'Your photo is updated.' : 'Your photo is removed.');
        }}
      />
    </View>
  );
}
const styles = StyleSheet.create({
  badge: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
