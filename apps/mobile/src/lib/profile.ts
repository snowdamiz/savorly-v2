import { api } from './api';
import { useApp } from './store';
import { User } from './types';

/** Diets the sous-chef can cook for; stored and sent as these English identifiers. */
export const dietOptions = ['Vegetarian', 'Vegan', 'Gluten free', 'Dairy free', 'High protein'];

export type ProfileChanges = Partial<
  Pick<User, 'name' | 'bio' | 'avatar' | 'handle' | 'preferences'>
>;

/** Saves some profile fields with the rest as they are (the API replaces the profile whole). */
export function useSaveProfile() {
  const app = useApp();
  return async (changes: ProfileChanges) => {
    const u = app.user!;
    await api('/me', {
      method: 'PATCH',
      body: {
        name: u.name,
        bio: u.bio,
        avatar: u.avatar,
        preferences: u.preferences,
        handle: u.handle,
        ...changes,
      },
    });
    await app.refreshUser();
  };
}
