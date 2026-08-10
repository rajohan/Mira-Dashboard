import { describe, expect, test } from "bun:test";

import {
    terminalConcurrentSessionMaximum,
    terminalConnectionTicketTtlMs,
    terminalIdleTimeoutMs,
    terminalOutputReplayMaximumBytes,
    terminalReconnectGraceMs,
    terminalSessionMaximumDurationMs,
} from "../../contracts/terminal.ts";
import {
    createWorkerTerminalSessionBroker,
    type WorkerPtyHandle,
    type WorkerPtyRequest,
    WorkerTerminalBrokerError,
    type WorkerTerminalControlEvent,
    type WorkerTerminalRelaySink,
    type WorkerTerminalScheduler,
    type WorkerTerminalSchedulerHandle,
    type WorkerTerminalTicket,
} from "./terminalSessionBroker.ts";

const initialNowMs = 1_800_000_000_000;
const owner = Object.freeze({ authenticatorId: "auth-1", id: "user-1" });

interface Deferred<T> {
    readonly promise: Promise<T>;
    resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve(value) {
            resolvePromise?.(value);
        },
    };
}

class ManualScheduler implements WorkerTerminalScheduler {
    public nowMs = initialNowMs;
    readonly #tasks = new Set<{
        atMs: number;
        callback: () => void;
        cancelled: boolean;
    }>();

    public async advance(delayMs: number): Promise<void> {
        this.nowMs += delayMs;
        while (true) {
            const due = [...this.#tasks]
                .filter((task) => !task.cancelled && task.atMs <= this.nowMs)
                .toSorted((left, right) => left.atMs - right.atMs)[0];
            if (due === undefined) break;
            this.#tasks.delete(due);
            due.callback();
            await Promise.resolve();
            await Promise.resolve();
        }
    }

    public schedule(
        callback: () => void,
        delayMs: number
    ): WorkerTerminalSchedulerHandle {
        const task = {
            atMs: this.nowMs + delayMs,
            callback,
            cancelled: false,
        };
        this.#tasks.add(task);
        return Object.freeze({
            cancel: () => {
                task.cancelled = true;
                this.#tasks.delete(task);
            },
        });
    }
}

class FakePty implements WorkerPtyHandle {
    public readonly exit = deferred<{
        exitCode: number;
        signalCode: NodeJS.Signals | null;
    }>();
    public readonly exited = this.exit.promise;
    public readonly inputs: Uint8Array[] = [];
    public readonly request: WorkerPtyRequest;
    public readonly resizes: { columns: number; rows: number }[] = [];
    public readonly signals: string[] = [];
    public terminateCalls = 0;

    public constructor(request: WorkerPtyRequest) {
        this.request = request;
    }

    public emitOutput(data: Uint8Array): "accepted" | "backpressured" {
        return this.request.callbacks.onOutput(data);
    }

    public resize(dimensions: { columns: number; rows: number }): void {
        this.resizes.push(dimensions);
    }

    public sendSignal(signal: "SIGHUP" | "SIGINT" | "SIGTERM"): Promise<"sent"> {
        this.signals.push(signal);
        return Promise.resolve("sent");
    }

    public terminate(): Promise<{
        exitCode: number;
        signalCode: NodeJS.Signals | null;
    }> {
        this.terminateCalls += 1;
        this.exit.resolve({ exitCode: 143, signalCode: "SIGTERM" });
        return this.exited;
    }

    public writeInput(data: Uint8Array) {
        this.inputs.push(new Uint8Array(data));
        return Object.freeze({
            acceptedBytes: data.byteLength,
            status: "accepted" as const,
        });
    }
}

class FakeSink implements WorkerTerminalRelaySink {
    public readonly controls: WorkerTerminalControlEvent[] = [];
    public readonly outputs: { data: Uint8Array; sequence: number }[] = [];
    public closeCalls = 0;
    public nextOutputDisposition: "accepted" | "backpressured" | "closed" = "accepted";

    public close(): void {
        this.closeCalls += 1;
    }

    public sendControl(event: WorkerTerminalControlEvent) {
        this.controls.push(event);
        return "accepted" as const;
    }

    public sendOutput(sequence: number, data: Uint8Array) {
        this.outputs.push({ data: new Uint8Array(data), sequence });
        const disposition = this.nextOutputDisposition;
        this.nextOutputDisposition = "accepted";
        return disposition;
    }
}

function sessionId(index: number): string {
    return `019fe7a8-03fe-7000-8ea2-${index.toString(16).padStart(12, "0")}`;
}

function ticketMaterial(
    index: number,
    expiresAtMs: number,
    afterSequence = 0
): { rawToken: string; ticket: WorkerTerminalTicket } {
    const prefix = index.toString(16).padStart(32, "0");
    const validator = (index + 10).toString(16).padStart(64, "0");
    const validatorHash = new Bun.CryptoHasher("sha256")
        .update(`mira-dashboard:terminal:v1:${prefix}:${validator}`)
        .digest("hex");
    return {
        rawToken: `${prefix}.${validator}`,
        ticket: { afterSequence, expiresAtMs, prefix, validatorHash },
    };
}

function brokerHarness() {
    const scheduler = new ManualScheduler();
    const ptys: FakePty[] = [];
    const broker = createWorkerTerminalSessionBroker({
        nowMs: () => scheduler.nowMs,
        pty(request) {
            const pty = new FakePty(request);
            ptys.push(pty);
            return pty;
        },
        scheduler,
    });
    return { broker, ptys, scheduler };
}

async function captureFailure(action: () => Promise<unknown>): Promise<unknown> {
    try {
        await action();
        return null;
    } catch (error) {
        return error;
    }
}

async function reserve(
    harness: ReturnType<typeof brokerHarness>,
    options: {
        readonly index?: number;
        readonly owner?: { authenticatorId: string; id: string };
        readonly ticket?: WorkerTerminalTicket;
    } = {}
) {
    const index = options.index ?? 1;
    const sessionOwner = options.owner ?? owner;
    const material = ticketMaterial(
        index,
        harness.scheduler.nowMs + terminalConnectionTicketTtlMs
    );
    const summary = await harness.broker.reserve({
        absoluteStartingDirectory: "/home/ubuntu/projects/mira-dashboard",
        dimensions: { columns: 100, rows: 30 },
        location: { path: "/", rootId: "dashboard" },
        owner: sessionOwner,
        sessionId: sessionId(index),
        ticket: options.ticket ?? material.ticket,
    });
    return { material, owner: sessionOwner, sessionId: sessionId(index), summary };
}

describe("worker terminal session broker", () => {
    test("indexes sessions by exact owner while preserving isolation and capacity", async () => {
        const harness = brokerHarness();
        const first = await reserve(harness);
        const siblingOwner = Object.freeze({
            authenticatorId: "auth-2",
            id: owner.id,
        });
        const sibling = await reserve(harness, {
            index: 2,
            owner: siblingOwner,
        });
        expect(first.summary).toMatchObject({
            nextSequence: 1,
            replayAvailableFromSequence: 1,
            sessionId: sessionId(1),
            state: "awaiting-connection",
        });
        expect(await harness.broker.getActive(owner)).toMatchObject({
            sessionId: first.sessionId,
        });
        expect(await harness.broker.getActive(siblingOwner)).toMatchObject({
            sessionId: sibling.sessionId,
        });
        expect(
            await captureFailure(() =>
                reserve(harness, {
                    index: 3,
                    owner,
                })
            )
        ).toMatchObject({ reason: "conflict" });
        const siblingTicket = ticketMaterial(
            9,
            harness.scheduler.nowMs + terminalConnectionTicketTtlMs
        );
        expect(
            await captureFailure(() =>
                harness.broker.prepareResume({
                    owner: siblingOwner,
                    sessionId: first.sessionId,
                    ticket: siblingTicket.ticket,
                })
            )
        ).toMatchObject({ reason: "not-found" });
        expect(
            await captureFailure(() =>
                harness.broker.terminate({
                    owner: siblingOwner,
                    sessionId: first.sessionId,
                })
            )
        ).toMatchObject({ reason: "not-found" });

        for (let index = 3; index <= terminalConcurrentSessionMaximum; index += 1) {
            await reserve(harness, {
                index,
                owner: { authenticatorId: `auth-${index}`, id: `user-${index}` },
            });
        }
        expect(
            await captureFailure(() =>
                reserve(harness, {
                    index: terminalConcurrentSessionMaximum + 1,
                    owner: { authenticatorId: "auth-5", id: "user-5" },
                })
            )
        ).toMatchObject({ reason: "capacity" });
        await harness.broker.shutdown();
    });

    test("binds and consumes the raw terminal-domain token only on attach", async () => {
        const harness = brokerHarness();
        const reserved = await reserve(harness);
        const sink = new FakeSink();
        const wrong = ticketMaterial(9, harness.scheduler.nowMs + 1000);

        expect(
            await captureFailure(() =>
                harness.broker.attach({
                    owner,
                    rawToken: wrong.rawToken,
                    sessionId: reserved.sessionId,
                    sink,
                })
            )
        ).toMatchObject({ reason: "gone" });
        const attachment = await harness.broker.attach({
            owner,
            rawToken: reserved.material.rawToken,
            sessionId: reserved.sessionId,
            sink,
        });
        expect(harness.ptys).toHaveLength(1);
        expect(sink.controls[0]).toMatchObject({
            replayAvailableFromSequence: 1,
            resumed: false,
            session: { nextSequence: 1, state: "connected" },
            type: "ready",
        });
        expect(
            await captureFailure(() =>
                harness.broker.attach({
                    owner,
                    rawToken: reserved.material.rawToken,
                    sessionId: reserved.sessionId,
                    sink: new FakeSink(),
                })
            )
        ).toMatchObject({ reason: "gone" });

        expect(attachment.input(new Uint8Array([27, 91, 65]))).toEqual({
            acceptedBytes: 3,
            status: "accepted",
        });
        attachment.resize({ columns: 120, rows: 40 });
        expect(await attachment.signal("SIGINT")).toBe("sent");
        expect(harness.ptys[0]?.inputs[0]).toEqual(new Uint8Array([27, 91, 65]));
        expect(harness.ptys[0]?.resizes).toEqual([{ columns: 120, rows: 40 }]);
        expect(harness.ptys[0]?.signals).toEqual(["SIGINT"]);
        await attachment.terminate();
        expect(harness.ptys[0]?.terminateCalls).toBe(1);
    });

    test("replays sequenced raw bytes after detach without duplicates", async () => {
        const harness = brokerHarness();
        const reserved = await reserve(harness);
        const firstSink = new FakeSink();
        const firstAttachment = await harness.broker.attach({
            owner,
            rawToken: reserved.material.rawToken,
            sessionId: reserved.sessionId,
            sink: firstSink,
        });
        expect(harness.ptys[0]?.emitOutput(new Uint8Array([27, 91, 51, 49, 109]))).toBe(
            "accepted"
        );
        expect(firstSink.outputs.map(({ sequence }) => sequence)).toEqual([1]);
        firstAttachment.detach();
        harness.ptys[0]?.emitOutput(new Uint8Array([255, 0, 10]));

        const resumeMaterial = ticketMaterial(
            2,
            harness.scheduler.nowMs + terminalConnectionTicketTtlMs,
            1
        );
        await harness.broker.prepareResume({
            owner,
            sessionId: reserved.sessionId,
            ticket: resumeMaterial.ticket,
        });
        const resumedSink = new FakeSink();
        await harness.broker.attach({
            owner,
            rawToken: resumeMaterial.rawToken,
            sessionId: reserved.sessionId,
            sink: resumedSink,
        });
        expect(resumedSink.controls[0]).toMatchObject({
            replayAvailableFromSequence: 1,
            resumed: true,
            session: { nextSequence: 3 },
            type: "ready",
        });
        expect(resumedSink.outputs).toEqual([
            { data: new Uint8Array([255, 0, 10]), sequence: 2 },
        ]);
        await harness.broker.shutdown();
    });

    test("pauses delivery on accepted backpressure and resumes at the next sequence", async () => {
        const harness = brokerHarness();
        const reserved = await reserve(harness);
        const sink = new FakeSink();
        const attachment = await harness.broker.attach({
            owner,
            rawToken: reserved.material.rawToken,
            sessionId: reserved.sessionId,
            sink,
        });
        sink.nextOutputDisposition = "backpressured";
        harness.ptys[0]?.emitOutput(new Uint8Array([1]));
        harness.ptys[0]?.emitOutput(new Uint8Array([2]));
        expect(sink.outputs.map(({ sequence }) => sequence)).toEqual([1]);
        attachment.resumeOutput();
        expect(sink.outputs.map(({ sequence }) => sequence)).toEqual([1, 2]);

        attachment.detach();
        const chunk = new Uint8Array(terminalOutputReplayMaximumBytes / 8);
        for (let index = 0; index < 9; index += 1) {
            harness.ptys[0]?.emitOutput(chunk);
        }
        expect(await harness.broker.getActive(owner)).toMatchObject({
            nextSequence: 12,
            replayAvailableFromSequence: 4,
            state: "awaiting-reconnect",
        });
        const stale = ticketMaterial(
            3,
            harness.scheduler.nowMs + terminalConnectionTicketTtlMs,
            0
        );
        expect(
            await captureFailure(() =>
                harness.broker.prepareResume({
                    owner,
                    sessionId: reserved.sessionId,
                    ticket: stale.ticket,
                })
            )
        ).toMatchObject({ reason: "gone" });
        await harness.broker.shutdown();
    });

    test("expires tickets, reconnects, idle sessions, and kills all PTYs on shutdown", async () => {
        const ticketHarness = brokerHarness();
        const unused = await reserve(ticketHarness);
        await ticketHarness.scheduler.advance(terminalConnectionTicketTtlMs);
        expect(await ticketHarness.broker.getActive(unused.owner)).toBeUndefined();

        const reconnectHarness = brokerHarness();
        const reconnect = await reserve(reconnectHarness);
        const attachment = await reconnectHarness.broker.attach({
            owner,
            rawToken: reconnect.material.rawToken,
            sessionId: reconnect.sessionId,
            sink: new FakeSink(),
        });
        attachment.detach();
        await reconnectHarness.scheduler.advance(terminalReconnectGraceMs);
        expect(reconnectHarness.ptys[0]?.terminateCalls).toBe(1);
        expect(await reconnectHarness.broker.getActive(owner)).toBeUndefined();

        const idleHarness = brokerHarness();
        const idle = await reserve(idleHarness);
        const idleAttachment = await idleHarness.broker.attach({
            owner,
            rawToken: idle.material.rawToken,
            sessionId: idle.sessionId,
            sink: new FakeSink(),
        });
        await idleHarness.scheduler.advance(terminalIdleTimeoutMs - 1);
        idleAttachment.ping();
        await idleHarness.scheduler.advance(terminalIdleTimeoutMs - 1);
        expect(idleHarness.ptys[0]?.terminateCalls).toBe(0);
        await idleHarness.broker.shutdown();
        expect(idleHarness.ptys[0]?.terminateCalls).toBe(1);
        await idleAttachment.terminate();
    });

    test("enforces the hard session lifetime despite continued activity", async () => {
        const harness = brokerHarness();
        const reserved = await reserve(harness);
        const attachment = await harness.broker.attach({
            owner,
            rawToken: reserved.material.rawToken,
            sessionId: reserved.sessionId,
            sink: new FakeSink(),
        });

        const activityIntervalMs = terminalIdleTimeoutMs - 1;
        for (
            let elapsedMs = activityIntervalMs;
            elapsedMs < terminalSessionMaximumDurationMs;
            elapsedMs += activityIntervalMs
        ) {
            await harness.scheduler.advance(activityIntervalMs);
            attachment.ping();
        }
        const elapsedMs = activityIntervalMs * 3;
        await harness.scheduler.advance(terminalSessionMaximumDurationMs - elapsedMs);

        expect(harness.ptys[0]?.terminateCalls).toBe(1);
        expect(await harness.broker.getActive(owner)).toBeUndefined();
    });

    test("rejects invalid ticket budgets before any PTY starts", async () => {
        const harness = brokerHarness();
        const material = ticketMaterial(
            1,
            harness.scheduler.nowMs + terminalConnectionTicketTtlMs + 1
        );
        expect(
            await captureFailure(() => reserve(harness, { ticket: material.ticket }))
        ).toBeInstanceOf(WorkerTerminalBrokerError);
        expect(harness.ptys).toHaveLength(0);
    });
});
