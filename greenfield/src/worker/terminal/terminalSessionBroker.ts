import * as v from "valibot";

import {
    terminalConcurrentSessionMaximum,
    terminalConnectionTicketTtlMs,
    type TerminalDimensions,
    terminalDimensionsSchema,
    terminalIdleTimeoutMs,
    type TerminalLocation,
    terminalLocationSchema,
    terminalOutputReplayMaximumBytes,
    terminalReconnectGraceMs,
    terminalServerMessageMaximumBytes,
    type TerminalSessionSummary,
    terminalSessionIdSchema,
    terminalSessionMaximumDurationMs,
    terminalSessionSummarySchema,
} from "../../contracts/terminal.ts";
import { hasNoUnicodeControlOrFormat } from "../../shared/validation.ts";
import { createPtyProcess } from "./ptyProcess.ts";

const tokenPattern = /^([0-9a-f]{32})\.([0-9a-f]{64})$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;

export interface WorkerTerminalOwner {
    readonly authenticatorId: string;
    readonly id: string;
}

export interface WorkerTerminalTicket {
    readonly afterSequence: number;
    readonly expiresAtMs: number;
    readonly prefix: string;
    readonly validatorHash: string;
}

export type WorkerTerminalBrokerFailureReason =
    | "capacity"
    | "conflict"
    | "gone"
    | "not-found"
    | "unavailable";

export class WorkerTerminalBrokerError extends Error {
    public readonly reason: WorkerTerminalBrokerFailureReason;

    public constructor(reason: WorkerTerminalBrokerFailureReason) {
        super("Terminal broker operation failed");
        this.name = "WorkerTerminalBrokerError";
        this.reason = reason;
    }
}

export interface WorkerPtyInputResult {
    readonly acceptedBytes: number;
    readonly status: "accepted" | "backpressured" | "closed";
}

export interface WorkerPtyHandle {
    readonly exited: Promise<{
        readonly exitCode: number;
        readonly signalCode: NodeJS.Signals | null;
    }>;
    resize(dimensions: TerminalDimensions): void;
    sendSignal(signal: "SIGHUP" | "SIGINT" | "SIGTERM"): Promise<"closed" | "sent">;
    terminate(): Promise<{
        readonly exitCode: number;
        readonly signalCode: NodeJS.Signals | null;
    }>;
    writeInput(data: Uint8Array): WorkerPtyInputResult;
}

export interface WorkerPtyRequest {
    readonly callbacks: {
        readonly onInputDrain: () => void;
        readonly onOutput: (data: Uint8Array) => "accepted" | "backpressured";
        readonly onOutputBackpressure: () => void;
    };
    readonly dimensions: TerminalDimensions;
    readonly realpathFencedWorkingDirectory: string;
    readonly sessionId: string;
}

export type WorkerPtyFactory = (request: WorkerPtyRequest) => WorkerPtyHandle;

export interface WorkerTerminalSchedulerHandle {
    cancel(): void;
}

export interface WorkerTerminalScheduler {
    schedule(callback: () => void, delayMs: number): WorkerTerminalSchedulerHandle;
}

export type WorkerTerminalControlEvent =
    | Readonly<{
          replayAvailableFromSequence: number;
          resumed: boolean;
          session: TerminalSessionSummary;
          type: "ready";
      }>
    | Readonly<{ type: "input-drain" }>
    | Readonly<{
          exitCode: number;
          reason:
              | "disconnected"
              | "exited"
              | "idle-timeout"
              | "operator"
              | "runtime-limit";
          signalCode: NodeJS.Signals | null;
          type: "exit";
      }>
    | Readonly<{
          reason: "backpressure" | "idle-timeout" | "operator" | "runtime-limit";
          type: "closed";
      }>;

export interface WorkerTerminalRelaySink {
    close(): void;
    sendControl(
        event: WorkerTerminalControlEvent
    ): "accepted" | "backpressured" | "closed";
    sendOutput(
        sequence: number,
        data: Uint8Array
    ): "accepted" | "backpressured" | "closed";
}

export interface WorkerTerminalAttachment {
    detach(): void;
    input(data: Uint8Array): WorkerPtyInputResult;
    ping(): void;
    resize(dimensions: TerminalDimensions): void;
    resumeOutput(): void;
    signal(signal: "SIGHUP" | "SIGINT" | "SIGTERM"): Promise<"closed" | "sent">;
    terminate(): Promise<void>;
}

export interface WorkerTerminalSessionBroker {
    attach(input: {
        readonly owner: WorkerTerminalOwner;
        readonly rawToken: string;
        readonly sessionId: string;
        readonly sink: WorkerTerminalRelaySink;
    }): Promise<WorkerTerminalAttachment>;
    getActive(owner: WorkerTerminalOwner): Promise<TerminalSessionSummary | undefined>;
    prepareResume(input: {
        readonly owner: WorkerTerminalOwner;
        readonly sessionId: string;
        readonly ticket: WorkerTerminalTicket;
    }): Promise<TerminalSessionSummary>;
    reserve(input: {
        readonly absoluteStartingDirectory: string;
        readonly dimensions: TerminalDimensions;
        readonly location: TerminalLocation;
        readonly owner: WorkerTerminalOwner;
        readonly sessionId: string;
        readonly ticket: WorkerTerminalTicket;
    }): Promise<TerminalSessionSummary>;
    shutdown(): Promise<void>;
    terminate(input: {
        readonly owner: WorkerTerminalOwner;
        readonly sessionId: string;
    }): Promise<void>;
}

export interface WorkerTerminalSessionBrokerDependencies {
    readonly nowMs?: () => number;
    readonly pty?: WorkerPtyFactory;
    readonly scheduler?: WorkerTerminalScheduler;
}

interface ReplayEntry {
    readonly data: Uint8Array;
    readonly sequence: number;
}

interface AttachedRelay {
    deliverySequence: number;
    paused: boolean;
    readonly sink: WorkerTerminalRelaySink;
}

interface WorkerTerminalSession {
    attachment?: AttachedRelay;
    dimensions: TerminalDimensions;
    readonly expiresAtMs: number;
    idleExpiresAtMs: number;
    readonly location: TerminalLocation;
    nextSequence: number;
    readonly owner: WorkerTerminalOwner;
    pty?: WorkerPtyHandle;
    reconnectExpiresAtMs?: number;
    readonly replay: ReplayEntry[];
    replayBytes: number;
    readonly sessionId: string;
    readonly startedAtMs: number;
    state: "awaiting-connection" | "awaiting-reconnect" | "connected" | "starting";
    ticket?: WorkerTerminalTicket;
    timer?: WorkerTerminalSchedulerHandle;
    terminating: boolean;
    readonly workingDirectory: string;
}

function defaultScheduler(): WorkerTerminalScheduler {
    return {
        schedule(callback, delayMs) {
            const timer = setTimeout(callback, delayMs);
            return Object.freeze({ cancel: () => clearTimeout(timer) });
        },
    };
}

function checkedNow(nowMs: () => number): number {
    const now = nowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
        throw new WorkerTerminalBrokerError("unavailable");
    }
    return now;
}

function validateOwner(owner: WorkerTerminalOwner): WorkerTerminalOwner {
    for (const value of [owner.id, owner.authenticatorId]) {
        if (
            value.length === 0 ||
            value.length > 128 ||
            !hasNoUnicodeControlOrFormat(value)
        ) {
            throw new WorkerTerminalBrokerError("unavailable");
        }
    }
    return Object.freeze({ ...owner });
}

function sameOwner(left: WorkerTerminalOwner, right: WorkerTerminalOwner): boolean {
    return left.id === right.id && left.authenticatorId === right.authenticatorId;
}

function ownerIndexKey(owner: WorkerTerminalOwner): string {
    return JSON.stringify([owner.id, owner.authenticatorId]);
}

function validateTicket(
    ticket: WorkerTerminalTicket,
    now: number,
    initial: boolean
): WorkerTerminalTicket {
    if (
        !Number.isSafeInteger(ticket.afterSequence) ||
        ticket.afterSequence < 0 ||
        (initial && ticket.afterSequence !== 0) ||
        !Number.isSafeInteger(ticket.expiresAtMs) ||
        ticket.expiresAtMs <= now ||
        ticket.expiresAtMs > now + terminalConnectionTicketTtlMs ||
        !/^[0-9a-f]{32}$/u.test(ticket.prefix) ||
        !sha256Pattern.test(ticket.validatorHash)
    ) {
        throw new WorkerTerminalBrokerError("unavailable");
    }
    return Object.freeze({ ...ticket });
}

function terminalValidatorHash(prefix: string, validator: string): string {
    return new Bun.CryptoHasher("sha256")
        .update(`mira-dashboard:terminal:v1:${prefix}:${validator}`)
        .digest("hex");
}

function equalSha256(left: string, right: string): boolean {
    if (!sha256Pattern.test(left) || !sha256Pattern.test(right)) return false;
    return crypto.timingSafeEqual(Uint8Array.fromHex(left), Uint8Array.fromHex(right));
}

function verifyRawToken(rawToken: string, ticket: WorkerTerminalTicket): boolean {
    const match = tokenPattern.exec(rawToken);
    if (match === null) return false;
    const prefix = match[1];
    const validator = match[2];
    return (
        prefix !== undefined &&
        validator !== undefined &&
        prefix === ticket.prefix &&
        equalSha256(terminalValidatorHash(prefix, validator), ticket.validatorHash)
    );
}

function validateWorkingDirectory(value: string): string {
    if (
        !value.startsWith("/") ||
        value.length > 4096 ||
        !hasNoUnicodeControlOrFormat(value)
    ) {
        throw new WorkerTerminalBrokerError("unavailable");
    }
    return value;
}

function safeSummary(session: WorkerTerminalSession): TerminalSessionSummary {
    return v.parse(terminalSessionSummarySchema, {
        dimensions: session.dimensions,
        expiresAtMs: session.expiresAtMs,
        idleExpiresAtMs: session.idleExpiresAtMs,
        location: session.location,
        nextSequence: session.nextSequence,
        replayAvailableFromSequence: replayAvailableFromSequence(session),
        sessionId: session.sessionId,
        startedAtMs: session.startedAtMs,
        state: session.state,
    });
}

function minimumReplayCursor(session: WorkerTerminalSession): number {
    return (session.replay[0]?.sequence ?? session.nextSequence) - 1;
}

function replayAvailableFromSequence(session: WorkerTerminalSession): number {
    return session.replay[0]?.sequence ?? session.nextSequence;
}

function sessionDeadline(session: WorkerTerminalSession): number {
    let deadline = Math.min(session.expiresAtMs, session.idleExpiresAtMs);
    if (session.pty === undefined && session.ticket !== undefined) {
        deadline = Math.min(deadline, session.ticket.expiresAtMs);
    }
    if (session.reconnectExpiresAtMs !== undefined) {
        deadline = Math.min(deadline, session.reconnectExpiresAtMs);
    }
    return deadline;
}

function replayEntry(session: WorkerTerminalSession, data: Uint8Array): ReplayEntry {
    const entry = Object.freeze({
        data: new Uint8Array(data),
        sequence: session.nextSequence,
    });
    session.nextSequence += 1;
    session.replay.push(entry);
    session.replayBytes += entry.data.byteLength;
    while (
        session.replayBytes > terminalOutputReplayMaximumBytes &&
        session.replay.length > 0
    ) {
        const removed = session.replay.shift();
        if (removed !== undefined) session.replayBytes -= removed.data.byteLength;
    }
    return entry;
}

function closeSink(sink: WorkerTerminalRelaySink): void {
    try {
        sink.close();
    } catch {
        // Relay cleanup is best-effort; PTY termination must still proceed.
    }
}

function sendSinkControl(
    sink: WorkerTerminalRelaySink,
    event: WorkerTerminalControlEvent
): "accepted" | "backpressured" | "closed" {
    try {
        return sink.sendControl(event);
    } catch {
        return "closed";
    }
}

function sendSinkOutput(
    sink: WorkerTerminalRelaySink,
    sequence: number,
    data: Uint8Array
): "accepted" | "backpressured" | "closed" {
    try {
        return sink.sendOutput(sequence, data);
    } catch {
        return "closed";
    }
}

/**
 * Creates the worker-owned bounded interactive PTY session broker.
 * @param dependencies PTY, clock, and scheduler boundaries.
 * @returns Worker-owned lifecycle and attach broker.
 */
export function createWorkerTerminalSessionBroker(
    dependencies: WorkerTerminalSessionBrokerDependencies
): WorkerTerminalSessionBroker {
    const nowMs = dependencies.nowMs ?? Date.now;
    const createPty = dependencies.pty ?? createPtyProcess;
    const scheduler = dependencies.scheduler ?? defaultScheduler();
    const sessions = new Map<string, WorkerTerminalSession>();
    const sessionByOwner = new Map<string, string>();
    let shuttingDown = false;

    function requireSession(
        sessionId: string,
        owner: WorkerTerminalOwner
    ): WorkerTerminalSession {
        const session = sessions.get(sessionId);
        if (session === undefined || !sameOwner(session.owner, owner)) {
            throw new WorkerTerminalBrokerError("not-found");
        }
        return session;
    }

    function removeSession(session: WorkerTerminalSession): void {
        session.timer?.cancel();
        session.timer = undefined;
        if (session.attachment !== undefined) closeSink(session.attachment.sink);
        session.attachment = undefined;
        sessions.delete(session.sessionId);
        const ownerKey = ownerIndexKey(session.owner);
        if (sessionByOwner.get(ownerKey) === session.sessionId) {
            sessionByOwner.delete(ownerKey);
        }
    }

    async function terminateSession(
        session: WorkerTerminalSession,
        reason: "backpressure" | "idle-timeout" | "operator" | "runtime-limit"
    ): Promise<void> {
        if (session.terminating) {
            if (session.pty !== undefined) await session.pty.exited;
            return;
        }
        session.terminating = true;
        session.timer?.cancel();
        session.timer = undefined;
        const attachedSink = session.attachment?.sink;
        session.attachment = undefined;
        const pty = session.pty;
        if (pty === undefined) {
            if (attachedSink !== undefined) {
                sendSinkControl(attachedSink, { reason, type: "closed" });
                closeSink(attachedSink);
            }
            removeSession(session);
            return;
        }
        try {
            const result = await pty.terminate();
            if (attachedSink !== undefined) {
                sendSinkControl(attachedSink, {
                    exitCode: result.exitCode,
                    reason: reason === "backpressure" ? "disconnected" : reason,
                    signalCode: result.signalCode,
                    type: "exit",
                });
                closeSink(attachedSink);
            }
        } finally {
            removeSession(session);
        }
    }

    function scheduleSession(session: WorkerTerminalSession): void {
        session.timer?.cancel();
        const delayMs = Math.max(0, sessionDeadline(session) - checkedNow(nowMs));
        session.timer = scheduler.schedule(() => {
            const current = sessions.get(session.sessionId);
            if (current !== session || session.terminating) return;
            const now = checkedNow(nowMs);
            if (sessionDeadline(session) <= now) {
                const reason =
                    session.expiresAtMs <= now ? "runtime-limit" : "idle-timeout";
                void terminateSession(session, reason).catch(() => {});
                return;
            }
            scheduleSession(session);
        }, delayMs);
    }

    function touch(session: WorkerTerminalSession): void {
        session.idleExpiresAtMs = checkedNow(nowMs) + terminalIdleTimeoutMs;
        scheduleSession(session);
    }

    function flushOutput(session: WorkerTerminalSession): boolean {
        const attachment = session.attachment;
        if (attachment === undefined || attachment.paused) return true;
        if (attachment.deliverySequence < minimumReplayCursor(session)) return false;
        for (const entry of session.replay) {
            if (entry.sequence <= attachment.deliverySequence) continue;
            const disposition = sendSinkOutput(
                attachment.sink,
                entry.sequence,
                new Uint8Array(entry.data)
            );
            if (disposition === "accepted") {
                attachment.deliverySequence = entry.sequence;
                continue;
            }
            if (disposition === "closed") return false;
            // A stream backpressure result has accepted this whole framed write.
            attachment.deliverySequence = entry.sequence;
            attachment.paused = true;
            return true;
        }
        return true;
    }

    function onPtyOutput(
        session: WorkerTerminalSession,
        data: Uint8Array
    ): "accepted" | "backpressured" {
        if (data.byteLength === 0) return "accepted";
        if (data.byteLength > terminalServerMessageMaximumBytes) {
            void terminateSession(session, "backpressure").catch(() => {});
            return "backpressured";
        }
        replayEntry(session, data);
        if (!flushOutput(session)) {
            void terminateSession(session, "backpressure").catch(() => {});
            return "backpressured";
        }
        const attachment = session.attachment;
        if (
            attachment !== undefined &&
            attachment.paused &&
            attachment.deliverySequence < minimumReplayCursor(session)
        ) {
            void terminateSession(session, "backpressure").catch(() => {});
            return "backpressured";
        }
        return "accepted";
    }

    function startPty(session: WorkerTerminalSession): void {
        if (session.pty !== undefined) return;
        session.state = "starting";
        try {
            session.pty = createPty({
                callbacks: {
                    onInputDrain() {
                        if (session.attachment !== undefined) {
                            sendSinkControl(session.attachment.sink, {
                                type: "input-drain",
                            });
                        }
                    },
                    onOutput: (data) => onPtyOutput(session, data),
                    onOutputBackpressure() {
                        void terminateSession(session, "backpressure").catch(() => {});
                    },
                },
                dimensions: session.dimensions,
                realpathFencedWorkingDirectory: session.workingDirectory,
                sessionId: session.sessionId,
            });
        } catch {
            removeSession(session);
            throw new WorkerTerminalBrokerError("unavailable");
        }
        void session.pty.exited.then(
            (result) => {
                if (sessions.get(session.sessionId) !== session) return false;
                if (session.attachment !== undefined) {
                    sendSinkControl(session.attachment.sink, {
                        exitCode: result.exitCode,
                        reason: "exited",
                        signalCode: result.signalCode,
                        type: "exit",
                    });
                }
                removeSession(session);
                return true;
            },
            () => {
                if (sessions.get(session.sessionId) === session) removeSession(session);
                return false;
            }
        );
    }

    const broker: WorkerTerminalSessionBroker = {
        async attach(input) {
            await Promise.resolve();
            if (shuttingDown) throw new WorkerTerminalBrokerError("unavailable");
            const owner = validateOwner(input.owner);
            const session = requireSession(input.sessionId, owner);
            const now = checkedNow(nowMs);
            const ticket = session.ticket;
            if (
                ticket === undefined ||
                ticket.expiresAtMs <= now ||
                (session.reconnectExpiresAtMs !== undefined &&
                    session.reconnectExpiresAtMs <= now) ||
                !verifyRawToken(input.rawToken, ticket)
            ) {
                throw new WorkerTerminalBrokerError("gone");
            }
            session.ticket = undefined;
            if (
                ticket.afterSequence < minimumReplayCursor(session) ||
                ticket.afterSequence >= session.nextSequence
            ) {
                throw new WorkerTerminalBrokerError("gone");
            }
            if (session.attachment !== undefined) {
                throw new WorkerTerminalBrokerError("conflict");
            }
            const resumed = session.pty !== undefined;
            session.reconnectExpiresAtMs = undefined;
            session.attachment = {
                deliverySequence: ticket.afterSequence,
                paused: false,
                sink: input.sink,
            };
            startPty(session);
            session.state = "connected";
            touch(session);
            const readyDisposition = sendSinkControl(input.sink, {
                replayAvailableFromSequence: replayAvailableFromSequence(session),
                resumed,
                session: safeSummary(session),
                type: "ready",
            });
            if (
                readyDisposition === "backpressured" &&
                session.attachment !== undefined
            ) {
                session.attachment.paused = true;
            }
            if (readyDisposition === "closed" || !flushOutput(session)) {
                void terminateSession(session, "backpressure").catch(() => {});
                throw new WorkerTerminalBrokerError("unavailable");
            }

            let detached = false;
            const attachment: WorkerTerminalAttachment = {
                detach() {
                    if (detached || sessions.get(session.sessionId) !== session) return;
                    detached = true;
                    closeSink(input.sink);
                    if (session.attachment?.sink === input.sink) {
                        session.attachment = undefined;
                        session.state = "awaiting-reconnect";
                        session.reconnectExpiresAtMs =
                            checkedNow(nowMs) + terminalReconnectGraceMs;
                        scheduleSession(session);
                    }
                },
                input(data) {
                    if (detached || session.pty === undefined) {
                        return Object.freeze({ acceptedBytes: 0, status: "closed" });
                    }
                    touch(session);
                    return session.pty.writeInput(data);
                },
                ping() {
                    if (!detached) touch(session);
                },
                resize(dimensions) {
                    if (detached || session.pty === undefined) {
                        throw new WorkerTerminalBrokerError("gone");
                    }
                    session.dimensions = v.parse(terminalDimensionsSchema, dimensions);
                    touch(session);
                    session.pty.resize(session.dimensions);
                },
                resumeOutput() {
                    const current = session.attachment;
                    if (
                        detached ||
                        current === undefined ||
                        current.sink !== input.sink
                    ) {
                        return;
                    }
                    current.paused = false;
                    if (!flushOutput(session)) {
                        void terminateSession(session, "backpressure").catch(() => {});
                    }
                },
                signal(signal) {
                    if (detached || session.pty === undefined) {
                        return Promise.resolve("closed");
                    }
                    touch(session);
                    return session.pty.sendSignal(signal);
                },
                async terminate() {
                    if (detached) return;
                    detached = true;
                    await terminateSession(session, "operator");
                },
            };
            return Object.freeze(attachment);
        },
        async getActive(owner) {
            await Promise.resolve();
            if (shuttingDown) throw new WorkerTerminalBrokerError("unavailable");
            const validatedOwner = validateOwner(owner);
            const sessionId = sessionByOwner.get(ownerIndexKey(validatedOwner));
            const session = sessionId === undefined ? undefined : sessions.get(sessionId);
            return session === undefined || !sameOwner(session.owner, validatedOwner)
                ? undefined
                : safeSummary(session);
        },
        async prepareResume(input) {
            await Promise.resolve();
            if (shuttingDown) throw new WorkerTerminalBrokerError("unavailable");
            const session = requireSession(input.sessionId, validateOwner(input.owner));
            const now = checkedNow(nowMs);
            if (
                session.state !== "awaiting-reconnect" ||
                session.reconnectExpiresAtMs === undefined ||
                session.reconnectExpiresAtMs <= now
            ) {
                throw new WorkerTerminalBrokerError("gone");
            }
            const ticket = validateTicket(input.ticket, now, false);
            if (
                ticket.afterSequence < minimumReplayCursor(session) ||
                ticket.afterSequence >= session.nextSequence
            ) {
                throw new WorkerTerminalBrokerError("gone");
            }
            session.ticket = ticket;
            scheduleSession(session);
            return safeSummary(session);
        },
        async reserve(input) {
            await Promise.resolve();
            if (shuttingDown) throw new WorkerTerminalBrokerError("unavailable");
            const now = checkedNow(nowMs);
            const owner = validateOwner(input.owner);
            const ownerKey = ownerIndexKey(owner);
            if (sessionByOwner.has(ownerKey)) {
                throw new WorkerTerminalBrokerError("conflict");
            }
            if (sessions.size >= terminalConcurrentSessionMaximum) {
                throw new WorkerTerminalBrokerError("capacity");
            }
            const sessionId = v.parse(terminalSessionIdSchema, input.sessionId);
            if (sessions.has(sessionId)) throw new WorkerTerminalBrokerError("conflict");
            const dimensions = v.parse(terminalDimensionsSchema, input.dimensions);
            const location = v.parse(terminalLocationSchema, input.location);
            const session: WorkerTerminalSession = {
                dimensions,
                expiresAtMs: now + terminalSessionMaximumDurationMs,
                idleExpiresAtMs: now + terminalIdleTimeoutMs,
                location,
                nextSequence: 1,
                owner,
                replay: [],
                replayBytes: 0,
                sessionId,
                startedAtMs: now,
                state: "awaiting-connection",
                ticket: validateTicket(input.ticket, now, true),
                terminating: false,
                workingDirectory: validateWorkingDirectory(
                    input.absoluteStartingDirectory
                ),
            };
            sessions.set(sessionId, session);
            sessionByOwner.set(ownerKey, sessionId);
            scheduleSession(session);
            return safeSummary(session);
        },
        async shutdown() {
            if (shuttingDown) return;
            shuttingDown = true;
            await Promise.all(
                [...sessions.values()].map((session) =>
                    terminateSession(session, "operator").catch(() => {})
                )
            );
        },
        async terminate(input) {
            const session = requireSession(input.sessionId, validateOwner(input.owner));
            await terminateSession(session, "operator");
        },
    };
    return Object.freeze(broker);
}
