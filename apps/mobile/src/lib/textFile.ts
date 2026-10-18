/**
 * Lets the cook choose a text file on this device, answering its name and text, or null when they
 * don't choose one. Phones have no file picker without a new native build, so there it's null and
 * the cook pastes instead; the web's is in textFile.web.ts.
 */
export const pickTextFile: (() => Promise<{ name: string; text: string } | null>) | null = null;
