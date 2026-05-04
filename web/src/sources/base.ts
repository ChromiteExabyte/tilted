import type { BoardSample } from "../types";
import type { SampleSource, SourceId, SourceStatus } from "./types";

export abstract class BaseSampleSource extends EventTarget implements SampleSource {
  abstract readonly id: SourceId;
  abstract readonly displayName: string;

  private _status: SourceStatus = "idle";

  get status(): SourceStatus {
    return this._status;
  }

  abstract start(): Promise<void>;
  abstract stop(): void;

  protected setStatus(next: SourceStatus, message?: string): void {
    if (next === this._status) return;
    this._status = next;
    this.dispatchEvent(
      new CustomEvent("statuschange", {
        detail: message !== undefined ? { status: next, message } : { status: next },
      }),
    );
  }

  protected emitSample(sample: BoardSample): void {
    this.dispatchEvent(new CustomEvent<BoardSample>("sample", { detail: sample }));
  }

  protected emitError(message: string): void {
    this.dispatchEvent(new CustomEvent("error", { detail: { message } }));
    this.setStatus("error", message);
  }
}
