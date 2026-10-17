// Before anything that formats text: native builds need Intl polyfills.
import './src/lib/i18n/polyfills';
import { Platform } from 'react-native';
import { registerRootComponent } from 'expo';

import App from './App';
import { color } from './src/lib/theme';

// Text fields show focus with their caret (and some with their own border), so the browser's
// focus ring around them goes everywhere. Everything else reached by keyboard gets an ink ring
// in place of the browser's blue one.
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  const sheet = document.createElement('style');
  sheet.textContent =
    `:focus-visible{outline:2px solid ${color.ink};outline-offset:2px}` +
    'input:focus,input:focus-visible,textarea:focus,textarea:focus-visible{outline:none}';
  document.head.appendChild(sheet);
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
