import { expect, type Page } from '@playwright/test';

// The browser's speech, scripted, for hands-free tests: webkitSpeechRecognition hands the test's
// words to the session that is listening, and speechSynthesis writes down what it is asked to say
// and finishes at once. Add it with `page.addInitScript(fakeSpeech)`.

type Speech = { active: boolean; spoken: string[]; say: (text: string) => void };

export function fakeSpeech() {
  type Session = {
    aborted: boolean;
    onresult: ((event: unknown) => void) | null;
    onend: (() => void) | null;
  };
  let active: Session | null = null;
  const spoken: string[] = [];
  class Recognition {
    lang = '';
    continuous = false;
    interimResults = false;
    maxAlternatives = 1;
    aborted = false;
    onresult: Session['onresult'] = null;
    onerror: ((event: unknown) => void) | null = null;
    onend: Session['onend'] = null;
    start() {
      active = this;
    }
    abort() {
      this.aborted = true;
      if (active === this) active = null;
      setTimeout(() => this.onend?.(), 0);
    }
    stop() {
      this.abort();
    }
  }
  Object.assign(window, { webkitSpeechRecognition: Recognition, SpeechRecognition: Recognition });
  window.speechSynthesis.speak = (utterance) => {
    spoken.push(utterance.text);
    setTimeout(() => utterance.onend?.(new Event('end') as SpeechSynthesisEvent), 20);
  };
  window.speechSynthesis.cancel = () => {};
  const speech = {
    spoken,
    get active() {
      return !!active;
    },
    say(text: string) {
      const result = Object.assign([{ transcript: text, confidence: 0.9 }], { isFinal: true });
      active?.onresult?.({ resultIndex: 0, results: [result] });
    },
  };
  Object.assign(window, { speech });
}

/** What the page has said aloud so far. */
export const spoken = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { speech: Speech }).speech.spoken]);

/** Says `text` to the session listening, once one is. */
export async function say(page: Page, text: string) {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { speech: Speech }).speech.active))
    .toBe(true);
  await page.evaluate((words) => (window as unknown as { speech: Speech }).speech.say(words), text);
}
