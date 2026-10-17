/// <reference types="jest" />
import { speechLanguage } from '../useCookingNarration';

// The hook's players and storage aren't needed to choose a voice.
jest.mock('expo-audio', () => ({ createAudioPlayer: jest.fn(), setAudioModeAsync: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

test('a recipe is read in its own language, in that language’s usual voice', () => {
  expect(speechLanguage('en-US', 'fr')).toBe('fr-FR');
  expect(speechLanguage('fr-CA', 'ja')).toBe('ja-JP');
  expect(speechLanguage('de-DE', 'pt')).toBe('pt-BR');
});

test('the app’s own regional voice wins when the languages match', () => {
  expect(speechLanguage('en-GB', 'en')).toBe('en-GB');
  expect(speechLanguage('pt-PT', 'pt')).toBe('pt-PT');
  expect(speechLanguage('fr-CA', 'FR')).toBe('fr-CA');
});

test('recipes that don’t say their language are read in the app’s', () => {
  expect(speechLanguage('fr-FR')).toBe('fr-FR');
  expect(speechLanguage('fr-FR', '')).toBe('fr-FR');
  expect(speechLanguage('fr-FR', null)).toBe('fr-FR');
});

test('a regional tag or a language beyond the app’s nine is passed on as it is', () => {
  expect(speechLanguage('en-US', 'pt_PT')).toBe('pt-PT');
  expect(speechLanguage('en-US', 'nl')).toBe('nl');
});
