import { LanguageSettings } from '../components/LanguageSettings';
import { UpdateSettings } from '../components/AppUpdates';
import { useI18n } from '../lib/i18n';
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Bookmark,
  CalendarDays,
  Check,
  ChevronRight,
  Leaf,
  LogOut,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react-native';
import { useApp } from '../lib/store';
import { BrandMark, brandColors } from '../components/Brand';
import { api, persistSession } from '../lib/api';
import { Creator, Recipe, RecipeInput, Screen } from '../lib/types';
import { color, font, radius, s } from '../lib/theme';
import {
  Avatar,
  Button,
  Chip,
  Dialog,
  Empty,
  Field,
  PageHeading,
  Pill,
  Press,
  SectionTitle,
  useChrome,
} from '../components/ui';
import { RecipeGrid, RecipeRow } from '../components/RecipeCard';
import { SousChefHistory } from '../components/SousChef';
import { PlanSettings } from '../components/PlanSettings';
import { SocialButtons } from '../components/SocialButtons';
import { HandleField, useHandle } from '../components/Username';
import { PhotoButton, ProfilePhoto } from '../components/ProfilePhoto';
import { dietOptions, useSaveProfile } from '../lib/profile';
import { DangerButton } from './Kitchen';
import { foodIcon } from '../lib/icons';
import { AdminPending } from './admin';
function MenuRow({
  icon: Icon,
  title,
  text,
  onPress,
  danger,
}: {
  icon: typeof Plus;
  title: string;
  text?: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      scale={0.98}
      style={[s.card, s.row, { gap: 14, padding: 14 }]}
    >
      <View
        style={{
          width: 42,
          height: 42,
          borderRadius: 21,
          backgroundColor: danger ? color.errorBg : color.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon size={18} color={danger ? color.error : color.ink} strokeWidth={1.9} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[s.h3, { fontSize: 15, color: danger ? color.error : color.ink }]}>
          {title}
        </Text>
        {text && <Text style={[s.small, { fontFamily: font.medium }]}>{text}</Text>}
      </View>
      {!danger && <ChevronRight size={18} color={color.soft} />}
    </Press>
  );
}
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
                  <Text style={s.small}>@{c.handle}</Text>
                </View>
                {following && <Pill title={tr('Following')} icon={Check} tone="dark" />}
              </View>
              <Text numberOfLines={3} style={s.muted}>
                {c.bio}
              </Text>
              <Text style={[s.small, { color: color.ink }]}>
                {tr('{{v0}} recipes · {{v1}} followers', {
                  v0: c.recipeCount ?? 0,
                  v1: c.followerCount ?? 0,
                })}
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
}: {
  creator: Creator;
  onClose: () => void;
  onOpen: (r: Recipe) => void;
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
      <View style={{ gap: 12, alignItems: 'center', paddingTop: 12 }}>
        <Avatar uri={creator.avatar} name={creator.name} size={88} />
        <View style={{ alignItems: 'center', gap: 2 }}>
          <Text style={[s.h1, { fontSize: 26, textAlign: 'center' }]}>{creator.name}</Text>
          <Text style={s.small}>@{creator.handle}</Text>
        </View>
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
export function Profile({
  onOpen,
  navigate,
  onRecipe,
}: {
  onOpen: (r: Recipe) => void;
  navigate: (s: Screen) => void;
  onRecipe: (r: RecipeInput) => void;
}) {
  const { t: tr } = useI18n();
  const app = useApp();
  const { desktop } = useChrome();
  const [name, setName] = useState(app.user?.name || '');
  const [bio, setBio] = useState(app.user?.bio || '');
  const [avatar, setAvatar] = useState(app.user?.avatar || '');
  const [diets, setDiets] = useState<string[]>(app.user?.preferences.diets || []);
  const [allergies, setAllergies] = useState(app.user?.preferences.allergies?.join(', ') || '');
  const handle = useHandle(app.user?.handle || '');
  const [edit, setEdit] = useState(false);
  const [remove, setRemove] = useState(false);
  const [history, setHistory] = useState(false);
  // The photo sheet either saves the profile photo at once, or fills in the Edit profile form.
  const [photo, setPhoto] = useState<'profile' | 'form' | null>(null);
  const saveProfile = useSaveProfile();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setName(app.user?.name || '');
    setBio(app.user?.bio || '');
    setAvatar(app.user?.avatar || '');
    setDiets(app.user?.preferences.diets || []);
    setAllergies(app.user?.preferences.allergies?.join(', ') || '');
  }, [app.user]);
  const mine = app.library.recipes.filter((r) => r.author.id === app.user?.id);
  // An app can update before the API does, so missing account fields mean "none".
  const identities = app.user?.identities ?? [];
  // Deleting also cancels any subscription; a kitchen without a password confirms by signing in.
  const deleteAccount = (body: object) => {
    setBusy(true);
    return app
      .act(async () => {
        await api('/me', { method: 'DELETE', body });
        await persistSession(null);
        setRemove(false);
        setPassword('');
        await app.load();
        navigate('discover');
      }, 'Your account has been deleted.')
      .finally(() => setBusy(false));
  };
  const menu = [
    ...(app.user?.admin
      ? [
          {
            icon: ShieldCheck,
            title: tr('Admin console'),
            inSidebar: true,
            text: 'Moderation, members, AI spend and settings',
            go: () => navigate('admin'),
          },
        ]
      : []),
    {
      icon: CalendarDays,
      title: tr('Meal planner'),
      inSidebar: true,
      text: 'Plan the week and shop for it',
      go: () => navigate('planner'),
    },
    {
      icon: Leaf,
      title: tr('Pantry'),
      inSidebar: true,
      text: 'What you have, and what to cook with it',
      go: () => navigate('pantry'),
    },
    {
      icon: Bookmark,
      title: tr('Saved recipes'),
      inSidebar: true,
      text: 'Favorites and cookbooks',
      go: () => navigate('saved'),
    },
    {
      icon: Sparkles,
      title: tr('Sous-chef history'),
      text: 'Recipes, swaps and answers you asked for',
      go: () => app.requireUser(() => setHistory(true)),
    },
    {
      icon: Users,
      title: tr('Community'),
      inSidebar: true,
      text: 'Cooks to follow',
      go: () => navigate('community'),
    },
  ];
  const identity = !app.user ? (
    <View style={[s.card, { alignItems: 'center', gap: 10, paddingVertical: 32 }]}>
      <View
        style={{
          width: 72,
          height: 72,
          borderRadius: 24,
          backgroundColor: brandColors.sage,
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
      {!!app.user.bio && (
        <Text style={[s.muted, { textAlign: 'center', maxWidth: 440 }]}>{app.user.bio}</Text>
      )}
      <View style={[s.row, { alignSelf: 'stretch', marginTop: 4 }]}>
        {[
          { n: mine.filter((r) => r.published).length, label: tr('Shared') },
          { n: app.library.savedIds.length, label: tr('Saved') },
          { n: app.library.followingIds.length, label: tr('Following') },
        ].map((x, i) => (
          <View
            key={tr(x.label)}
            style={[
              { flex: 1, alignItems: 'center', gap: 2 },
              i > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderColor: color.line },
            ]}
          >
            <Text style={[s.h1, { fontSize: 24 }]}>{x.n}</Text>
            <Text style={s.small}>{tr(x.label)}</Text>
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
        icon={Settings2}
        variant="secondary"
        small
        onPress={() => setEdit(true)}
      />
    </View>
  );
  const account = (
    <>
      <AdminPending />
      {app.user && app.capabilities?.plans && <PlanSettings />}
      {app.user && (
        <View style={[s.card, { gap: 12 }]}>
          <Text style={s.h3}>{tr('Sign-in methods')}</Text>
          <View style={[s.wrap, { gap: 6 }]}>
            {app.user.hasPassword && <Pill title={tr('Email and password')} icon={Check} />}
            {identities.map((p) => (
              <Pill key={p} title={p === 'apple' ? 'Apple' : 'Google'} icon={Check} />
            ))}
          </View>
          <SocialButtons
            only={(['apple', 'google'] as const).filter((p) => !identities.includes(p))}
            onError={app.notify}
            onToken={(t) =>
              void app.act(async () => {
                await api('/auth/oauth', { method: 'POST', body: t });
                await app.refreshUser();
              }, 'Connected. You can sign in with it from now on.')
            }
          />
        </View>
      )}
    </>
  );
  // A desktop's sidebar already leads to the planner, pantry, cookbooks and community.
  const settings = (
    <View style={{ gap: 8 }}>
      <LanguageSettings />
      <UpdateSettings />
      {menu
        .filter((m) => !desktop || !m.inSidebar)
        .map((m) => (
          <MenuRow
            key={m.title}
            icon={m.icon}
            title={tr(m.title)}
            text={tr(m.text)}
            onPress={m.go}
          />
        ))}
    </View>
  );
  const recipes = app.user && (
    <View>
      <SectionTitle
        title={tr('Your recipes')}
        subtitle={tr('Published recipes and private drafts.')}
        action={() => navigate('create')}
        actionTitle={tr('New recipe')}
      />
      {mine.length ? (
        <RecipeGrid recipes={mine} onOpen={onOpen} />
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
  const leave = app.user && (
    <View style={{ gap: 8 }}>
      <MenuRow icon={LogOut} title={tr('Sign out')} onPress={() => void app.act(app.signOut)} />
      <MenuRow
        icon={Trash2}
        title={tr('Delete my account')}
        danger
        onPress={() => setRemove(true)}
      />
    </View>
  );
  return (
    <View style={{ gap: 22 }}>
      <PageHeading title={tr('My kitchen')} />
      {desktop && app.user ? (
        // Who you are and your account down the side; your recipes get the room.
        <View style={{ flexDirection: 'row', gap: 32, alignItems: 'flex-start' }}>
          <View style={{ width: 360, gap: 16 }}>
            {identity}
            {account}
            {settings}
            {leave}
          </View>
          <View style={{ flex: 1 }}>{recipes}</View>
        </View>
      ) : (
        <View style={{ gap: 22, width: '100%', maxWidth: desktop ? 560 : undefined }}>
          {identity}
          {account}
          {settings}
          {recipes}
          {leave}
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
        <Text style={s.label}>{tr('Food preferences')}</Text>
        <View style={[s.wrap, { gap: 8 }]}>
          {dietOptions.map((d) => (
            <Chip
              key={d}
              title={tr(d)}
              icon={foodIcon(d)}
              active={diets.includes(d)}
              onPress={() =>
                setDiets(diets.includes(d) ? diets.filter((v) => v !== d) : [...diets, d])
              }
            />
          ))}
        </View>
        <Field
          label={tr('Allergies (comma separated)')}
          value={allergies}
          onChangeText={setAllergies}
          placeholder={tr('Peanuts, shellfish…')}
        />
        <Text style={s.small}>
          {tr(
            'The sous-chef uses these to personalize suggestions. Always check labels and cross-contact risks yourself.',
          )}
        </Text>
        <Button
          title={tr('Save profile')}
          icon={Check}
          busy={busy}
          disabled={!handle.ready}
          onPress={() => {
            setBusy(true);
            void app
              .act(async () => {
                await api('/me', {
                  method: 'PATCH',
                  body: {
                    name,
                    bio,
                    avatar,
                    handle: handle.value,
                    preferences: {
                      diets,
                      allergies: allergies
                        .split(',')
                        .map((v) => v.trim())
                        .filter(Boolean),
                    },
                  },
                });
                await app.refreshUser();
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
      <Dialog visible={remove} onClose={() => setRemove(false)} title={tr('Delete your account?')}>
        <View style={{ backgroundColor: color.errorBg, borderRadius: radius.md, padding: 16 }}>
          <Text style={[s.body, { color: color.error }]}>
            {tr(
              'This permanently deletes your account, recipes, reviews and kitchen lists. It can’t be undone.',
            )}
          </Text>
        </View>
        {app.user?.hasPassword !== false ? (
          <>
            <Field
              label={tr('Your password')}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
            />
            <DangerButton
              title={tr('Permanently delete my account')}
              busy={busy}
              disabled={!password}
              onPress={() => void deleteAccount({ password })}
            />
          </>
        ) : (
          <>
            <Text style={s.muted}>
              {tr('To confirm it’s you, sign in once more with the account you use for Savorly.')}
            </Text>
            <SocialButtons
              only={identities}
              onError={app.notify}
              onToken={(t) => void deleteAccount({ provider: t.provider, token: t.token })}
            />
          </>
        )}
      </Dialog>
    </View>
  );
}
