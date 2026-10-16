import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';

const NotifyContext = createContext<((message: string) => void) | null>(null);
const MessageContext = createContext('');

// Transient messages have their own state boundary: showing or dismissing a toast must not
// invalidate the app-data context and every screen, recipe card and bookmark subscribed to it.
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [message, setMessage] = useState('');
  const notify = useCallback((next: string) => setMessage(next), []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 4500);
    return () => clearTimeout(timer);
  }, [message]);
  return (
    <NotifyContext.Provider value={notify}>
      <MessageContext.Provider value={message}>{children}</MessageContext.Provider>
    </NotifyContext.Provider>
  );
}

export function useNotify() {
  const notify = useContext(NotifyContext);
  if (!notify) throw new Error('NotificationsProvider missing');
  return notify;
}

export const useToastMessage = () => useContext(MessageContext);
