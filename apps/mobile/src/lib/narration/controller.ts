export type NarrationState = 'idle' | 'loading' | 'playing' | 'blocked';
export type PlayerEvent = 'playing' | 'ended' | 'error';
export type NarrationPlayer = {
  play: () => Promise<void>;
  stop: () => void;
  dispose: () => void;
};
type Entry = {
  player?: NarrationPlayer;
  promise: Promise<NarrationPlayer>;
  failed: boolean;
  /** The cloud's path for the step, once the API has named it. */
  path?: string;
  /** Plays the device's copy of the step (or looked for one) rather than the cloud's stream. */
  kept?: boolean;
  /** The API turned the step down (rather than being out of reach): device speech reads it. */
  refused?: boolean;
  /** Heard from the cloud, and so kept (once: native players report playing again and again). */
  heard?: boolean;
};
type Dependencies = {
  enabled: boolean;
  texts: string[];
  /** Asks the API for a step's narration: the path its audio streams from. */
  prepare: (step: number, text: string) => Promise<string>;
  /** A player for a cloud path (from `prepare`) or for the device's copy of a step (from `kept`). */
  player: (source: string, event: (event: PlayerEvent) => void) => NarrationPlayer;
  /**
   * The device's copy of a step's cloud narration, as a source for `player`, or null. With `path`,
   * only the copy of that recording; without, the newest copy of the step's text.
   */
  kept?: (step: number, text: string, path?: string) => Promise<string | null>;
  /** Keeps a copy of a step that played from the cloud, for `kept`. */
  keep?: (step: number, text: string, path: string) => void;
  /** Whether `prepare` failed because the API couldn't be reached, rather than turning it down. */
  unreachable?: (error: unknown) => boolean;
  speak: (text: string, done: () => void) => void;
  stopSpeech: () => void;
  state: (state: NarrationState) => void;
};

// Request identity prevents a late network/player callback from speaking an old
// step after Next, Stop, Finish, or closing the cooking screen.
// A step plays from the cloud, and a step heard from the cloud is kept on the device. When the
// cloud can't be reached, or its audio fails or never starts, the device's copy plays with the
// same controls and preloading; only then does device speech read the step.
export class CookingNarration {
  private entries = new Map<number, Entry>();
  private step = 0;
  private request = 0;
  private active: number | null = null;
  private disposed = false;
  private used = false;
  private deadline?: ReturnType<typeof setTimeout>;
  private deps: Dependencies;

  constructor(deps: Dependencies) {
    this.deps = deps;
  }

  select(step: number) {
    this.stop();
    this.step = step;
    for (const [index, entry] of this.entries) {
      if (index < step - 1 || index > step + 1) {
        entry.player?.dispose();
        this.entries.delete(index);
      }
    }
    if (this.used && this.deps.enabled) this.preload(step);
  }

  read() {
    if (this.disposed) return;
    this.stop();
    this.used = true;
    const request = this.request;
    const step = this.step;
    if (!this.deps.enabled) {
      this.speak(request);
      return;
    }
    this.active = step;
    this.deps.state('loading');
    this.deadline = setTimeout(() => this.fallback(request), 12000);
    const entry = this.entries.get(step);
    // Preserve the click's user activation when the next step was preloaded.
    if (entry?.player && !entry.failed) this.start(request, entry.player);
    else
      void this.prepare(step)
        .then((player) => this.start(request, player))
        .catch(() => this.fallback(request));
  }

  stop() {
    this.request++;
    clearTimeout(this.deadline);
    const active = this.active;
    this.active = null;
    if (active !== null) this.entries.get(active)?.player?.stop();
    this.deps.stopSpeech();
    if (!this.disposed) this.deps.state('idle');
  }

  dispose() {
    this.disposed = true;
    this.stop();
    for (const entry of this.entries.values()) entry.player?.dispose();
    this.entries.clear();
  }

  private start(request: number, player: NarrationPlayer) {
    if (this.disposed || request !== this.request) return;
    void player.play().catch((error: unknown) => {
      if (request !== this.request || this.disposed) return;
      if (error instanceof Error && error.name === 'NotAllowedError') {
        // Safari may require another gesture after the first async download.
        this.stop();
        this.deps.state('blocked');
      } else this.fallback(request);
    });
  }

  private preload(step: number) {
    if (step < this.deps.texts.length && !this.disposed) void this.prepare(step).catch(() => {});
  }

  private prepare(step: number): Promise<NarrationPlayer> {
    const existing = this.entries.get(step);
    if (existing)
      return existing.failed
        ? Promise.reject(new Error('Narration unavailable'))
        : existing.promise;
    const text = this.deps.texts[step];
    const entry: Entry = {
      failed: false,
      promise: this.deps
        .prepare(step, text)
        .then(
          (path) => {
            entry.path = path;
            return this.open(step, entry, path);
          },
          async (error: unknown) => {
            // Turned down (a changed recipe, a step too long…): device speech, as ever.
            if (!this.deps.unreachable?.(error)) entry.refused = true;
            const kept = this.deps.kept;
            if (entry.refused || !kept || this.disposed || this.entries.get(step) !== entry)
              throw error;
            // Out of reach: the device's copy of the step stands in.
            entry.kept = true;
            const source = await kept(step, text);
            if (!source) throw error;
            return this.open(step, entry, source);
          },
        )
        .catch((error) => {
          entry.failed = true;
          throw error;
        }),
    };
    this.entries.set(step, entry);
    return entry.promise;
  }

  private open(step: number, entry: Entry, source: string) {
    if (this.disposed || this.entries.get(step) !== entry) throw new Error('Narration cancelled');
    const player = this.deps.player(source, (event) => {
      if (event === 'error') entry.failed = true;
      if (this.disposed || this.active !== step || this.entries.get(step) !== entry) return;
      if (event === 'error') this.fallback(this.request);
      if (event === 'ended') this.stop();
      if (event === 'playing') {
        clearTimeout(this.deadline);
        this.deps.state('playing');
        if (!entry.kept && !entry.heard && entry.path) {
          entry.heard = true;
          this.deps.keep?.(step, this.deps.texts[step], entry.path);
        }
        this.preload(step + 1);
      }
    });
    entry.player = player;
    return player;
  }

  /**
   * The cloud's narration of the step didn't play: the device's copy plays when there is one (of
   * the same recording, once the API has named it), else device speech reads the step.
   */
  private fallback(request: number) {
    if (this.disposed || request !== this.request) return;
    const step = this.step;
    const entry = this.entries.get(step);
    const kept = this.deps.kept;
    if (!kept || !entry || entry.kept || entry.refused) {
      this.speak(request);
      return;
    }
    // Still loading while the device looks for its copy.
    this.stop();
    const attempt = this.request;
    this.active = step;
    this.deps.state('loading');
    this.deadline = setTimeout(() => this.speak(attempt), 12000);
    void kept(step, this.deps.texts[step], entry.path).then(
      (source) => {
        if (this.disposed || attempt !== this.request) return;
        // Without a copy, the cloud's entry stays as it was, for the next tap.
        if (!source) return this.speak(attempt);
        // The copy takes the step's place. The cloud's player is let go once its own event, which
        // may have brought us here, is over; a late answer for it is ignored.
        const cloud = entry.player;
        if (cloud) setTimeout(() => cloud.dispose(), 0);
        const copy: Entry = {
          failed: false,
          kept: true,
          path: entry.path,
          promise: Promise.resolve()
            .then(() => this.open(step, copy, source))
            .catch((error) => {
              copy.failed = true;
              throw error;
            }),
        };
        this.entries.set(step, copy);
        void copy.promise
          .then((player) => this.start(attempt, player))
          .catch(() => this.speak(attempt));
      },
      () => this.speak(attempt),
    );
  }

  private speak(request: number) {
    if (this.disposed || request !== this.request) return;
    this.stop();
    const fallbackRequest = this.request;
    this.deps.state('playing');
    this.deps.speak(this.deps.texts[this.step], () => {
      if (!this.disposed && fallbackRequest === this.request) this.deps.state('idle');
    });
  }
}
