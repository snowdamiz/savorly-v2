import { languages, useI18n } from '../lib/i18n';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, BackHandler, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { ArrowRight, CalendarDays, Check, ChevronLeft, Sparkles, Users } from './icons';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { RevealFocus, useKeyboardLift, useKeyboardScroll } from '../lib/keyboard';
import { dietOptions, useSaveProfile } from '../lib/profile';
import { foodIcon } from '../lib/icons';
import { haptic } from '../lib/haptics';
import { color, font, radius, s, shadow } from '../lib/theme';
import { Creator } from '../lib/types';
import { BrandMark } from './Brand';
import { PhotoButton, ProfilePhoto } from './ProfilePhoto';
import { HandleField, useHandle } from './Username';
import { Avatar, Button, Chip, FadeIn, Field, IconButton, Press, useChrome } from './ui';
import { FollowPill } from './FollowPill';
import { track } from '../lib/telemetry';

// The steps' names in the onboarding_step event.
const welcomeSteps = ['language', 'account'];
const setupSteps = ['profile', 'preferences', 'cooks', 'sous_chef'];

// One full-screen page of a flow: a header with progress, scrolling content, and actions pinned to
// the bottom that rise with the keyboard.
function Page({
  step,
  steps,
  onBack,
  onSkip,
  footer,
  children,
}: {
  step: number;
  steps: number;
  onBack?: () => void;
  onSkip?: () => void;
  footer: React.ReactNode;
  children: React.ReactNode;
}) {
  const { t: tr } = useI18n();
  const { insets, gutter, desktop } = useChrome();
  const lift = useKeyboardLift();
  const scroller = useRef<ScrollView>(null);
  const keyboard = useKeyboardScroll(scroller, lift);
  const column = { width: '100%', maxWidth: 520, alignSelf: 'center' } as const;
  // Android's back button steps back through the flow rather than leaving the app.
  const back = useRef(onBack);
  useEffect(() => {
    back.current = onBack;
  });
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      back.current?.();
      return !!back.current;
    });
    return () => sub.remove();
  }, []);
  return (
    <View
      aria-modal
      accessibilityViewIsModal
      style={[
        StyleSheet.absoluteFill,
        { zIndex: 500, backgroundColor: color.bg, paddingBottom: lift },
      ]}
    >
      <StatusBar barStyle="dark-content" />
      <View
        style={[
          s.row,
          column,
          { gap: 12, paddingTop: insets.top + (desktop ? 28 : 8), paddingHorizontal: gutter },
        ]}
      >
        <View style={{ width: 44 }}>
          {onBack && <IconButton icon={ChevronLeft} label={tr('Back')} onPress={onBack} />}
        </View>
        <View
          accessibilityRole="progressbar"
          accessibilityValue={{ min: 1, max: steps, now: step + 1 }}
          style={[s.row, { flex: 1, gap: 6 }]}
        >
          {Array.from({ length: steps }, (_, i) => (
            <View
              key={i}
              style={{
                flex: 1,
                height: 4,
                borderRadius: 2,
                backgroundColor: i <= step ? color.ink : color.line,
              }}
            />
          ))}
        </View>
        <View style={{ width: 44, alignItems: 'flex-end' }}>
          {onSkip && (
            <Press
              accessibilityRole="button"
              accessibilityLabel={tr('Skip')}
              onPress={onSkip}
              hitSlop={12}
              style={{ height: 44, justifyContent: 'center' }}
            >
              <Text style={{ fontFamily: font.bold, fontSize: 14, color: color.muted }}>
                {tr('Skip')}
              </Text>
            </Press>
          )}
        </View>
      </View>
      <Animated.ScrollView
        ref={scroller}
        onLayout={keyboard.onLayout}
        onScroll={keyboard.onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[column, { padding: gutter, paddingTop: 28, gap: 22 }]}
      >
        <RevealFocus.Provider value={keyboard.reveal}>
          <FadeIn key={step} offset={14} style={{ gap: 22 }}>
            {children}
          </FadeIn>
        </RevealFocus.Provider>
      </Animated.ScrollView>
      <View
        style={[
          column,
          {
            gap: 6,
            paddingHorizontal: gutter,
            paddingTop: 12,
            // The keyboard's lift already leaves out the safe area, so it stays either way.
            paddingBottom: insets.bottom + 16,
          },
        ]}
      >
        {footer}
      </View>
    </View>
  );
}
function Heading({ title, text }: { title: string; text: string }) {
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={[s.display, { fontSize: 30, lineHeight: 36 }]}>
        {title}
      </Text>
      <Text style={[s.muted, { fontSize: 15, lineHeight: 22 }]}>{text}</Text>
    </View>
  );
}

/**
 * The first thing a new phone sees: choose a language, then join, sign in or just look around.
 * It goes once someone is signed in or chooses to look around.
 */
export function Welcome({ onDone }: { onDone: () => void }) {
  const { t: tr, language, detected, setLanguage } = useI18n();
  const app = useApp();
  const [step, setStep] = useState(0);
  // Where newcomers stop (admin insights): each page shown, and looking around without an account.
  useEffect(() => {
    track('onboarding_step', { step: welcomeSteps[step] });
  }, [step]);
  if (step === 0)
    return (
      <Page
        step={0}
        steps={2}
        footer={
          <Button
            title={tr('Continue')}
            icon={ArrowRight}
            large
            onPress={() => {
              haptic.tap();
              setStep(1);
            }}
          />
        }
      >
        <View style={styles.mark}>
          <BrandMark size={70} />
        </View>
        <Heading
          title={tr('Welcome to Savorly')}
          text={tr('Good recipes, everyday inspiration, and a sous-chef when you want one.')}
        />
        <View style={{ gap: 12 }}>
          <Text style={s.label}>{tr('Choose your language')}</Text>
          <View accessibilityRole="radiogroup" style={[s.card, { padding: 6, gap: 2 }]}>
            {languages.map((option) => {
              const on = option.code === language;
              return (
                <Press
                  key={option.code}
                  accessibilityRole="radio"
                  aria-checked={on}
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={option.name}
                  scale={0.98}
                  onPress={() => {
                    if (!on) haptic.select();
                    // Choosing the device's own language keeps following the device.
                    setLanguage(option.code === detected ? 'system' : option.code);
                  }}
                  style={[
                    s.row,
                    {
                      gap: 12,
                      minHeight: 50,
                      paddingHorizontal: 14,
                      borderRadius: radius.md,
                      backgroundColor: on ? color.subtle : 'transparent',
                    },
                  ]}
                >
                  <Text style={[s.body, { flex: 1, fontFamily: on ? font.bold : font.medium }]}>
                    {option.name}
                  </Text>
                  {on && <Check size={19} color={color.ink} strokeWidth={2.4} />}
                </Press>
              );
            })}
          </View>
        </View>
      </Page>
    );
  return (
    <Page
      step={1}
      steps={2}
      onBack={() => setStep(0)}
      footer={
        <>
          <Button
            title={tr('Create an account')}
            large
            onPress={() => app.setAuthOpen(true, 'register')}
          />
          <Button
            title={tr('I already have an account')}
            variant="secondary"
            large
            onPress={() => app.setAuthOpen(true)}
          />
          <Button
            title={tr('Look around first')}
            variant="ghost"
            onPress={() => {
              track('onboarding_done', { skipped: true });
              onDone();
            }}
          />
        </>
      }
    >
      <Heading
        title={tr('Make yourself at home')}
        text={tr('A free account keeps your kitchen with you on every device.')}
      />
      <View style={{ gap: 12 }}>
        {[
          {
            icon: Sparkles,
            title: tr('A sous-chef by your side'),
            text: tr('Ideas from what’s in your fridge, swaps and help at every step.'),
          },
          {
            icon: CalendarDays,
            title: tr('Your week, planned'),
            text: tr('Meals, groceries and your pantry, all in one place.'),
          },
          {
            icon: Users,
            title: tr('Cooks worth following'),
            text: tr('Save the recipes you love and share the dishes you make.'),
          },
        ].map(({ icon: Icon, title, text }) => (
          <View key={title} style={[s.card, s.row, { gap: 16, padding: 16 }]}>
            <View style={styles.feature}>
              <Icon size={20} color={color.white} strokeWidth={2} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.h3}>{title}</Text>
              <Text style={s.muted}>{text}</Text>
            </View>
          </View>
        ))}
      </View>
    </Page>
  );
}

/**
 * A new kitchen's setup: photo, name and username; food preferences; cooks to follow; then meeting
 * the sous-chef. Each step is saved as it is left, and finishing or skipping the last one marks the
 * kitchen as set up.
 */
export function KitchenSetup() {
  const { t: tr } = useI18n();
  const app = useApp();
  const user = app.user!;
  const saveProfile = useSaveProfile();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(user.name);
  const [avatar, setAvatar] = useState(user.avatar);
  const [photo, setPhoto] = useState(false);
  const handle = useHandle(user.handle);
  const [diets, setDiets] = useState<string[]>(user.preferences.diets || []);
  const [allergies, setAllergies] = useState((user.preferences.allergies || []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Cooks with the most to cook from first; following a few fills the home feed.
  const [cooks] = useState<Creator[]>(() =>
    app.creators
      .filter((c) => c.id !== user.id)
      .sort((a, b) => (b.recipeCount ?? 0) - (a.recipeCount ?? 0))
      .slice(0, 8),
  );
  const last = step === 3;
  // Each step reached, and whether any was skipped on the way to the end.
  const skipped = useRef(false);
  useEffect(() => {
    track('onboarding_step', { step: setupSteps[step] });
  }, [step]);
  const go = (next: number) => {
    setError('');
    setStep(next);
  };
  const finish = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/me/onboarded', { method: 'POST' });
      track('onboarding_done', { skipped: skipped.current });
      await app.refreshUser();
      haptic.tap();
      app.notify(tr('Welcome to the table, @{{v0}}.', { v0: app.user?.handle || user.handle }));
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  // Saves this step's answers, then moves on.
  const next = async () => {
    const preferences = {
      diets,
      allergies: allergies
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    };
    const changes =
      step === 0
        ? { name: name.trim(), avatar, handle: handle.value }
        : step === 1
          ? { preferences }
          : null;
    if (!changes) return last ? finish() : go(step + 1);
    setBusy(true);
    setError('');
    try {
      await saveProfile(changes);
      go(step + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const nameValid = name.trim().length >= 2;
  const footer = (
    <>
      {!!error && (
        <Text accessibilityRole="alert" style={[s.body, { color: color.error, marginBottom: 6 }]}>
          {tr(error)}
        </Text>
      )}
      <Button
        title={last ? tr('Let’s get started') : tr('Continue')}
        icon={ArrowRight}
        large
        busy={busy}
        disabled={step === 0 && (!nameValid || !handle.ready)}
        onPress={() => void next()}
      />
    </>
  );
  return (
    <Page
      step={step}
      steps={4}
      onBack={step > 0 && !busy ? () => go(step - 1) : undefined}
      onSkip={
        busy
          ? undefined
          : () => {
              skipped.current = true;
              if (last) void finish();
              else go(step + 1);
            }
      }
      footer={footer}
    >
      {step === 0 && (
        <>
          <Heading
            title={tr('Set up your kitchen')}
            text={tr('A photo and a name help other cooks know whose kitchen this is.')}
          />
          <View style={{ alignItems: 'center', gap: 12 }}>
            <PhotoButton name={name} uri={avatar} size={112} onPress={() => setPhoto(true)} />
            <Button
              title={avatar ? tr('Change photo') : tr('Add a photo')}
              variant="ghost"
              onPress={() => setPhoto(true)}
            />
          </View>
          <Field
            label={tr('Your name')}
            value={name}
            onChangeText={setName}
            maxLength={70}
            autoComplete="name"
            placeholder={tr('What should we call you?')}
          />
          <HandleField handle={handle} />
          <ProfilePhoto
            visible={photo}
            onClose={() => setPhoto(false)}
            name={name}
            value={avatar}
            onSave={setAvatar}
          />
        </>
      )}
      {step === 1 && (
        <>
          <Heading
            title={tr('How do you like to eat?')}
            text={tr('Your sous-chef keeps this in mind. You can change it anytime in Settings.')}
          />
          <View style={[s.wrap, { gap: 8 }]}>
            {dietOptions.map((d) => (
              <Chip
                key={d}
                title={tr(d)}
                icon={foodIcon(d)}
                active={diets.includes(d)}
                onPress={() => {
                  haptic.select();
                  setDiets(diets.includes(d) ? diets.filter((v) => v !== d) : [...diets, d]);
                }}
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
        </>
      )}
      {step === 2 && (
        <>
          <Heading
            title={tr('Cooks to follow')}
            text={
              cooks.length
                ? tr('Their newest recipes will show up for you.')
                : tr('Your kitchen is ready. Let’s find something good to cook.')
            }
          />
          <View style={{ gap: 10 }}>
            {cooks.map((c) => (
              <Cook key={c.id} creator={c} />
            ))}
          </View>
        </>
      )}
      {step === 3 && <MeetSousChef />}
    </Page>
  );
}

// A few things to say, from a cooking question to work done for you, so "anything" feels concrete.
const asks = [
  'What can I make with what’s in my fridge?',
  'Make it vegetarian, for six.',
  'Plan my week and add the groceries.',
  'Turn this photo into a recipe.',
];
// The app is built around the sous-chef, so the last step says so: ask for anything, in any way,
// from anywhere, and it helps or simply does it.
function MeetSousChef() {
  const { t: tr } = useI18n();
  return (
    <>
      <Heading
        title={tr('Just ask your sous-chef')}
        text={tr(
          'Savorly is built around AI. Your sous-chef helps with anything you can imagine, and can do everything in the app for you.',
        )}
      />
      <View style={{ gap: 8 }}>
        {asks.map((ask, i) => (
          <FadeIn key={ask} delay={200 + i * 140} offset={10} style={styles.ask}>
            <Text style={[s.body, { color: color.white }]}>{tr(ask)}</Text>
          </FadeIn>
        ))}
      </View>
      <FadeIn delay={200 + asks.length * 140} offset={10}>
        <View style={[s.card, s.row, { gap: 16, padding: 16 }]}>
          <View style={styles.souschef}>
            <Sparkles size={22} color={color.white} strokeWidth={2} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.h3}>{tr('One tap away, on every screen')}</Text>
            <Text style={s.muted}>
              {tr(
                'Type, talk or show it a photo. It sees what you’re looking at, and checks with you before anything big.',
              )}
            </Text>
          </View>
        </View>
      </FadeIn>
    </>
  );
}
function Cook({ creator }: { creator: Creator }) {
  const { t: tr } = useI18n();
  return (
    <View style={[s.card, s.row, { gap: 14, padding: 14 }]}>
      <Avatar uri={creator.avatar} name={creator.name} size={52} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={s.h3}>
          {creator.name}
        </Text>
        <Text numberOfLines={1} style={s.small}>
          {tr('recipeCount', { count: creator.recipeCount ?? 0, more: '' })}
        </Text>
      </View>
      <FollowPill creator={creator} />
    </View>
  );
}
const styles = StyleSheet.create({
  mark: {
    width: 96,
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  feature: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Requests look like your own messages in the sous-chef.
  ask: {
    alignSelf: 'flex-end',
    maxWidth: '86%',
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: radius.md,
    borderBottomRightRadius: 6,
    backgroundColor: color.ink,
  },
  // The floating sous-chef button, as it appears on every screen.
  souschef: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: color.ink,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: shadow.float,
  },
});
