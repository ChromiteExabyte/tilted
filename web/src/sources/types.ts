import type { BoardSample } from "../types";

export type SourceId = "websocket" | "webhid" | "simulator";

export type SourceStatus = "idle" | "connecting" | "connected" | "disconnected" | "error";

export interface SourceStatusDetail {
  status: SourceStatus;
  message?: string;
}

export interface SampleSource extends EventTarget {
  readonly id: SourceId;
  readonly displayName: string;
  readonly status: SourceStatus;
  /** Begin emitting samples. Resolves when the source is `connected` or rejects on fatal error. */
  start(): Promise<void>;
  /** Stop emitting samples and release any underlying resources. */
  stop(): void;
}

/**
 * Type-narrowing helpers for consumers using `addEventListener`. The DOM types
 * for EventTarget are intentionally loose; these guards keep call sites tidy.
 */
export const isSampleEvent = (e: Event): e is CustomEvent<BoardSample> =>
  e.type === "sample" && "detail" in e;

export const isStatusEvent = (e: Event): e is CustomEvent<SourceStatusDetail> =>
  e.type === "statuschange" && "detail" in e;

export const isErrorEvent = (e: Event): e is CustomEvent<{ message: string }> =>
  e.type === "error" && "detail" in e;
