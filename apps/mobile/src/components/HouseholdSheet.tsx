import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Share, StyleSheet, Text, View } from 'react-native';
import {
  Check,
  ChevronRight,
  LogOut,
  Share2,
  UserMinus,
  UserPlus,
  Users,
} from './icons';
import { useI18n } from '../lib/i18n';
import { api, ApiError } from '../lib/api';
import { useApp } from '../lib/store';
import { Household, HouseholdInvite, HouseholdMember } from '../lib/types';
import { color, font, s } from '../lib/theme';
import { Avatar, Button, Dialog, Field, IconButton, Press } from './ui';
import { DangerButton } from './DangerButton';
import { SheetError, useSheetAction } from './SheetAction';

const isHousehold = (h: unknown): h is Household =>
  !!h &&
  typeof h === 'object' &&
  typeof (h as Household).id === 'string' &&
  Array.isArray((h as Household).members);

/** Invite codes are 8 letters and digits; pasted spaces, dashes and lower case don't matter. */
const inviteCode = (text: string) =>
  text
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);

export type HouseholdState = ReturnType<typeof useHousehold>;

/**
 * The signed-in kitchen's household, whose members share one grocery list. `ready` turns true with
 * the first answer; `supported` turns false on a server without households, which hides them.
 */
export function useHousehold(userId: string | null) {
  const [state, setState] = useState({
    user: userId,
    household: null as Household | null,
    ready: false,
    supported: true,
  });
  // Another kitchen (or none) starts over.
  if (state.user !== userId) setState({ ...state, user: userId, household: null, ready: false });
  // Answers are numbered: one asked for before a change made here is out of date.
  const asked = useRef(0);
  const reload = useCallback(() => {
    const n = ++asked.current;
    return api<Household | null>('/household').then(
      (household) => {
        if (n !== asked.current) return;
        const known = isHousehold(household) ? household : null;
        setState((v) => ({ ...v, household: known, ready: true }));
      },
      (e: unknown) => {
        if (n !== asked.current) return;
        // A server without households answers 404; a failed request keeps what was shown.
        const missing = e instanceof ApiError && e.status === 404;
        setState((v) => ({ ...v, ready: true, supported: v.supported && !missing }));
      },
    );
  }, []);
  const set = useCallback((household: Household | null) => {
    asked.current++;
    setState((v) => ({ ...v, household, ready: true }));
  }, []);
  useEffect(() => {
    if (userId) void reload();
  }, [userId, reload]);
  return {
    household: state.household,
    ready: state.ready,
    supported: state.supported,
    reload,
    set,
  };
}

/** A few members' faces, overlapping, for the eye only (the text beside them says who). */
function Faces({ members }: { members: HouseholdMember[] }) {
  return (
    <View
      aria-hidden
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[s.row, { paddingLeft: 10 }]}
    >
      {members.slice(0, 3).map((m) => (
        <View
          key={m.id}
          style={{
            marginLeft: -10,
            borderRadius: 22,
            borderWidth: 2,
            borderColor: color.white,
          }}
        >
          <Avatar name={m.name} uri={m.avatar} size={38} />
        </View>
      ))}
    </View>
  );
}

/** The way into sharing from the grocery list: "Share this list", or the household it's shared in. */
export function HouseholdEntry({
  household,
  onPress,
}: {
  household: Household | null;
  onPress: () => void;
}) {
  const { t: tr } = useI18n();
  const members = household?.members.length ?? 0;
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={
        household ? tr('Shared list: {{v0}}', { v0: household.name }) : tr('Share this list')
      }
      onPress={onPress}
      scale={0.98}
      style={[s.card, s.row, { gap: 14, padding: 14 }]}
    >
      {household && members > 0 ? (
        <Faces members={household.members} />
      ) : (
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            backgroundColor: color.bg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Users size={18} color={color.ink} strokeWidth={1.9} />
        </View>
      )}
      <View style={{ flex: 1, gap: 2 }}>
        <Text numberOfLines={1} style={[s.h3, { fontSize: 15 }]}>
          {household ? household.name : tr('Share this list')}
        </Text>
        <Text style={[s.small, { fontFamily: font.medium }]}>
          {!household
            ? tr('Shop together: everyone in your household sees the same list.')
            : members > 1
              ? tr('sharedListCount', { count: members })
              : tr('Just you so far. Invite someone to share the list.')}
        </Text>
      </View>
      <ChevronRight size={18} color={color.soft} />
    </Press>
  );
}

type Step = 'create' | 'join' | 'invite' | 'leave' | 'remove';

/**
 * Sharing the grocery list: start a household or join one with a code; inside one, see who's in
 * it, invite with a code, leave, or (for its owner) remove someone. The list moves with each change,
 * so every change also refreshes the kitchen.
 */
export function HouseholdSheet({
  visible,
  onClose,
  state,
}: {
  visible: boolean;
  onClose: () => void;
  state: HouseholdState;
}) {
  const { t: tr, locale } = useI18n();
  const app = useApp();
  const { refreshKitchen, notify } = app;
  const me = app.user?.id;
  const { household, reload, set } = state;
  const { busy, error, setError, run } = useSheetAction();
  // Which step the error belongs to, so it shows beside the button that was pressed.
  const [step, setStep] = useState<Step>('create');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState<HouseholdInvite | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<'leave' | HouseholdMember | null>(null);
  // Opening the sheet picks up what others changed: who joined or left, and who owns it.
  useEffect(() => {
    if (visible) void reload();
  }, [visible, reload]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  const close = () => {
    setError('');
    setInvite(null);
    setConfirm(null);
    onClose();
  };
  const attempt = (next: Step, fn: () => Promise<unknown>) => {
    setStep(next);
    return run(fn);
  };
  // The grocery list moves in (or out) with the household.
  const changed = async (next: Household | null) => {
    set(next);
    setInvite(null);
    await refreshKitchen();
  };
  // Already in a household (joined from another device, perhaps): show it.
  const conflict = (e: unknown): never => {
    if (e instanceof ApiError && e.status === 409) void reload();
    throw e;
  };
  const create = () =>
    void attempt('create', async () => {
      const made = await api<Household>('/household', {
        method: 'POST',
        body: { name: name.trim() },
      }).catch(conflict);
      setName('');
      await changed(made);
    });
  const join = () =>
    void attempt('join', async () => {
      const joined = await api<Household>('/household/join', {
        method: 'POST',
        body: { code },
      }).catch(conflict);
      setCode('');
      await changed(joined);
    });
  const newInvite = () =>
    void attempt('invite', async () => {
      setInvite(await api<HouseholdInvite>('/household/invite', { method: 'POST' }));
      setCopied(false);
    });
  // Desktop browsers mostly have no share sheet, so there the code goes to the clipboard.
  const shareCode = (current: HouseholdInvite) =>
    void attempt('invite', async () => {
      if (Platform.OS === 'web' && !navigator.share) {
        await navigator.clipboard.writeText(current.code);
        setCopied(true);
      } else
        await Share.share({
          message: tr(
            'Join my household on Savorly to share our grocery list. The code is {{v0}}.',
            {
              v0: current.code,
            },
          ),
        });
    });
  const leave = async () => {
    if (!me) return;
    const left = await attempt('leave', async () => {
      await api(`/household/members/${encodeURIComponent(me)}`, { method: 'DELETE' });
      await changed(null);
    });
    if (left) {
      close();
      notify('You’ve left the household.');
    }
  };
  const remove = async (member: HouseholdMember) => {
    const removed = await attempt('remove', async () => {
      await api(`/household/members/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
      if (household)
        set({ ...household, members: household.members.filter((m) => m.id !== member.id) });
      await Promise.all([reload(), refreshKitchen()]);
    });
    if (removed) setConfirm(null);
  };
  const owner = household?.role === 'owner';
  const others = household ? household.members.filter((m) => m.id !== me) : [];
  const expires = invite ? new Date(invite.expiresAt) : null;
  const until =
    expires && !Number.isNaN(expires.getTime())
      ? expires.toLocaleDateString(locale, { month: 'long', day: 'numeric' })
      : '';
  const errorFor = (which: Step) => (step === which ? error : '');
  const member = confirm && confirm !== 'leave' ? confirm : null;
  return (
    <>
      <Dialog
        visible={visible}
        onClose={close}
        title={household ? household.name : tr('Share this list')}
      >
        {!household ? (
          <>
            <Text style={s.muted}>
              {tr(
                'A household shares one grocery list. Everyone in it sees the same items and can check them off.',
              )}
            </Text>
            <View style={[s.card, { gap: 12 }]}>
              <Text style={s.h3}>{tr('Start a household')}</Text>
              <Field
                label={tr('Household name')}
                placeholder={tr('Home, the flat, the family…')}
                value={name}
                onChangeText={setName}
                maxLength={60}
              />
              <Text style={[s.small, { fontFamily: font.medium }]}>
                {tr('Your grocery list comes with you.')}
              </Text>
              <SheetError message={errorFor('create')} />
              <Button
                title={tr('Create household')}
                icon={Users}
                disabled={!name.trim() || busy}
                busy={busy && step === 'create'}
                onPress={create}
              />
            </View>
            <View style={[s.card, { gap: 12 }]}>
              <Text style={s.h3}>{tr('Join with a code')}</Text>
              <Field
                label={tr('Invite code')}
                placeholder={tr('8 letters and numbers')}
                value={code}
                onChangeText={(text) => setCode(inviteCode(text))}
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                // The code itself reads letter by letter; the hint stays plain.
                style={code ? { fontFamily: font.bold, letterSpacing: 2 } : undefined}
              />
              <Text style={[s.small, { fontFamily: font.medium }]}>
                {tr('Your grocery list joins theirs.')}
              </Text>
              <SheetError message={errorFor('join')} />
              <Button
                title={tr('Join household')}
                variant="secondary"
                disabled={code.length !== 8 || busy}
                busy={busy && step === 'join'}
                onPress={join}
              />
            </View>
          </>
        ) : (
          <>
            <Text style={s.muted}>
              {tr('Everyone here shares one grocery list and can add to it or check things off.')}
            </Text>
            <View style={[s.card, { paddingVertical: 4, paddingRight: 8 }]}>
              {household.members.map((m, n) => (
                <View
                  key={m.id}
                  style={[
                    s.row,
                    { gap: 12, paddingVertical: 10 },
                    n > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderColor: color.line },
                  ]}
                >
                  <Avatar name={m.name} uri={m.avatar} size={40} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text numberOfLines={1} style={[s.h3, { fontSize: 15 }]}>
                      {m.id === me ? tr('{{v0}} (you)', { v0: m.name }) : m.name}
                    </Text>
                    <Text numberOfLines={1} style={s.small}>
                      {`@${m.handle} · ${m.role === 'owner' ? tr('Owner') : tr('Member')}`}
                    </Text>
                  </View>
                  {owner && m.id !== me && (
                    <IconButton
                      icon={UserMinus}
                      plain
                      size={44}
                      label={tr('Remove {{v0}} from the household', { v0: m.name })}
                      onPress={() => {
                        setError('');
                        setConfirm(m);
                      }}
                    />
                  )}
                </View>
              ))}
            </View>
            {invite ? (
              <View style={[s.card, { gap: 10, alignItems: 'center' }]}>
                <Text style={s.label}>{tr('Invite code')}</Text>
                <Text
                  selectable
                  // Screen readers spell it out a character at a time.
                  accessibilityLabel={invite.code.split('').join(' ')}
                  style={{
                    fontFamily: font.extra,
                    fontSize: 30,
                    lineHeight: 38,
                    letterSpacing: 4,
                    color: color.ink,
                  }}
                >
                  {invite.code}
                </Text>
                <Text style={[s.small, { fontFamily: font.medium, textAlign: 'center' }]}>
                  {until
                    ? tr('Anyone with this code can join until {{v0}}.', { v0: until })
                    : tr('Anyone with this code can join for the next 7 days.')}
                </Text>
                <SheetError message={errorFor('invite')} />
                <Button
                  small
                  variant="secondary"
                  icon={copied ? Check : Share2}
                  title={copied ? tr('Code copied') : tr('Share code')}
                  onPress={() => shareCode(invite)}
                />
              </View>
            ) : (
              <>
                <SheetError message={errorFor('invite')} />
                <Button
                  title={tr('Invite someone')}
                  icon={UserPlus}
                  variant="secondary"
                  disabled={busy}
                  busy={busy && step === 'invite'}
                  onPress={newInvite}
                />
              </>
            )}
            <Button
              title={tr('Leave household')}
              icon={LogOut}
              variant="ghost"
              onPress={() => {
                setError('');
                setConfirm('leave');
              }}
            />
          </>
        )}
      </Dialog>
      <Dialog
        visible={confirm === 'leave'}
        onClose={() => setConfirm(null)}
        title={tr('Leave this household?')}
      >
        <Text style={s.body}>
          {!owner
            ? tr('You’ll stop seeing the shared list. You can join again with a new code.')
            : others.length
              ? tr(
                  'You own this household. When you leave, the member who has been here longest becomes the owner.',
                )
              : tr('You’re the only one here, so leaving closes the household.')}
        </Text>
        <SheetError message={errorFor('leave')} />
        <DangerButton
          title={tr('Leave household')}
          busy={busy && step === 'leave'}
          onPress={() => void leave()}
        />
      </Dialog>
      <Dialog
        visible={!!member}
        onClose={() => setConfirm(null)}
        title={tr('Remove {{v0}}?', { v0: member?.name || '' })}
      >
        <Text style={s.body}>
          {tr('They’ll stop seeing the shared list. They can join again with a new code.')}
        </Text>
        <SheetError message={errorFor('remove')} />
        <DangerButton
          title={tr('Remove from household')}
          busy={busy && step === 'remove'}
          onPress={() => member && void remove(member)}
        />
      </Dialog>
    </>
  );
}

/** "Added by Sam" under a grocery someone else in the household put on the list. */
export function AddedBy({ name }: { name: string }) {
  const { t: tr } = useI18n();
  return (
    <Text numberOfLines={1} style={[s.small, { fontFamily: font.medium, color: color.muted }]}>
      {tr('Added by {{v0}}', { v0: name })}
    </Text>
  );
}
