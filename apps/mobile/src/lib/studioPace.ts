import type { StudioProject } from './types';

/**
 * How long the sous-chef waits before it next looks at its conversation, in milliseconds: soon
 * while a reply is on its way or a call is live, less often while media is being made, and
 * least while nothing is happening.
 */
export function studioPollDelay(project: StudioProject | null, live: boolean): number {
  if (project?.busy) return 1200;
  if (live) return 1500;
  if (project?.assets?.some((a) => a.status !== 'completed' && a.status !== 'failed')) return 4000;
  return 6000;
}
