// Shown in Settings as well as in the console, so it lives apart from the console itself: that
// loads only when opened (a separate chunk on the web). Operator text, so English only.
import React from 'react';
import { Text, View } from 'react-native';
import { useApp } from '../../lib/store';
import { color, s } from '../../lib/theme';
import { Button } from '../../components/ui';
import { Notice } from './parts';

/** For an owner whose address isn't verified yet: how to open the console. */
export function AdminPending() {
  const app = useApp();
  if (!app.user?.adminPending) return null;
  return (
    <View style={{ gap: 10 }}>
      <Notice
        tone="warning"
        text={`${app.user.email} is an admin address, but it isn’t verified yet, so the admin console stays closed. Verify it by resetting your password from the sign-in screen (sign out first) or by connecting Google with this same address in Account and security below.`}
      />
      {app.capabilities?.passwordRecovery === false && (
        <Text style={[s.small, { color: color.muted }]}>
          Password-reset email isn’t configured on this server, so connect Google, or ask whoever
          runs the database to set email_verified for this account.
        </Text>
      )}
      <Button
        title="Sign out to reset my password"
        variant="secondary"
        small
        onPress={() => void app.act(app.signOut)}
      />
    </View>
  );
}
