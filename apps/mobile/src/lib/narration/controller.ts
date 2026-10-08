export type NarrationState = 'idle' | 'loading' | 'playing' | 'blocked';
export type PlayerEvent = 'playing' | 'ended' | 'error';
export type NarrationPlayer = {
  play: () => Promise<void>;
  stop: () => void;
  dispose: () => void;
};
type Entry = { player?: NarrationPlayer; promise: Promise<NarrationPlayer>; failed: boolean };
type Dependencies = {
  enabled: boolean;
  texts: string[];
  prepare: (step: number, text: string) => Promise<string>;
  player: (path: string, event: (event: PlayerEvent) => void) => NarrationPlayer;
  speak: (text: string, done: () => void) => void;
  stopSpeech: () => void;
  state: (state: NarrationState) => void;
};

// Request identity prevents a late network/player callback from speaking an old
// step after Next, Stop, Finish, or closing the cooking screen.
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
      this.fallback(request);
      return;
    }
    this.active = step;
    this.deps.state('loading');
    this.deadline = setTimeout(() => this.fallback(request), 12000);
    const start = (player: NarrationPlayer) => {
      if (this.disposed || request !== this.request) return;
      void player.play().catch((error: unknown) => {
        if (request !== this.request || this.disposed) return;
        if (error instanceof Error && error.name === 'NotAllowedError') {
          // Safari may require another gesture after the first async download.
          this.stop();
          this.deps.state('blocked');
        } else this.fallback(request);
      });
    };
    const entry = this.entries.get(step);
    // Preserve the click's user activation when the next step was preloaded.
    if (entry?.player && !entry.failed) start(entry.player);
    else
      void this.prepare(step)
        .then(start)
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

  private preload(step: number) {
    if (step < this.deps.texts.length && !this.disposed) void this.prepare(step).catch(() => {});
  }

  private prepare(step: number): Promise<NarrationPlayer> {
    const existing = this.entries.get(step);
    if (existing)
      return existing.failed
        ? Promise.reject(new Error('Narration unavailable'))
        : existing.promise;
    const entry: Entry = {
      failed: false,
      promise: this.deps
        .prepare(step, this.deps.texts[step])
        .then((path) => {
          if (this.disposed || this.entries.get(step) !== entry)
            throw new Error('Narration cancelled');
          const player = this.deps.player(path, (event) => {
            if (event === 'error') entry.failed = true;
            if (this.disposed || this.active !== step || this.entries.get(step) !== entry) return;
            if (event === 'error') this.fallback(this.request);
            if (event === 'ended') this.stop();
            if (event === 'playing') {
              clearTimeout(this.deadline);
              this.deps.state('playing');
              this.preload(step + 1);
            }
          });
          entry.player = player;
          return player;
        })
        .catch((error) => {
          entry.failed = true;
          throw error;
        }),
    };
    this.entries.set(step, entry);
    return entry.promise;
  }

  private fallback(request: number) {
    if (this.disposed || request !== this.request) return;
    this.stop();
    const fallbackRequest = this.request;
    this.deps.state('playing');
    this.deps.speak(this.deps.texts[this.step], () => {
      if (!this.disposed && fallbackRequest === this.request) this.deps.state('idle');
    });
  }
}
