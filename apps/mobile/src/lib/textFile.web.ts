/** The largest file the cook may choose: a list of links or a few recipes is far smaller. */
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Lets the cook choose a text file (notes, a list of links, saved bookmarks), answering its name
 * and text, or null when they don't choose one. textFile.ts is the phones' side.
 */
export const pickTextFile: (() => Promise<{ name: string; text: string } | null>) | null = () =>
  new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.md,.markdown,.csv,.html,.htm,.json,text/*';
    input.addEventListener('cancel', () => resolve(null));
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      if (file.size > MAX_BYTES) return reject(new Error('Choose a file smaller than 2 MB.'));
      file.text().then((text) => resolve({ name: file.name, text }), reject);
    });
    input.click();
  });
