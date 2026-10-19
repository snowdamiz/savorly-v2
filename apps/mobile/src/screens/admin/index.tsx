// The admin console: moderation, members, recipes, AI operations, settings and the audit log.
// It's an operator tool, so it stays in English (see docs/ADMIN.md).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import {
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  CookingPot,
  Flag,
  Gauge,
  History,
  LucideIcon,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Users,
} from '../../components/icons';
import { AdminSection, Overview as OverviewData } from '../../lib/admin';
import { useApp } from '../../lib/store';
import { color, s } from '../../lib/theme';
import { Recipe } from '../../lib/types';
import { Dialog, Empty, IconButton, PageHeading, Press, useChrome } from '../../components/ui';
import { SettingsGroup } from '../../components/SettingsRow';
import { MemberDialog, Members } from './Members';
import { Reports, Reviews } from './Moderation';
import { JobDialog, Operations, TurnDialog } from './Operations';
import { Overview } from './Overview';
import { Cooking } from './Cooking';
import { AdminNav, Badge, Filters, Nav } from './parts';
import { RecipeDialog, Recipes } from './Recipes';
import { Audit, Settings } from './Settings';
import { AdminPending } from './AdminPending';
import { api } from '../../lib/api';

// Imported from ./AdminPending by My kitchen, so the console stays out of the first download.
export { AdminPending };

type Section = { value: AdminSection; label: string; text: string; icon: LucideIcon };
// The sections by what an admin comes to do; phones list them this way in the section menu.
const groups: { title: string; sections: Section[] }[] = [
  {
    title: 'At a glance',
    sections: [
      { value: 'overview', label: 'Overview', text: 'Alerts, growth, AI spend', icon: Gauge },
      {
        value: 'cooking',
        label: 'Cooking',
        text: 'Cooks, cook-along, creator fund',
        icon: CookingPot,
      },
    ],
  },
  {
    title: 'Moderation',
    sections: [
      { value: 'reports', label: 'Reports', text: 'Reported recipes to decide on', icon: Flag },
      { value: 'reviews', label: 'Reviews', text: 'Find and remove reviews', icon: Star },
    ],
  },
  {
    title: 'People and recipes',
    sections: [
      { value: 'members', label: 'Members', text: 'Accounts, plans, suspensions', icon: Users },
      { value: 'recipes', label: 'Recipes', text: 'Every recipe, drafts too', icon: BookOpen },
    ],
  },
  {
    title: 'Running Savorly',
    sections: [
      { value: 'ai', label: 'AI & jobs', text: 'Live voice, turns, jobs, spend', icon: Bot },
      {
        value: 'settings',
        label: 'Settings',
        text: 'Pauses, budgets, announcement',
        icon: SlidersHorizontal,
      },
      { value: 'audit', label: 'Audit log', text: 'Every change made here', icon: History },
    ],
  },
];
const sections = groups.flatMap((g) => g.sections);
const isSection = (v: unknown): v is AdminSection => sections.some((x) => x.value === v);
type Sheet = { kind: 'member' | 'recipe' | 'job' | 'turn'; id: string; key: number };

export function Admin({ onOpen }: { onOpen: (r: Recipe) => void }) {
  const app = useApp();
  const user = app.user;
  const { compact } = useChrome();
  const [menu, setMenu] = useState(false);
  const [section, setSection] = useState<AdminSection>(() => {
    const tab =
      Platform.OS === 'web' ? new URLSearchParams(window.location.search).get('tab') : null;
    return isSection(tab) ? tab : 'overview';
  });
  // Records open over the console as a stack, so a member opened from a recipe returns to it.
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [version, setVersion] = useState(0);
  const [openReports, setOpenReports] = useState(0);
  const push = useCallback(
    (kind: Sheet['kind'], id: string) =>
      setSheets((st) => [...st, { kind, id, key: Date.now() + Math.random() }]),
    [],
  );
  const go = useCallback((next: AdminSection) => {
    setSheets([]);
    setSection(next);
    if (Platform.OS === 'web') window.history.replaceState({}, '', `/?page=admin&tab=${next}`);
  }, []);
  // The open-report count rides on the Reports tab, refreshed with everything else.
  useEffect(() => {
    if (!user?.admin) return;
    void api<OverviewData>('/admin/overview')
      .then((o) => setOpenReports(o.stats.reports.recipes))
      .catch(() => {});
  }, [user?.admin, version]);
  const nav: AdminNav | null = useMemo(
    () =>
      user
        ? {
            me: user,
            // Owners are listed in ADMIN_EMAILS; the API is the authority on what they may do.
            owner: !!user.adminOwner,
            member: (id) => push('member', id),
            recipe: (id) => push('recipe', id),
            job: (id) => push('job', id),
            turn: (id) => push('turn', id),
            go,
            changed: () => setVersion((v) => v + 1),
            version,
          }
        : null,
    [user, push, go, version],
  );
  if (!user || !nav)
    return (
      <Empty
        title="Sign in to continue"
        text="The admin console is for Savorly admins."
        icon={ShieldCheck}
        action={() => app.setAuthOpen(true)}
        actionTitle="Sign in"
      />
    );
  if (!user.admin)
    return (
      <View style={{ gap: 16 }}>
        <Empty
          title="Admins only"
          text="The admin console is for Savorly admins."
          icon={ShieldAlert}
        />
        <AdminPending />
      </View>
    );
  const close = () => setSheets((st) => st.slice(0, -1));
  const view = (r: Recipe) => {
    setSheets([]);
    onOpen(r);
  };
  const signedIn = `Signed in as ${user.email}${user.adminOwner ? ' · owner' : ' · admin'}. Every change is recorded in the audit log.`;
  const current = sections.find((x) => x.value === section) ?? sections[0];
  const refresh = <IconButton icon={RefreshCw} label="Refresh" onPress={nav.changed} />;
  return (
    <Nav.Provider value={nav}>
      <View style={{ gap: compact ? 16 : 18 }}>
        {compact ? (
          // A phone has no room for nine tabs: the section's name opens the menu of them all.
          <View style={[s.row, { gap: 12 }]}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text role="heading" aria-level={1} style={s.label}>
                Admin console
              </Text>
              <Press
                accessibilityRole="button"
                accessibilityLabel={`${current.label}: choose a section`}
                onPress={() => setMenu(true)}
                scale={0.98}
                style={[s.row, { gap: 8, alignSelf: 'flex-start' }]}
              >
                <Text
                  numberOfLines={1}
                  style={[s.h1, { fontSize: 30, lineHeight: 36, flexShrink: 1 }]}
                >
                  {current.label}
                </Text>
                <ChevronDown size={24} color={color.ink} strokeWidth={2.4} />
                {section !== 'reports' && openReports > 0 && (
                  <Badge title={String(openReports)} tone="warning" icon={Flag} />
                )}
              </Press>
            </View>
            {refresh}
          </View>
        ) : (
          <PageHeading eyebrow="Operator" title="Admin console" subtitle={signedIn}>
            {refresh}
          </PageHeading>
        )}
        {!compact && (
          <Filters
            options={sections.map((x) => ({
              value: x.value,
              label: x.value === 'reports' && openReports ? `Reports · ${openReports}` : x.label,
            }))}
            value={section}
            onChange={go}
          />
        )}
        <View>
          {section === 'overview' && <Overview />}
          {section === 'cooking' && <Cooking />}
          {section === 'reports' && <Reports />}
          {section === 'members' && <Members />}
          {section === 'recipes' && <Recipes />}
          {section === 'reviews' && <Reviews />}
          {section === 'ai' && <Operations />}
          {section === 'settings' && <Settings />}
          {section === 'audit' && <Audit />}
        </View>
      </View>
      <Dialog visible={menu} onClose={() => setMenu(false)} title="Admin console">
        {groups.map((g) => (
          <SettingsGroup key={g.title} title={g.title}>
            {g.sections.map((x) => (
              <SectionRow
                key={x.value}
                section={x}
                active={x.value === section}
                count={x.value === 'reports' ? openReports : 0}
                onPress={() => {
                  setMenu(false);
                  go(x.value);
                }}
              />
            ))}
          </SettingsGroup>
        ))}
        <Text style={[s.small, { marginHorizontal: 4 }]}>{signedIn}</Text>
      </Dialog>
      {sheets.map((sheet) =>
        sheet.kind === 'member' ? (
          <MemberDialog key={sheet.key} id={sheet.id} onClose={close} />
        ) : sheet.kind === 'recipe' ? (
          <RecipeDialog key={sheet.key} id={sheet.id} onClose={close} onView={view} />
        ) : sheet.kind === 'turn' ? (
          <TurnDialog key={sheet.key} id={sheet.id} onClose={close} />
        ) : (
          <JobDialog key={sheet.key} id={sheet.id} onClose={close} />
        ),
      )}
    </Nav.Provider>
  );
}

/** A section in the phone's section menu, with what's waiting there. */
function SectionRow({
  section: x,
  active,
  count,
  onPress,
}: {
  section: Section;
  active: boolean;
  count: number;
  onPress: () => void;
}) {
  const Icon = x.icon;
  return (
    <Press
      accessibilityRole="button"
      accessibilityLabel={x.label}
      accessibilityState={{ selected: active }}
      onPress={onPress}
      scale={1}
      style={[
        s.row,
        {
          gap: 14,
          paddingHorizontal: 16,
          paddingVertical: 10,
          minHeight: 58,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderColor: color.border,
        },
      ]}
    >
      <Icon size={22} color={color.ink} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[s.h3, { fontSize: 15 }]}>{x.label}</Text>
        <Text style={s.small}>{x.text}</Text>
      </View>
      {count > 0 && <Badge title={String(count)} tone="warning" />}
      {active && <Check size={18} color={color.ink} strokeWidth={2.4} />}
    </Press>
  );
}
