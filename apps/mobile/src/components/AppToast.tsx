import React from 'react';
import { useToastMessage } from '../lib/notifications';
import { Toast } from './ui';

// Only the toast subscribes to message changes; its containing screen does not.
export function AppToast({ hidden, bottom }: { hidden?: boolean; bottom?: number }) {
  const message = useToastMessage();
  return <Toast message={hidden ? '' : message} bottom={bottom} />;
}
