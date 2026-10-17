import { createContext, useContext } from 'react';
import type { Creator, Recipe } from './types';

/**
 * What bookmark and follow buttons need, kept apart from the rest of the app's data the way
 * notifications.tsx keeps toasts apart: the value changes only when saves, follows or the signed-in
 * kitchen do, so the bookmark on every recipe tile doesn't re-render for a kitchen refresh, a new
 * recipe list or a profile edit. AppProvider supplies it.
 */
export type LibraryState = {
  /** Saved recipe ids, including saves still on their way to the server. */
  savedIds: string[];
  /** Followed kitchens' ids, including follows still on their way to the server. */
  followingIds: string[];
  /** The signed-in kitchen, or null when signed out. */
  userId: string | null;
  /** Saves or unsaves at once, asking to sign in first when needed. */
  toggleSave: (recipe: Recipe) => Promise<void>;
  /** Follows or unfollows at once, asking to sign in first when needed. */
  toggleFollow: (creator: Creator) => Promise<void>;
};

export const LibraryContext = createContext<LibraryState | null>(null);

export function useLibrary() {
  const library = useContext(LibraryContext);
  if (!library) throw new Error('AppProvider missing');
  return library;
}
