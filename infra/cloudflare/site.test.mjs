// Checks the Worker's pure helpers without Cloudflare: `npm test` in infra/cloudflare.
// Node 22.18+ strips TypeScript types itself, so this imports site.ts directly.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyticsBeacon,
  appleAppSiteAssociation,
  assetLinks,
  contentSecurityPolicy,
  cookbookHead,
  cookbookIdFrom,
  cspReports,
  escapeHtml,
  invalidFingerprints,
  isExportFile,
  isHashedAsset,
  isRootApiPath,
  isoDuration,
  jsonForScript,
  originOf,
  parseCookbook,
  parseRecipe,
  recipeHead,
  recipeIdFrom,
  recipeJsonLd,
  robotsTxt,
  settingsFingerprint,
  sitemapXml,
  summary,
} from './site.ts';

const apiRecipe = {
  id: 'lemon-ricotta-pasta',
  title: 'Lemon & ricotta "pasta"',
  description: 'Bright, creamy and ready in twenty minutes. </script><script>alert(1)</script>',
  cuisine: 'Italian',
  minutes: 90,
  servings: 2,
  difficulty: 'Easy',
  image: 'https://media.savorly.cooking/u/1/cover.jpg',
  photos: ['https://media.savorly.cooking/u/1/side.jpg', 'javascript:alert(1)'],
  video: '',
  ingredients: [
    { name: 'Pasta', amount: 200, unit: 'g', category: 'Grains' },
    { name: 'Lemon', amount: 1, unit: '', category: 'Produce' },
    { name: 'Olive oil', amount: 0.3333333, unit: 'cup', category: 'Pantry' },
    { name: 'Salt', amount: 0, unit: '', category: 'Pantry' },
  ],
  steps: [
    { title: 'Cook the pasta', text: 'Boil it until al dente.', seconds: 600 },
    { title: '', text: 'Toss with the ricotta & lemon.', seconds: 0 },
  ],
  equipment: ['Large pot', ' ', 'Colander'],
  equipmentDetected: ['pot', 'colander'],
  tags: ['Vegetarian', 'Quick'],
  calories: 520,
  aiGenerated: false,
  published: true,
  createdAt: '2026-10-01T12:00:00.123456+00:00',
  rating: 4.5,
  reviewCount: 3,
  saveCount: 10,
  author: { id: 'u1', name: 'Mia <Rossi>', handle: 'mia', avatar: '', bio: '' },
};

test('escapes HTML text and attribute values', () => {
  assert.equal(
    escapeHtml(`<a href="x" title='y'>&</a>`),
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
  );
});

test('JSON for a script element cannot close it', () => {
  const out = jsonForScript({ text: '</script><!-- & \u2028' });
  assert.ok(!out.includes('<') && !out.includes('>') && !out.includes('&'));
  assert.ok(!out.includes('\u2028'));
  assert.deepEqual(JSON.parse(out), { text: '</script><!-- & \u2028' });
});

test('ISO 8601 durations from minutes', () => {
  assert.equal(isoDuration(45), 'PT45M');
  assert.equal(isoDuration(60), 'PT1H');
  assert.equal(isoDuration(90), 'PT1H30M');
  assert.equal(isoDuration(1440), 'PT24H');
  assert.equal(isoDuration(0), undefined);
  assert.equal(isoDuration(Number.NaN), undefined);
});

test('summaries cut at a word boundary', () => {
  assert.equal(summary('  short   text '), 'short text');
  const long = summary('word '.repeat(60), 40);
  assert.ok(Array.from(long).length <= 40);
  assert.ok(long.endsWith('word…'));
});

test('recipe ids come from /recipes/<id> and legacy /?recipe=<id> links', () => {
  const id = (url) => recipeIdFrom(new URL(url));
  assert.equal(id('https://savorly.cooking/recipes/abc-123'), 'abc-123');
  assert.equal(id('https://savorly.cooking/recipes/abc-123/'), 'abc-123');
  assert.equal(
    id('https://savorly.cooking/?recipe=4b9c0f1e-2d3a-4c5b-8e7f-0a1b2c3d4e5f'),
    '4b9c0f1e-2d3a-4c5b-8e7f-0a1b2c3d4e5f',
  );
  assert.equal(id('https://savorly.cooking/?page=kitchen'), undefined);
  assert.equal(id('https://savorly.cooking/recipes/'), undefined);
  assert.equal(id('https://savorly.cooking/recipes/a/b'), undefined);
  assert.equal(id('https://savorly.cooking/recipes/%3Cscript%3E'), undefined);
  assert.equal(id('https://savorly.cooking/recipes/%E0%A4%A'), undefined);
  assert.equal(id('https://savorly.cooking/other?recipe=abc'), undefined);
});

test('only published recipes with an id and title are used', () => {
  assert.equal(parseRecipe({ ...apiRecipe, published: false }), undefined);
  assert.equal(parseRecipe({ ...apiRecipe, title: ' ' }), undefined);
  assert.equal(parseRecipe({ ...apiRecipe, id: '../x' }), undefined);
  assert.equal(parseRecipe(null), undefined);
  assert.equal(parseRecipe([]), undefined);
  const recipe = parseRecipe({ ...apiRecipe, ingredients: 'nope', tags: [1, ' Quick '] });
  assert.deepEqual(recipe.ingredients, []);
  assert.deepEqual(recipe.tags, ['Quick']);
});

test('JSON-LD describes the recipe', () => {
  const recipe = parseRecipe(apiRecipe);
  const url = 'https://savorly.cooking/recipes/lemon-ricotta-pasta';
  const data = JSON.parse(JSON.stringify(recipeJsonLd(recipe, url)));
  assert.equal(data['@type'], 'Recipe');
  assert.equal(data.name, 'Lemon & ricotta "pasta"');
  assert.equal(data.url, url);
  assert.deepEqual(data.image, [
    'https://media.savorly.cooking/u/1/cover.jpg',
    'https://media.savorly.cooking/u/1/side.jpg',
  ]);
  assert.deepEqual(data.author, { '@type': 'Person', name: 'Mia <Rossi>' });
  assert.equal(data.datePublished, '2026-10-01T12:00:00.123Z');
  assert.equal(data.totalTime, 'PT1H30M');
  assert.equal(data.recipeYield, '2 servings');
  assert.equal(data.recipeCuisine, 'Italian');
  assert.equal(data.keywords, 'Vegetarian, Quick');
  assert.deepEqual(data.recipeIngredient, ['200 g Pasta', '1 Lemon', '0.33 cup Olive oil', 'Salt']);
  assert.deepEqual(data.recipeInstructions, [
    { '@type': 'HowToStep', name: 'Cook the pasta', text: 'Boil it until al dente.' },
    { '@type': 'HowToStep', text: 'Toss with the ricotta & lemon.' },
  ]);
  assert.deepEqual(data.aggregateRating, {
    '@type': 'AggregateRating',
    ratingValue: 4.5,
    ratingCount: 3,
    bestRating: 5,
    worstRating: 1,
  });
  assert.deepEqual(data.nutrition, { '@type': 'NutritionInformation', calories: '520 calories' });
  assert.deepEqual(data.tool, [
    { '@type': 'HowToTool', name: 'Large pot' },
    { '@type': 'HowToTool', name: 'Colander' },
  ]);

  const plain = JSON.parse(
    JSON.stringify(
      recipeJsonLd(
        parseRecipe({
          ...apiRecipe,
          reviewCount: 0,
          rating: 0,
          calories: 0,
          image: '',
          photos: [],
          equipment: undefined,
        }),
        url,
      ),
    ),
  );
  assert.equal(plain.aggregateRating, undefined);
  // Without the cook's own list (an older API, or only what the method mentions), no tool.
  assert.equal(plain.tool, undefined);
  assert.equal(plain.nutrition, undefined);
  assert.equal(plain.image, undefined);
});

test('the recipe head escapes everything it writes', () => {
  const head = recipeHead(parseRecipe(apiRecipe), 'https://savorly.cooking');
  assert.match(head, /<title>Lemon &amp; ricotta &quot;pasta&quot; — Savorly<\/title>/);
  assert.match(
    head,
    /<link rel="canonical" href="https:\/\/savorly.cooking\/recipes\/lemon-ricotta-pasta">/,
  );
  assert.match(
    head,
    /<meta property="og:image" content="https:\/\/media.savorly.cooking\/u\/1\/cover.jpg">/,
  );
  assert.match(head, /<meta property="og:title" content="Lemon &amp; ricotta &quot;pasta&quot;">/);
  assert.match(head, /<meta name="twitter:card" content="summary_large_image">/);
  // The only literal script tags are the JSON-LD element's own.
  assert.equal(head.match(/<script/g).length, 1);
  assert.equal(head.match(/<\/script>/g).length, 1);
  assert.ok(!head.includes('<script>alert'));
  const json = head.match(/<script type="application\/ld\+json">(.*)<\/script>/s)[1];
  assert.equal(JSON.parse(json).description, apiRecipe.description);
  // Without a photo, previews use the site image.
  const bare = recipeHead(
    parseRecipe({ ...apiRecipe, image: '', photos: [] }),
    'https://staging.savorly.cooking',
  );
  assert.match(bare, /og:image" content="https:\/\/staging.savorly.cooking\/og-image.png"/);
});

test('the sitemap lists the home page and each recipe', () => {
  const xml = sitemapXml('https://savorly.cooking', {
    recipes: [
      { id: 'a1', updatedAt: '2026-10-15T08:00:00Z' },
      { id: 'b&2', updatedAt: '2026-10-15T08:00:00Z' },
      { id: 'c3', updatedAt: 'not a date' },
      { id: 4 },
    ],
    creators: [{ id: 'u1', handle: 'mia', updatedAt: '2026-10-15T08:00:00Z' }],
  });
  assert.match(
    xml,
    /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/,
  );
  assert.match(xml, /<url><loc>https:\/\/savorly.cooking\/<\/loc><\/url>/);
  assert.match(
    xml,
    /<url><loc>https:\/\/savorly.cooking\/recipes\/a1<\/loc><lastmod>2026-10-15T08:00:00.000Z<\/lastmod><\/url>/,
  );
  assert.match(xml, /<url><loc>https:\/\/savorly.cooking\/recipes\/c3<\/loc><\/url>/);
  assert.ok(!xml.includes('b&2') && !xml.includes('/recipes/4'));
  assert.equal(xml.match(/<url>/g).length, 3);
  assert.equal(sitemapXml('https://savorly.cooking', { error: 'x' }), undefined);
  assert.equal(sitemapXml('https://savorly.cooking', null), undefined);
});

test('the sitemap also lists public cookbooks', () => {
  const xml = sitemapXml('https://savorly.cooking', {
    recipes: [{ id: 'a1' }],
    cookbooks: [{ id: 'weeknights', updatedAt: '2026-10-15T08:00:00Z' }, { id: '../x' }],
  });
  assert.match(
    xml,
    /<url><loc>https:\/\/savorly.cooking\/cookbooks\/weeknights<\/loc><lastmod>2026-10-15T08:00:00.000Z<\/lastmod><\/url>/,
  );
  assert.equal(xml.match(/<url>/g).length, 3);
});

test('a shared cookbook link gets its own title, description and photo', () => {
  assert.equal(cookbookIdFrom(new URL('https://savorly.cooking/cookbooks/cb-1')), 'cb-1');
  assert.equal(cookbookIdFrom(new URL('https://savorly.cooking/cookbooks/cb-1/')), 'cb-1');
  assert.equal(cookbookIdFrom(new URL('https://savorly.cooking/cookbooks/a/b')), undefined);
  assert.equal(cookbookIdFrom(new URL('https://savorly.cooking/cookbooks/%E0%A4%A')), undefined);
  assert.equal(cookbookIdFrom(new URL('https://savorly.cooking/recipes/cb-1')), undefined);
  const api = {
    id: 'cb-1',
    name: 'Weeknight <dinners>',
    description: '',
    public: true,
    owner: { name: 'Mia "Chef" Chen' },
    recipes: [{ image: 'https://media.example/a.jpg' }, { image: 'javascript:alert(1)' }],
  };
  assert.equal(parseCookbook({ ...api, public: false }), undefined);
  assert.equal(parseCookbook({ ...api, name: ' ' }), undefined);
  const cookbook = parseCookbook(api);
  assert.deepEqual(cookbook.images, ['https://media.example/a.jpg']);
  assert.equal(cookbook.recipeCount, 2);
  const head = cookbookHead(cookbook, 'https://savorly.cooking');
  assert.match(head, /<title>Weeknight &lt;dinners&gt; — Savorly<\/title>/);
  assert.match(head, /content="A cookbook by Mia &quot;Chef&quot; Chen on Savorly: 2 recipes."/);
  assert.match(head, /<link rel="canonical" href="https:\/\/savorly.cooking\/cookbooks\/cb-1">/);
  assert.match(head, /og:image" content="https:\/\/media.example\/a.jpg"/);
  assert.ok(!head.includes('javascript:'));
});

test('robots.txt allows crawling in production and nothing on staging', () => {
  assert.equal(
    robotsTxt('https://savorly.cooking', false),
    'User-agent: *\nAllow: /\n\nSitemap: https://savorly.cooking/sitemap.xml\n',
  );
  assert.equal(
    robotsTxt('https://staging.savorly.cooking', true),
    'User-agent: *\nAllow: /.well-known/\nDisallow: /\n',
  );
});

test('apple-app-site-association needs a valid team id and bundle id', () => {
  assert.deepEqual(appleAppSiteAssociation('ABCDE12345', 'app.savorly.mobile.staging'), {
    applinks: {
      details: [
        {
          appIDs: ['ABCDE12345.app.savorly.mobile.staging'],
          components: [
            { '/': '/recipes/*', comment: 'Recipe pages open in the app.' },
            { '/': '/cookbooks/*', comment: 'Public cookbooks open in the app.' },
          ],
        },
      ],
    },
  });
  assert.equal(appleAppSiteAssociation('', 'app.savorly.mobile'), undefined);
  assert.equal(appleAppSiteAssociation('abcde12345', 'app.savorly.mobile'), undefined);
  assert.equal(appleAppSiteAssociation('ABCDE12345', undefined), undefined);
});

test('assetlinks.json normalizes fingerprints and drops invalid ones', () => {
  const hex = 'ab'.repeat(32);
  const colons = Array(32).fill('CD').join(':');
  const links = assetLinks(` ${hex}, nope ,${colons}`, 'app.savorly.mobile');
  assert.deepEqual(links, [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'app.savorly.mobile',
        sha256_cert_fingerprints: [Array(32).fill('AB').join(':'), colons],
      },
    },
  ]);
  assert.deepEqual(invalidFingerprints(` ${hex}, nope ,${colons},`), ['nope']);
  assert.deepEqual(invalidFingerprints(undefined), []);
  assert.equal(assetLinks('nope', 'app.savorly.mobile'), undefined);
  assert.equal(assetLinks(hex, ''), undefined);
  assert.equal(assetLinks(undefined, 'app.savorly.mobile'), undefined);
});

test('the CSP allows what the app loads and reports to /csp-report', () => {
  const csp = contentSecurityPolicy({ mediaOrigin: 'https://media.savorly.cooking' });
  const directive = (name) => csp.split('; ').find((d) => d.startsWith(`${name} `));
  assert.equal(directive('default-src'), "default-src 'self'");
  assert.equal(
    directive('script-src'),
    "script-src 'self' https://appleid.cdn-apple.com https://challenges.cloudflare.com",
  );
  assert.equal(
    directive('img-src'),
    "img-src 'self' https://media.savorly.cooking https: data: blob:",
  );
  assert.equal(directive('media-src'), "media-src 'self' https://media.savorly.cooking blob:");
  assert.equal(directive('object-src'), "object-src 'none'");
  assert.equal(directive('report-uri'), 'report-uri /csp-report');
  assert.ok(!csp.includes('unsafe-eval'));
  const withAnalytics = contentSecurityPolicy({ analytics: true });
  assert.match(withAnalytics, /script-src [^;]*https:\/\/static.cloudflareinsights.com/);
  assert.match(withAnalytics, /connect-src [^;]*https:\/\/cloudflareinsights.com/);
  assert.match(withAnalytics, /media-src 'self' blob:;/);
});

test('only content-hashed export files are cached for good', () => {
  assert.ok(isHashedAsset('/_expo/static/js/web/index-bbf470f42027fe6660b5bcaa29e5c4b4.js'));
  assert.ok(
    isHashedAsset(
      '/assets/node_modules/@expo-google-fonts/manrope/400Regular/Manrope_400Regular.8ca1a84037fdb644723129315c390ad9.ttf',
    ),
  );
  assert.ok(!isHashedAsset('/assets/logo.png'));
  assert.ok(!isHashedAsset('/icons/icon-192.png'));
  assert.ok(!isHashedAsset('/index.html'));
  assert.ok(!isHashedAsset('/recipes/8ca1a84037fdb644723129315c390ad9.js'));
});

test('missing export files are told apart from the app’s own pages', () => {
  assert.ok(isExportFile('/_expo/static/js/web/Kitchen-0123456789abcdef0123456789abcdef.js'));
  assert.ok(isExportFile('/assets/logo.png'));
  assert.ok(!isExportFile('/'));
  assert.ok(!isExportFile('/recipes/lemon-toast'));
  assert.ok(!isExportFile('/cookbooks/weeknights'));
  assert.ok(!isExportFile('/assetsx/logo.png'));
  assert.ok(!isExportFile('/privacy.html'));
});

test('the assistants’ paths go to the API, and the consent page stays the app’s', () => {
  for (const path of [
    '/mcp',
    '/oauth/token',
    '/oauth/register',
    '/oauth/revoke',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
  ])
    assert.ok(isRootApiPath(path), path);
  for (const path of [
    '/oauth/authorize',
    '/mcp/',
    '/MCP',
    '/.well-known/openid-configuration',
    '/.well-known/apple-app-site-association',
    '/recipes/mcp',
  ])
    assert.ok(!isRootApiPath(path), path);
});

test('media origins come from S3_PUBLIC_URL', () => {
  assert.equal(originOf('https://media.savorly.cooking'), 'https://media.savorly.cooking');
  assert.equal(originOf('https://pub-123.r2.dev/'), 'https://pub-123.r2.dev');
  assert.equal(originOf('http://localhost:8333/savorly-media'), 'http://localhost:8333');
  assert.equal(originOf(''), undefined);
  assert.equal(originOf('ftp://x'), undefined);
  assert.equal(originOf(undefined), undefined);
});

test('CSP reports become short log fields', () => {
  const legacy = {
    'csp-report': {
      'document-uri': 'https://savorly.cooking/recipes/1',
      'violated-directive': 'img-src',
      'effective-directive': 'img-src',
      'blocked-uri': 'https://tracker.example/pixel.gif',
      'original-policy': 'x'.repeat(5000),
      'line-number': 10,
      disposition: 'report',
    },
  };
  assert.deepEqual(cspReports(legacy), [
    {
      directive: 'img-src',
      blocked: 'https://tracker.example/pixel.gif',
      document: 'https://savorly.cooking/recipes/1',
      line: 10,
      disposition: 'report',
    },
  ]);
  const modern = [
    {
      type: 'csp-violation',
      body: {
        effectiveDirective: 'script-src-elem',
        blockedURL: 'x'.repeat(400),
        documentURL: 'https://savorly.cooking/',
      },
    },
    { type: 'deprecation', body: {} },
  ];
  const [report] = cspReports(modern);
  assert.equal(report.directive, 'script-src-elem');
  assert.equal(report.blocked.length, 300);
  assert.equal(cspReports(modern).length, 1);
  assert.deepEqual(cspReports('nonsense'), []);
  assert.deepEqual(cspReports({ 'csp-report': {} }), []);
});

test('settings fingerprints ignore order and change with any value', async () => {
  const a = await settingsFingerprint({ DATABASE_URL: 'postgres://a', APP_ENV: 'production' });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(
    a,
    await settingsFingerprint({ APP_ENV: 'production', DATABASE_URL: 'postgres://a' }),
  );
  assert.notEqual(
    a,
    await settingsFingerprint({ APP_ENV: 'production', DATABASE_URL: 'postgres://b' }),
  );
  assert.notEqual(a, await settingsFingerprint({ APP_ENV: 'production' }));
});

test('the analytics beacon needs a plausible token', () => {
  assert.equal(
    analyticsBeacon('0123456789abcdef0123456789abcdef'),
    '<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon="{&quot;token&quot;:&quot;0123456789abcdef0123456789abcdef&quot;,&quot;spa&quot;:true}"></script>',
  );
  assert.equal(analyticsBeacon(''), undefined);
  assert.equal(analyticsBeacon('"><script>'), undefined);
  assert.equal(analyticsBeacon(undefined), undefined);
});
