/// <reference types="jest" />
import { printPage } from '../printRecipe.web';
import type { PrintableRecipe } from '../printRecipe';

const recipe: PrintableRecipe = {
  lang: 'fr-FR',
  title: 'Soupe',
  byline: 'par Robin',
  facts: ['30 min', '4 portions'],
  description: 'Une soupe.',
  image: 'https://media.example.com/soup.jpg',
  ingredientsTitle: 'Ingrédients',
  ingredients: [
    { name: 'Lait', amount: '480 ml' },
    { name: 'Sel', amount: '' },
  ],
  methodTitle: 'Préparation',
  steps: [
    { title: 'Chauffer', text: 'Chauffer le lait.' },
    { title: '', text: 'Servir.' },
  ],
  credits: ['D’après Soupe de Rosa'],
  link: 'https://savorly.cooking/?recipe=soup',
};
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const texts = (doc: Document, selector: string) =>
  [...doc.querySelectorAll(selector)].map((e) => e.textContent);

test('a page of its own: title, facts, ingredients to tick, numbered steps and credits', () => {
  const doc = parse(printPage(recipe));
  expect(doc.documentElement.lang).toBe('fr-FR');
  expect(doc.title).toBe('Soupe');
  expect(texts(doc, 'h1')).toEqual(['Soupe']);
  expect(texts(doc, '.meta')).toEqual(['par Robin', '30 min · 4 portions']);
  expect(texts(doc, 'h2')).toEqual(['Ingrédients', 'Préparation']);
  expect(texts(doc, '.ingredient')).toEqual(['Lait480 ml', 'Sel']);
  expect(doc.querySelectorAll('.ingredient .box')).toHaveLength(2);
  expect(texts(doc, 'ol > li')).toEqual(['ChaufferChauffer le lait.', 'Servir.']);
  expect(texts(doc, 'footer p')).toEqual([
    'D’après Soupe de Rosa',
    'https://savorly.cooking/?recipe=soup',
  ]);
  expect(doc.querySelector('img')?.getAttribute('src')).toBe('https://media.example.com/soup.jpg');
});

test('the cook’s text is escaped, and only web photos are shown', () => {
  const doc = parse(
    printPage({
      ...recipe,
      lang: 'en"><script>',
      title: 'Soup <script>alert(1)</script>',
      ingredients: [{ name: 'Salt & "pepper" <b>', amount: '<i>1</i>' }],
      steps: [{ title: '<img src=x onerror=alert(1)>', text: "It's </li></ol> done" }],
      image: 'javascript:alert(1)',
      credits: ['<a href="https://evil.example">x</a>'],
    }),
  );
  expect(doc.querySelectorAll('script, b, i, a, img, [onerror]')).toHaveLength(0);
  expect(doc.title).toBe('Soup <script>alert(1)</script>');
  expect(texts(doc, '.name')).toEqual(['Salt & "pepper" <b>']);
  expect(texts(doc, '.amount')).toEqual(['<i>1</i>']);
  expect(texts(doc, 'ol > li')).toEqual(["<img src=x onerror=alert(1)>It's </li></ol> done"]);
  expect(texts(doc, 'footer p')[0]).toBe('<a href="https://evil.example">x</a>');
});

test('empty parts are left out', () => {
  const doc = parse(
    printPage({ ...recipe, description: '', image: '', ingredients: [], steps: [], credits: [] }),
  );
  expect(doc.querySelectorAll('h2, img, .description')).toHaveLength(0);
  expect(texts(doc, 'footer p')).toEqual(['https://savorly.cooking/?recipe=soup']);
});
