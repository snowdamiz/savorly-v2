// The admin console: moderation, members, recipes, AI operations, settings and the audit log.
// It's an operator tool, so it stays in English (see docs/ADMIN.md).
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import { RefreshCw, ShieldAlert, ShieldCheck } from '../../components/icons';
import { AdminSection, Overview as OverviewData } from '../../lib/admin';
import { useApp } from '../../lib/store';
import { Recipe } from '../../lib/types';
import { Empty, IconButton, PageHeading } from '../../components/ui';
import { MemberDialog, Members } from './Members';
import { Reports, Reviews } from './Moderation';
import { JobDialog, Operations, TurnDialog } from './Operations';
import { Overview } from './Overview';
import { Filters, Nav, AdminNav } from './parts';
import { RecipeDialog, Recipes } from './Recipes';
import { Audit, Settings } from './Settings';
import { AdminPending } from './AdminPending';
import { api } from '../../lib/api';

// Imported from ./AdminPending by My kitchen, so the console stays out of the first download.
export { AdminPending };

const sections: { value: AdminSection; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'reports', label: 'Reports' },
  { value: 'members', label: 'Members' },
  { value: 'recipes', label: 'Recipes' },
  { value: 'reviews', label: 'Reviews' },
  { value: 'ai', label: 'AI & jobs' },
  { value: 'settings', label: 'Settings' },
  { value: 'audit', label: 'Audit log' },
];
const isSection = (v: unknown): v is AdminSection => sections.some((x) => x.value === v);
type Sheet = { kind: 'member' | 'recipe' | 'job' | 'turn'; id: string; key: number };

export function Admin({ onOpen }: { onOpen: (r: Recipe) => void }) {
  const app = useApp();
  const user = app.user;
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
  return (
    <Nav.Provider value={nav}>
      <View style={{ gap: 18 }}>
        <PageHeading
          eyebrow="Operator"
          title="Admin console"
          subtitle={`Signed in as ${user.email}${user.adminOwner ? ' · owner' : ' · admin'}. Every change is recorded in the audit log.`}
        >
          <IconButton icon={RefreshCw} label="Refresh" onPress={nav.changed} />
        </PageHeading>
        <Filters
          options={sections.map((x) => ({
            value: x.value,
            label: x.value === 'reports' && openReports ? `Reports · ${openReports}` : x.label,
          }))}
          value={section}
          onChange={go}
        />
        <View>
          {section === 'overview' && <Overview />}
          {section === 'reports' && <Reports />}
          {section === 'members' && <Members />}
          {section === 'recipes' && <Recipes />}
          {section === 'reviews' && <Reviews />}
          {section === 'ai' && <Operations />}
          {section === 'settings' && <Settings />}
          {section === 'audit' && <Audit />}
        </View>
      </View>
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
