import type { Recognition, RecognitionError, RecognitionPlace } from './recognition';

// Continuous listening over sessions the platform keeps ending: a browser stops after a silence
// or a minute, iOS after about a minute, older Android after every phrase. While it's on, each
// session that ends starts the next one, a little later when they keep ending at once or failing.
// Holds pause it without turning it off: while the app speaks or reads a step (so it never hears
// itself), while the app is in the background, during a live sous-chef call.

export type ListenerStatus =
  | 'off'
  | 'starting'
  | 'listening'
  | 'paused'
  /** Not allowed, and the system will ask again. */
  | 'denied'
  /** Not allowed, and only Settings can change that. */
  | 'blocked'
  | 'unsupported'
  | 'language'
  | 'microphone'
  /** Stopped after recognition kept failing. */
  | 'failed';

/** Why listening stopped by itself. */
export type ListenerProblem = Extract<
  ListenerStatus,
  'denied' | 'blocked' | 'unsupported' | 'language' | 'microphone' | 'failed'
>;

type Dependencies = {
  recognition: Recognition;
  /** BCP-47 language to recognize. */
  language: string;
  hints: string[];
  onStatus: (status: ListenerStatus) => void;
  /** A final transcript: one thing the cook said. */
  onUtterance: (text: string) => void;
  /** Where the running session recognizes speech. */
  onPlace?: (place: RecognitionPlace) => void;
  now?: () => number;
};

/** Transient failures in a row before listening gives up. */
const MAX_FAILURES = 5;
/** The pause after a hold ends, so the tail of the app's own voice isn't heard. */
const AFTER_HOLD_MS = 400;

export class HandsFreeListener {
  private on = false;
  /** Permission was granted since it was turned on. */
  private allowed = false;
  private holds = new Set<string>();
  /** Identifies the running session; events from an older one are ignored. */
  private session = 0;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  /** Transient failures in a row. */
  private failures = 0;
  /** Sessions in a row that ended within a second having heard nothing. */
  private quick = 0;
  private startedAt = 0;
  private heard = false;
  private current: ListenerStatus = 'off';
  private deps: Dependencies;

  constructor(deps: Dependencies) {
    this.deps = deps;
  }

  get status() {
    return this.current;
  }

  /** Turns listening on: asks for permission, then keeps a session running unless held. */
  async enable() {
    if (this.on) return;
    this.on = true;
    this.failures = 0;
    this.quick = 0;
    this.set('starting');
    const { recognition } = this.deps;
    if (!recognition.supported()) return this.stopWith('unsupported');
    const permission = await recognition.permission().catch(() => 'denied' as const);
    if (!this.on) return;
    if (permission !== 'granted') return this.stopWith(permission);
    this.allowed = true;
    this.begin();
  }

  disable() {
    this.on = false;
    this.allowed = false;
    this.halt();
    this.set('off');
  }

  /** Pauses listening for `reason` until it's released; several reasons can hold at once. */
  hold(reason: string, held: boolean) {
    const had = this.holds.size > 0;
    if (held) this.holds.add(reason);
    else this.holds.delete(reason);
    if (!this.on || had === this.holds.size > 0) return;
    if (this.holds.size) {
      this.halt();
      this.set('paused');
    } else if (this.allowed) {
      this.set('starting');
      this.later(AFTER_HOLD_MS);
    } else this.set('starting');
  }

  /** Recognizes another language (or with other hints) from the next session on. */
  setLanguage(language: string, hints: string[]) {
    if (language === this.deps.language && hints.join('\n') === this.deps.hints.join('\n')) return;
    this.deps = { ...this.deps, language, hints };
    if (this.running) {
      this.halt();
      this.later(AFTER_HOLD_MS);
    }
  }

  dispose() {
    this.disable();
  }

  private set(status: ListenerStatus) {
    if (status === this.current) return;
    this.current = status;
    this.deps.onStatus(status);
  }

  private now() {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private stopWith(status: ListenerStatus) {
    this.on = false;
    this.allowed = false;
    this.halt();
    this.set(status);
  }

  private halt() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.running) return;
    this.session++;
    this.running = false;
    this.deps.recognition.abort();
  }

  private later(ms: number) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.begin(), ms);
  }

  private begin() {
    this.timer = undefined;
    if (!this.on || !this.allowed || this.running) return;
    if (this.holds.size) return this.set('paused');
    const session = ++this.session;
    this.running = true;
    this.startedAt = this.now();
    this.heard = false;
    this.set('listening');
    const live = () => session === this.session;
    this.deps.recognition
      .start({
        language: this.deps.language,
        hints: this.deps.hints,
        onResult: (text, final) => {
          if (!live()) return;
          this.heard = true;
          this.failures = 0;
          if (final) this.deps.onUtterance(text);
        },
        onError: (error) => live() && this.failed(error),
        onEnd: () => {
          if (!live()) return;
          this.running = false;
          this.next();
        },
      })
      .then(
        (place) => live() && this.deps.onPlace?.(place),
        () => {
          if (!live()) return;
          this.running = false;
          this.failed('transient');
          if (this.on) this.next();
        },
      );
  }

  private failed(error: RecognitionError) {
    switch (error) {
      case 'quiet':
        return;
      case 'denied':
        return this.stopWith('denied');
      case 'unavailable':
        return this.stopWith('unsupported');
      case 'language':
        return this.stopWith('language');
      case 'microphone':
        return this.stopWith('microphone');
      default:
        if (++this.failures >= MAX_FAILURES) this.stopWith('failed');
    }
  }

  // The next session after one ended: at once normally, backing off while sessions keep ending
  // straight away (a recognizer with nothing to do) or failing (no network, a busy service).
  private next() {
    if (!this.on) return;
    const lasted = this.now() - this.startedAt;
    if (!this.heard && lasted < 1000) this.quick++;
    else if (this.heard || lasted >= 3000) this.quick = 0;
    const delay = this.failures
      ? Math.min(1000 * 2 ** (this.failures - 1), 15000)
      : this.quick
        ? Math.min(250 * 2 ** this.quick, 8000)
        : 250;
    this.later(delay);
  }
}
