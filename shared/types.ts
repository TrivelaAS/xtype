export type JobType = 'post' | 'reply' | 'repost' | 'quote';

export type JobStatus =
  | 'queued'
  | 'navigating'
  | 'reading'
  | 'typing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TypingProfile {
  /** Target average words per minute (1 word = 5 chars). Default: 68 */
  wpmMean: number;
  /** Standard deviation of WPM across keystrokes. Default: 14 */
  wpmStdDev: number;
  /** Probability [0..1] of an adjacent-key typo followed by Backspace recovery. Default: 0.02 */
  typoRate: number;
  /** [min, max] milliseconds spent "reading" a target tweet before acting. Default: [1200, 3000] */
  readingDelayMs: [number, number];
}

export const DEFAULT_TYPING_PROFILE: TypingProfile = {
  wpmMean: 68,
  wpmStdDev: 14,
  typoRate: 0.02,
  readingDelayMs: [1200, 3000],
};

export interface Job {
  id: string;
  type: JobType;
  text: string;
  targetUrl?: string;
  autoSubmit: boolean;
  profile: TypingProfile;
  status: JobStatus;
  /** Typing completion [0..100] */
  progress: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateJobInput {
  type: JobType;
  text?: string;
  targetUrl?: string;
  autoSubmit?: boolean;
  profile?: Partial<TypingProfile>;
}

export interface ExtensionStateSnapshot {
  connected: boolean;
  boundWindowId: number | null;
  boundTabId: number | null;
  activeJobId: string | null;
  lastHeartbeatAt: string | null;
}

export type WsServerMessage =
  | { type: 'welcome'; serverTime: string }
  | { type: 'job:dispatch'; job: Job }
  | { type: 'job:cancel'; jobId: string }
  | { type: 'ping' };

export type WsExtensionMessage =
  | { type: 'hello'; boundWindowId: number | null; boundTabId: number | null }
  | { type: 'pong'; boundWindowId: number | null; boundTabId: number | null }
  | {
      type: 'job:status';
      jobId: string;
      status: JobStatus;
      progress?: number;
      error?: string;
    }
  | { type: 'window:bound'; windowId: number | null; tabId: number | null };
