import type { PrintableRecipe } from './printRecipe';
import { sized } from './images';

export type { PrintableRecipe } from './printRecipe';

/** Whether this platform can print a recipe. */
export const canPrint = true;

const entities: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
// Everything on the page is the cook's own text, so all of it is escaped.
const escape = (text: string) => text.replace(/[&<>"']/g, (c) => entities[c]);

// A page of its own, so the printout has none of the app around it: the recipe in plain black type,
// boxes to tick off ingredients, numbered steps, and where it came from.
const css = `
@page { margin: 16mm 16mm 18mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; color: #000; background: #fff;
  font: 11pt/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial,
    "Noto Sans", "PingFang SC", "Hiragino Sans", "Microsoft YaHei", sans-serif; }
h1 { font-size: 22pt; line-height: 1.2; margin: 0 0 2mm; }
h2 { font-size: 13pt; margin: 8mm 0 2mm; padding-bottom: 1mm; border-bottom: 0.6pt solid #888; }
p { margin: 0; }
.meta { color: #333; }
.cover { display: block; width: 100%; max-height: 75mm; object-fit: cover; border-radius: 3mm;
  margin-top: 5mm; }
.description { margin-top: 4mm; }
ul { list-style: none; margin: 0; padding: 0; columns: 2; column-gap: 10mm; }
.ingredient { display: flex; align-items: baseline; gap: 3mm; padding: 1.2mm 0; break-inside: avoid; }
.box { flex: none; width: 3.4mm; height: 3.4mm; border: 0.7pt solid #000; border-radius: 0.6mm;
  transform: translateY(0.5mm); }
.name { flex: 1; }
.amount { font-weight: 600; white-space: nowrap; }
ol { margin: 0; padding-left: 7mm; }
.step { margin: 0 0 3.5mm; padding-left: 1mm; break-inside: avoid; }
.step strong { display: block; }
footer { margin-top: 9mm; padding-top: 2mm; border-top: 0.6pt solid #888; font-size: 9pt; color: #333; }
footer p { margin-bottom: 1mm; overflow-wrap: anywhere; }
`;

/** The printed page for a recipe, as a whole HTML document. */
export function printPage(recipe: PrintableRecipe) {
  const image = /^https?:\/\//i.test(recipe.image) ? sized(recipe.image, 800) : '';
  const paragraph = (text: string, name: string) =>
    text ? `<p class="${name}">${escape(text)}</p>` : '';
  const ingredients = recipe.ingredients
    .map(
      (i) =>
        `<li class="ingredient"><span class="box"></span><span class="name">${escape(i.name)}</span>` +
        (i.amount ? `<span class="amount">${escape(i.amount)}</span>` : '') +
        '</li>',
    )
    .join('');
  const steps = recipe.steps
    .map(
      (st) =>
        `<li class="step">${st.title ? `<strong>${escape(st.title)}</strong>` : ''}${escape(st.text)}</li>`,
    )
    .join('');
  return `<!doctype html><html lang="${escape(recipe.lang)}"><head><meta charset="utf-8">
<title>${escape(recipe.title)}</title><style>${css}</style></head><body>
<header><h1>${escape(recipe.title)}</h1>${paragraph(recipe.byline, 'meta')}${paragraph(recipe.facts.filter(Boolean).join(' · '), 'meta')}</header>
${image ? `<img class="cover" src="${escape(image)}" alt="">` : ''}
${paragraph(recipe.description, 'description')}
${recipe.ingredients.length ? `<section><h2>${escape(recipe.ingredientsTitle)}</h2><ul>${ingredients}</ul></section>` : ''}
${recipe.equipment?.length ? `<section><h2>${escape(recipe.equipmentTitle ?? '')}</h2><p class="equipment">${recipe.equipment.map(escape).join(' · ')}</p></section>` : ''}
${recipe.steps.length ? `<section><h2>${escape(recipe.methodTitle)}</h2><ol>${steps}</ol></section>` : ''}
<footer>${[...recipe.credits, recipe.link]
    .filter(Boolean)
    .map((line) => `<p>${escape(line)}</p>`)
    .join('')}</footer>
</body></html>`;
}

let frame: HTMLIFrameElement | null = null;

/**
 * Prints the recipe from a hidden frame holding just the printed page, once its photo has loaded
 * (or a few seconds have passed), and removes the frame after the print dialog closes.
 */
export function printRecipe(recipe: PrintableRecipe) {
  frame?.remove();
  const current = document.createElement('iframe');
  frame = current;
  current.title = recipe.title;
  current.tabIndex = -1;
  current.setAttribute('aria-hidden', 'true');
  current.setAttribute('data-print', 'recipe');
  current.setAttribute(
    'style',
    'position: fixed; right: 0; bottom: 0; width: 0; height: 0; border: 0; visibility: hidden;',
  );
  document.body.appendChild(current);
  const view = current.contentWindow;
  const doc = current.contentDocument;
  if (!view || !doc) {
    current.remove();
    return;
  }
  doc.open();
  doc.write(printPage(recipe));
  doc.close();
  view.addEventListener('afterprint', () => {
    if (frame === current) frame = null;
    setTimeout(() => current.remove(), 0);
  });
  const images = Array.from(doc.images).filter((img) => !img.complete);
  void Promise.race([
    Promise.all(
      images.map(
        (img) =>
          new Promise((resolve) => {
            img.addEventListener('load', resolve);
            img.addEventListener('error', resolve);
          }),
      ),
    ),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]).then(() => {
    if (frame !== current) return;
    view.focus();
    view.print();
  });
}
