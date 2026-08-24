import {
    chatDeltaCoalescingMilliseconds,
    mergeChatStreamText,
} from "../../../contracts/chatModel.ts";
import type { ChatRuntimeEventDraft } from "./repository.ts";

type DeltaDraft = Extract<ChatRuntimeEventDraft, { kind: "assistant" | "thinking" }>;

export interface ChatCoalescerScheduler {
    readonly clear: (handle: unknown) => void;
    readonly schedule: (callback: () => void, delayMs: number) => unknown;
}

const defaultScheduler: ChatCoalescerScheduler = Object.freeze({
    clear(handle: unknown) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    schedule(callback: () => void, delayMs: number) {
        return setTimeout(callback, delayMs);
    },
});

function isDelta(event: ChatRuntimeEventDraft): event is DeltaDraft {
    return event.kind === "assistant" || event.kind === "thinking";
}

function canMerge(previous: DeltaDraft, next: DeltaDraft): boolean {
    if (previous.kind !== next.kind || previous.mode !== next.mode) return false;
    const previousHasRange =
        previous.providerSequenceStart !== undefined &&
        previous.providerSequenceEnd !== undefined;
    const nextHasRange =
        next.providerSequenceStart !== undefined &&
        next.providerSequenceEnd !== undefined;
    if (
        !previousHasRange &&
        previous.providerSequenceStart === undefined &&
        previous.providerSequenceEnd === undefined &&
        !nextHasRange &&
        next.providerSequenceStart === undefined &&
        next.providerSequenceEnd === undefined
    ) {
        return true;
    }
    return (
        previousHasRange &&
        nextHasRange &&
        next.providerSequenceStart === previous.providerSequenceEnd! + 1
    );
}

function assertCompleteRange(event: DeltaDraft): void {
    const hasStart = event.providerSequenceStart !== undefined;
    const hasEnd = event.providerSequenceEnd !== undefined;
    if (hasStart !== hasEnd) {
        throw new TypeError("Chat delta provider sequence range is incomplete");
    }
    if (hasStart && event.providerSequenceStart! > event.providerSequenceEnd!) {
        throw new RangeError("Chat delta provider sequence range is reversed");
    }
}

function mergeDelta(previous: DeltaDraft, next: DeltaDraft): DeltaDraft | undefined {
    if (!canMerge(previous, next)) return undefined;
    const overlapMerged = mergeChatStreamText(previous.text, next.text);
    let text = next.text;
    if (next.mode === "append") text = previous.text + next.text;
    if (next.mode === "merge") text = overlapMerged;
    if (text.length > 64 * 1024) return undefined;
    return {
        kind: next.kind,
        mode: next.mode,
        occurredAtMs: next.occurredAtMs,
        ...(previous.providerSequenceStart === undefined
            ? {}
            : { providerSequenceStart: previous.providerSequenceStart }),
        ...(next.providerSequenceEnd === undefined
            ? {}
            : { providerSequenceEnd: next.providerSequenceEnd }),
        text,
    };
}

/**
 * Serializes one run's provider lane and batches only contiguous assistant/thinking deltas.
 * Tool, item, plan, status, cancellation, and terminal boundaries flush immediately.
 */
export class ChatRuntimeEventCoalescer {
    readonly #scheduler: ChatCoalescerScheduler;
    readonly #sink: (events: readonly ChatRuntimeEventDraft[]) => Promise<void>;
    readonly #onFailure: (error: unknown) => void;
    #closed = false;
    #failure: unknown;
    #operations: Promise<void> = Promise.resolve();
    #pending: ChatRuntimeEventDraft[] = [];
    #timer: unknown;

    public constructor(
        sink: (events: readonly ChatRuntimeEventDraft[]) => Promise<void>,
        scheduler: ChatCoalescerScheduler = defaultScheduler,
        onFailure: (error: unknown) => void = () => {}
    ) {
        this.#sink = sink;
        this.#scheduler = scheduler;
        this.#onFailure = onFailure;
    }

    #latchFailure(error: unknown): void {
        if (this.#failure !== undefined) return;
        this.#failure = error;
        this.#cancelTimer();
        try {
            this.#onFailure(error);
        } catch {
            // Failure observers have no authority to replace the original lane failure.
        }
    }

    #throwIfFailed(): void {
        if (this.#failure === undefined) return;
        throw this.#failure instanceof Error
            ? this.#failure
            : new Error("Chat runtime coalescer failed", { cause: this.#failure });
    }

    #enqueue(operation: () => void | Promise<void>): Promise<void> {
        const previous = this.#operations;
        const result = (async (): Promise<void> => {
            await previous;
            this.#throwIfFailed();
            await operation();
        })();
        this.#operations = (async (): Promise<void> => {
            try {
                await result;
            } catch (error) {
                this.#latchFailure(error);
            }
        })();
        return result;
    }

    #cancelTimer(): void {
        if (this.#timer === undefined) return;
        this.#scheduler.clear(this.#timer);
        this.#timer = undefined;
    }

    #schedule(): void {
        if (this.#timer !== undefined) return;
        this.#timer = this.#scheduler.schedule(() => {
            this.#timer = undefined;
            void this.flush().catch(() => {
                // #enqueue already latched and reported the sink failure.
            });
        }, chatDeltaCoalescingMilliseconds);
    }

    async #flushNow(): Promise<void> {
        this.#cancelTimer();
        if (this.#pending.length === 0) return;
        const events = Object.freeze(this.#pending);
        this.#pending = [];
        await this.#sink(events);
    }

    public flush(): Promise<void> {
        return this.#enqueue(() => this.#flushNow());
    }

    public push(event: ChatRuntimeEventDraft): Promise<void> {
        if (this.#closed) throw new Error("Chat runtime coalescer is closed");
        return this.#enqueue(async () => {
            if (!isDelta(event)) {
                this.#pending.push(event);
                await this.#flushNow();
                return;
            }
            assertCompleteRange(event);
            const previous = this.#pending.at(-1);
            if (previous !== undefined && isDelta(previous)) {
                const merged = mergeDelta(previous, event);
                if (merged !== undefined) {
                    this.#pending[this.#pending.length - 1] = merged;
                    this.#schedule();
                    return;
                }
                await this.#flushNow();
            }
            this.#pending.push(event);
            this.#schedule();
        });
    }

    public close(): Promise<void> {
        if (this.#closed) return this.#operations;
        this.#closed = true;
        return this.#enqueue(() => this.#flushNow());
    }
}
