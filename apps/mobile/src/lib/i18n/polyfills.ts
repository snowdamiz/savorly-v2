/* eslint-disable @typescript-eslint/no-require-imports */
// Hermes (iOS and Android) ships no Intl.PluralRules, which plural messages need, nor the
// Intl.Locale that FormatJS's PluralRules polyfill builds on. Browsers have both, so the web
// build uses polyfills.web.ts and carries none of this. Locale data registers only into the
// polyfill, for these languages.
if (typeof Intl.PluralRules !== 'function') {
  if (typeof Intl.Locale !== 'function') require('@formatjs/intl-locale/polyfill-force.js');
  require('@formatjs/intl-pluralrules/polyfill-force.js');
  require('@formatjs/intl-pluralrules/locale-data/en.js');
  require('@formatjs/intl-pluralrules/locale-data/fr.js');
  require('@formatjs/intl-pluralrules/locale-data/de.js');
  require('@formatjs/intl-pluralrules/locale-data/ru.js');
  require('@formatjs/intl-pluralrules/locale-data/es.js');
  require('@formatjs/intl-pluralrules/locale-data/it.js');
  require('@formatjs/intl-pluralrules/locale-data/pt.js');
  require('@formatjs/intl-pluralrules/locale-data/zh.js');
  require('@formatjs/intl-pluralrules/locale-data/ja.js');
}
