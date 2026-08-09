import * as v from "valibot";

import {
    opaqueTokenSchema,
    type AuthenticatedPrincipal,
} from "../../contracts/security.ts";
import {
    terminalBinaryOutputHeaderBytes,
    terminalBinaryOutputKind,
    terminalClientMessageMaximumBytes,
    terminalClientMessageSchema,
    terminalServerMessageMaximumBytes,
    terminalServerMessageSchema,
    terminalSessionIdSchema,
    terminalSocketBufferedMaximumBytes,
    terminalWebSocketProtocol,
    type TerminalServerMessage,
} from "../../contracts/terminal.ts";
import type { AuthenticationLifecycleService } from "../domains/security/authenticationLifecycle.ts";
import {
    type AuthenticationLease,
    parseAuthenticationResolution,
} from "../domains/security/authenticationResolution.ts";
import {
    TerminalSessionBrokerError,
    type TerminalSessionOwner,
} from "../domains/terminal/brokerPort.ts";
import type {
    InteractiveTerminalBrokerClient,
    TerminalBrokerRelay,
    TerminalBrokerRelayCallbacks,
    TerminalBrokerRelayControl,
} from "../platform/terminal/terminalBrokerClient.ts";
import type { AuthenticateCredential } from "../trpc/context.ts";
import { readAuthenticationHttpCredentials } from "./authenticationCredentials.ts";
import { parseBrowserOrigin } from "./requestSecurity.ts";
import { appendClearedDashboardSessionCookie } from "./sessionCookie.ts";

const terminalSocketPathPattern = /^\/api\/terminal\/sessions\/([0-9a-f-]{36})\/socket$/u;
const terminalWebSocketKeyPattern = /^[A-Za-z0-9+/]{22}==$/u;
const terminalAuthenticationCheckMaximumIntervalMs = 30_000;
const terminalAuthenticationRevalidationTimeoutMs = 5000;
const terminalSocketIdleTimeoutSeconds = 60;
const terminalPendingInputMaximumFrames =
    terminalSocketBufferedMaximumBytes / terminalClientMessageMaximumBytes;
type HttpHeadersInit = ConstructorParameters<typeof Headers>[0];

interface TerminalSocketServerWebSocket {
    readonly data: TerminalSocketConnection;
    close(code?: number, reason?: string): void;
    sendBinary(data: Uint8Array, compress?: boolean): number;
    sendText(data: string, compress?: boolean): number;
}

/** Structural Bun WebSocket handler shape without importing runtime authority. */
export interface TerminalSocketWebSocketHandler {
    readonly backpressureLimit: number;
    readonly closeOnBackpressureLimit: boolean;
    readonly idleTimeout: number;
    readonly maxPayloadLength: number;
    readonly perMessageDeflate: false;
    readonly sendPings: true;
    close(socket: TerminalSocketServerWebSocket, code: number): void;
    drain(socket: TerminalSocketServerWebSocket): void;
    message(socket: TerminalSocketServerWebSocket, message: string | Uint8Array): void;
    open(socket: TerminalSocketServerWebSocket): void;
}

interface TerminalSocketTimer {
    cancel(): void;
}

interface TerminalSocketScheduler {
    schedule(callback: () => void, delayMs: number): TerminalSocketTimer;
}

interface TerminalSocketPeer {
    close(code?: number, reason?: string): void;
    sendBinary(data: Uint8Array): number;
    sendText(data: string): number;
}

interface PendingTerminalSocketMessage {
    readonly bytes: number;
    readonly data: string | Uint8Array;
    readonly kind: "binary" | "text";
}

interface ActiveTerminalAuthentication {
    readonly lease: AuthenticationLease;
    readonly principal: AuthenticatedPrincipal & { readonly kind: "session" };
}

interface TerminalSocketConnectionOptions extends ActiveTerminalAuthentication {
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly nowMs: () => number;
    readonly onFinalized: (connection: TerminalSocketConnection) => void;
    readonly scheduler: TerminalSocketScheduler;
    readonly sessionId: string;
}

/** Upgrade adapter implemented by Bun.Server and replaced by a narrow test fake. */
export interface TerminalSocketUpgradeServer {
    upgrade(
        request: Request,
        options: {
            readonly data: TerminalSocketConnection;
            readonly headers: HttpHeadersInit;
        }
    ): boolean;
}

/** Terminal raw-handler composition dependencies. */
export interface TerminalSocketBoundaryOptions {
    readonly authenticateCredential: AuthenticateCredential;
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly broker: InteractiveTerminalBrokerClient;
    readonly browserOrigin?: string;
    readonly nowMs?: () => number;
    readonly scheduler?: TerminalSocketScheduler;
}

export type TerminalSocketRequestResult =
    | { readonly kind: "not-matched" }
    | { readonly kind: "response"; readonly response: Response }
    | { readonly kind: "upgraded" };

/** Complete HTTP-upgrade, WebSocket-event, and shutdown boundary. */
export interface TerminalSocketBoundary {
    readonly websocket: TerminalSocketWebSocketHandler;
    handle(
        request: Request,
        requestUrl: URL,
        server: TerminalSocketUpgradeServer
    ): Promise<TerminalSocketRequestResult>;
    shutdown(): void;
}

function defaultScheduler(): TerminalSocketScheduler {
    const scheduler: TerminalSocketScheduler = {
        schedule(callback: () => void, delayMs: number) {
            const timer = setTimeout(callback, delayMs);
            return Object.freeze({ cancel: () => clearTimeout(timer) });
        },
    };
    return Object.freeze(scheduler);
}

function noStoreResponse(
    body: string,
    status: number,
    headers?: HttpHeadersInit
): Response {
    const responseHeaders = new Headers(headers);
    responseHeaders.set("cache-control", "no-store");
    responseHeaders.set("content-type", "text/plain; charset=utf-8");
    return new Response(body, { headers: responseHeaders, status });
}

function safeNow(nowMs: () => number): number {
    const now = nowMs();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid clock");
    return now;
}

function encodedByteLength(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function authenticationAbortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error("Terminal authentication revalidation aborted", {
              cause: signal.reason,
          });
}

async function revalidateAuthenticationLease(
    lease: AuthenticationLease,
    signal: AbortSignal
): Promise<unknown> {
    if (signal.aborted) throw authenticationAbortError(signal);
    const aborted = Promise.withResolvers<never>();
    const onAbort = (): void => aborted.reject(authenticationAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
        return await Promise.race([
            Promise.resolve().then(() => lease.revalidate(signal)),
            aborted.promise,
        ]);
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

function encodeOutput(sequence: number, data: Uint8Array): Uint8Array {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new Error("Invalid terminal output sequence");
    }
    const frame = new Uint8Array(terminalBinaryOutputHeaderBytes + data.byteLength);
    frame[0] = terminalBinaryOutputKind;
    new DataView(frame.buffer).setBigUint64(1, BigInt(sequence), false);
    frame.set(data, terminalBinaryOutputHeaderBytes);
    return frame;
}

function checkedServerControl(message: TerminalServerMessage): string {
    return JSON.stringify(v.parse(terminalServerMessageSchema, message));
}

function terminalServerFrameMaximumBytes(kind: "binary" | "text"): number {
    return (
        terminalServerMessageMaximumBytes +
        (kind === "binary" ? terminalBinaryOutputHeaderBytes : 0)
    );
}

function sameSessionPrincipal(
    previous: AuthenticatedPrincipal & { readonly kind: "session" },
    next: AuthenticatedPrincipal
): next is AuthenticatedPrincipal & { readonly kind: "session" } {
    return (
        next.kind === "session" &&
        next.id === previous.id &&
        next.authenticatorId === previous.authenticatorId &&
        next.authorizationVersion >= previous.authorizationVersion &&
        next.capabilities.includes("terminal:write")
    );
}

function sessionOwner(
    principal: AuthenticatedPrincipal & { readonly kind: "session" }
): TerminalSessionOwner {
    return Object.freeze({
        authenticatorId: principal.authenticatorId,
        id: principal.id,
    });
}

function sessionIdentity(
    principal: AuthenticatedPrincipal & { readonly kind: "session" }
) {
    return Object.freeze({
        sessionId: principal.authenticatorId,
        userId: principal.id,
    });
}

function brokerResponse(error: unknown): Response {
    if (!(error instanceof TerminalSessionBrokerError)) {
        return noStoreResponse("Interactive terminal unavailable", 503);
    }
    switch (error.reason) {
        case "capacity": {
            return noStoreResponse("Interactive terminal capacity exhausted", 429, {
                "retry-after": "5",
            });
        }
        case "conflict": {
            return noStoreResponse("Interactive terminal state changed", 409);
        }
        case "gone": {
            return noStoreResponse("Terminal connection ticket expired", 410);
        }
        case "not-found": {
            return noStoreResponse("Terminal session not found", 404);
        }
        case "unavailable": {
            return noStoreResponse("Interactive terminal unavailable", 503);
        }
    }
}

function hasUpgradeHeaders(request: Request): boolean {
    const connectionTokens = (request.headers.get("connection") ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase());
    const key = request.headers.get("sec-websocket-key") ?? "";
    return (
        connectionTokens.includes("upgrade") &&
        request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
        request.headers.get("sec-websocket-version") === "13" &&
        terminalWebSocketKeyPattern.test(key)
    );
}

function connectionToken(request: Request): string | undefined {
    const value = request.headers.get("sec-websocket-protocol");
    if (value === null || value.length > 256) return;
    const protocols = value.split(",").map((protocol) => protocol.trim());
    const token = v.safeParse(opaqueTokenSchema, protocols[1], {
        abortEarly: true,
    });
    if (
        protocols.length !== 2 ||
        protocols[0] !== terminalWebSocketProtocol ||
        !token.success
    ) {
        return;
    }
    return token.output;
}

function hasExactBrowserOrigin(
    request: Request,
    requestUrl: URL,
    browserOrigin?: string
): boolean {
    const expectedOrigin = browserOrigin ?? requestUrl.origin;
    const fetchSite = request.headers.get("sec-fetch-site");
    return (
        request.headers.get("origin") === expectedOrigin &&
        (fetchSite === null || fetchSite === "same-origin")
    );
}

function peerFor(socket: TerminalSocketServerWebSocket): TerminalSocketPeer {
    const peer: TerminalSocketPeer = {
        close: (code?: number, reason?: string) => socket.close(code, reason),
        sendBinary: (data: Uint8Array) => socket.sendBinary(data, false),
        sendText: (data: string) => socket.sendText(data, false),
    };
    return Object.freeze(peer);
}

/**
 * Per-upgrade PTY relay state. It retains no terminal content after delivery.
 * Exported only so Bun can type its ServerWebSocket data slot.
 */
export class TerminalSocketConnection {
    readonly callbacks: TerminalBrokerRelayCallbacks;
    readonly #authenticationLifecycle: AuthenticationLifecycleService;
    #activeAuthentication: ActiveTerminalAuthentication;
    #authenticationTimer?: TerminalSocketTimer;
    readonly #authenticationController = new AbortController();
    #finalized = false;
    #inputBackpressured = false;
    readonly #nowMs: () => number;
    readonly #onFinalized: (connection: TerminalSocketConnection) => void;
    #outputBackpressured = false;
    #peer?: TerminalSocketPeer;
    #pending: PendingTerminalSocketMessage[] = [];
    #pendingBytes = 0;
    #pendingInput: Uint8Array[] = [];
    #pendingInputBytes = 0;
    #relay?: TerminalBrokerRelay;
    readonly #scheduler: TerminalSocketScheduler;
    readonly #sessionId: string;

    constructor(options: TerminalSocketConnectionOptions) {
        this.#activeAuthentication = Object.freeze({
            lease: options.lease,
            principal: options.principal,
        });
        this.#authenticationLifecycle = options.authenticationLifecycle;
        this.#nowMs = options.nowMs;
        this.#onFinalized = options.onFinalized;
        this.#scheduler = options.scheduler;
        this.#sessionId = options.sessionId;
        const callbacks: TerminalBrokerRelayCallbacks = {
            onClose: () => this.#brokerClosed(),
            onControl: (event: TerminalBrokerRelayControl) => this.#brokerControl(event),
            onInputDrain: () => this.#inputDrained(),
            onOutput: (sequence: number, data: Uint8Array) =>
                this.#brokerOutput(sequence, data),
        };
        this.callbacks = Object.freeze(callbacks);
    }

    get finalized(): boolean {
        return this.#finalized;
    }

    bindRelay(relay: TerminalBrokerRelay): void {
        if (this.#relay !== undefined) throw new Error("Terminal relay already bound");
        if (this.#finalized) {
            relay.terminate();
            return;
        }
        this.#relay = relay;
    }

    open(peer: TerminalSocketPeer): void {
        if (this.#peer !== undefined || this.#finalized) {
            peer.close(1011, "Terminal unavailable");
            return;
        }
        this.#peer = peer;
        this.#flushPending();
        if (!this.#outputBackpressured && this.#pending.length === 0) {
            this.#relay?.resumeOutput();
        }
        this.#scheduleAuthenticationCheck();
    }

    message(message: string | Uint8Array): void {
        if (this.#finalized) return;
        if (typeof message !== "string") {
            if (
                message.byteLength === 0 ||
                message.byteLength > terminalClientMessageMaximumBytes
            ) {
                this.#policyClose(1009, "Terminal input exceeded its budget");
                return;
            }
            const input = new Uint8Array(message);
            if (this.#inputBackpressured) {
                if (
                    this.#pendingInput.length >= terminalPendingInputMaximumFrames ||
                    this.#pendingInputBytes + input.byteLength >
                        terminalSocketBufferedMaximumBytes
                ) {
                    this.#policyClose(1009, "Terminal input exceeded its budget");
                    return;
                }
                this.#pendingInput.push(input);
                this.#pendingInputBytes += input.byteLength;
            } else {
                this.#sendInput(input);
            }
            return;
        }
        if (encodedByteLength(message) > terminalClientMessageMaximumBytes) {
            this.#policyClose(1009, "Terminal control exceeded its budget");
            return;
        }
        let parsedJson: unknown;
        try {
            parsedJson = JSON.parse(message);
        } catch {
            this.#policyClose(1002, "Invalid terminal control message");
            return;
        }
        const parsed = v.safeParse(terminalClientMessageSchema, parsedJson, {
            abortEarly: true,
        });
        if (!parsed.success) {
            this.#policyClose(1002, "Invalid terminal control message");
            return;
        }
        switch (parsed.output.type) {
            case "close": {
                this.#operatorClose();
                return;
            }
            case "ping": {
                const disposition = this.#relay?.ping() ?? "closed";
                if (disposition === "closed") this.#unavailableClose();
                else
                    this.#sendControl({
                        nonce: parsed.output.nonce,
                        type: "pong",
                    });
                return;
            }
            case "resize": {
                if (this.#relay?.resize(parsed.output.dimensions) === "closed") {
                    this.#unavailableClose();
                }
                return;
            }
            case "signal": {
                if (this.#relay?.signal(parsed.output.signal) === "closed") {
                    this.#unavailableClose();
                }
            }
        }
    }

    drain(): void {
        if (this.#finalized) return;
        this.#outputBackpressured = false;
        this.#flushPending();
        if (!this.#outputBackpressured && this.#pending.length === 0) {
            this.#relay?.resumeOutput();
        }
    }

    networkClosed(): void {
        if (this.#finalized) return;
        this.#finalized = true;
        this.#cancelAuthenticationCheck();
        this.#clearPending();
        this.#relay?.detach();
        this.#relay = undefined;
        this.#onFinalized(this);
    }

    transportClosed(code: number): void {
        if (code !== 1002 && code !== 1008 && code !== 1009) {
            this.networkClosed();
            return;
        }
        if (this.#finalized) return;
        this.#finalized = true;
        this.#cancelAuthenticationCheck();
        this.#clearPending();
        this.#relay?.terminate();
        this.#relay = undefined;
        this.#onFinalized(this);
    }

    shutdown(): void {
        if (this.#finalized) return;
        this.#finalized = true;
        this.#cancelAuthenticationCheck();
        this.#clearPending();
        this.#relay?.terminate();
        this.#relay = undefined;
        this.#peer?.close(1012, "Server restarting");
        this.#onFinalized(this);
    }

    #inputDrained(): void {
        if (this.#finalized) return;
        this.#inputBackpressured = false;
        while (
            !this.#finalized &&
            !this.#inputBackpressured &&
            this.#pendingInput.length > 0
        ) {
            const input = this.#pendingInput.shift();
            if (input === undefined) return;
            this.#pendingInputBytes -= input.byteLength;
            this.#sendInput(input);
        }
    }

    #sendInput(input: Uint8Array): void {
        let disposition: "accepted" | "backpressured" | "closed";
        try {
            disposition = this.#relay?.input(input) ?? "closed";
        } catch {
            disposition = "closed";
        }
        if (disposition === "closed") {
            this.#unavailableClose();
        } else if (disposition === "backpressured") {
            // The relay accepted this whole framed write into its bounded IPC buffer.
            this.#inputBackpressured = true;
        }
    }

    #brokerClosed(): void {
        if (this.#finalized) return;
        this.#finalized = true;
        this.#cancelAuthenticationCheck();
        this.#clearPending();
        this.#relay = undefined;
        this.#peer?.close(1011, "Terminal unavailable");
        this.#onFinalized(this);
    }

    #brokerControl(event: TerminalBrokerRelayControl): void {
        if (this.#finalized || event.type === "input-drain") return;
        if (event.type === "ready") {
            if (event.session.sessionId !== this.#sessionId) {
                this.#unavailableClose();
                return;
            }
            this.#sendControl({
                replayAvailableFromSequence: event.replayAvailableFromSequence,
                resumed: event.resumed,
                session: event.session,
                type: "ready",
            });
            return;
        }
        if (event.type === "input-status") {
            this.#inputBackpressured = event.status === "backpressured";
            if (event.status === "closed") this.#unavailableClose();
            return;
        }
        if (event.type === "exit") {
            this.#sendControl({
                endedAtMs: safeNow(this.#nowMs),
                exitCode: event.exitCode,
                reason: event.reason,
                sessionId: this.#sessionId,
                ...(event.signalCode === null ? {} : { signal: event.signalCode }),
                type: "exit",
            });
            this.#finalizeWithoutRelayTermination(1000, "Terminal ended");
            return;
        }
        this.#sendControl({
            code: event.reason === "backpressure" ? "capacity" : "session-ended",
            message: "Terminal session ended",
            type: "error",
        });
        this.#finalizeWithoutRelayTermination(1000, "Terminal ended");
    }

    #brokerOutput(sequence: number, data: Uint8Array): "accepted" | "backpressured" {
        if (this.#finalized) return "backpressured";
        let frame: Uint8Array;
        try {
            frame = encodeOutput(sequence, data);
        } catch {
            this.#unavailableClose();
            return "backpressured";
        }
        const disposition = this.#send({
            bytes: frame.byteLength,
            data: frame,
            kind: "binary",
        });
        return disposition;
    }

    #sendControl(message: TerminalServerMessage): void {
        let data: string;
        try {
            data = checkedServerControl(message);
        } catch {
            this.#unavailableClose();
            return;
        }
        this.#send({ bytes: encodedByteLength(data), data, kind: "text" });
    }

    #send(message: PendingTerminalSocketMessage): "accepted" | "backpressured" {
        if (message.bytes > terminalServerFrameMaximumBytes(message.kind)) {
            this.#unavailableClose();
            return "backpressured";
        }
        if (this.#peer === undefined || this.#pending.length > 0) {
            if (this.#pendingBytes + message.bytes > terminalSocketBufferedMaximumBytes) {
                this.#unavailableClose();
                return "backpressured";
            }
            this.#pending.push(message);
            this.#pendingBytes += message.bytes;
            return "accepted";
        }
        const status =
            message.kind === "binary"
                ? this.#peer.sendBinary(message.data as Uint8Array)
                : this.#peer.sendText(message.data as string);
        if (status === 0) {
            this.#unavailableClose();
            return "backpressured";
        }
        if (status < 0) {
            this.#outputBackpressured = true;
            return "backpressured";
        }
        return "accepted";
    }

    #flushPending(): void {
        const peer = this.#peer;
        if (peer === undefined || this.#outputBackpressured) return;
        while (this.#pending.length > 0) {
            const message = this.#pending.shift();
            if (message === undefined) return;
            this.#pendingBytes -= message.bytes;
            const status =
                message.kind === "binary"
                    ? peer.sendBinary(message.data as Uint8Array)
                    : peer.sendText(message.data as string);
            if (status === 0) {
                this.#unavailableClose();
                return;
            }
            if (status < 0) {
                this.#outputBackpressured = true;
                return;
            }
        }
    }

    #clearPending(): void {
        this.#pending = [];
        this.#pendingBytes = 0;
        this.#pendingInput = [];
        this.#pendingInputBytes = 0;
        this.#inputBackpressured = false;
    }

    #operatorClose(): void {
        if (this.#finalized) return;
        this.#finalized = true;
        this.#cancelAuthenticationCheck();
        this.#clearPending();
        this.#relay?.terminate();
        this.#relay = undefined;
        this.#peer?.close(1000, "Terminal ended by operator");
        this.#onFinalized(this);
    }

    #policyClose(code: number, reason: string): void {
        if (this.#finalized) return;
        this.#finalized = true;
        this.#cancelAuthenticationCheck();
        this.#clearPending();
        this.#relay?.terminate();
        this.#relay = undefined;
        this.#peer?.close(code, reason);
        this.#onFinalized(this);
    }

    #unavailableClose(): void {
        this.#policyClose(1011, "Terminal unavailable");
    }

    #finalizeWithoutRelayTermination(code: number, reason: string): void {
        if (this.#finalized) return;
        this.#finalized = true;
        this.#cancelAuthenticationCheck();
        this.#relay = undefined;
        this.#clearPending();
        this.#peer?.close(code, reason);
        this.#onFinalized(this);
    }

    #cancelAuthenticationCheck(): void {
        this.#authenticationTimer?.cancel();
        this.#authenticationTimer = undefined;
        this.#authenticationController.abort();
    }

    #scheduleAuthenticationCheck(): void {
        if (this.#finalized) return;
        let delayMs: number;
        try {
            delayMs = Math.max(
                1,
                Math.min(
                    terminalAuthenticationCheckMaximumIntervalMs,
                    this.#activeAuthentication.lease.expiresAtMs - safeNow(this.#nowMs)
                )
            );
        } catch {
            this.#authenticationLost();
            return;
        }
        this.#authenticationTimer = this.#scheduler.schedule(() => {
            this.#authenticationTimer = undefined;
            void this.#revalidateAuthentication();
        }, delayMs);
    }

    async #revalidateAuthentication(): Promise<void> {
        if (this.#finalized) return;
        const timeout = AbortSignal.timeout(terminalAuthenticationRevalidationTimeoutMs);
        const signal = AbortSignal.any([this.#authenticationController.signal, timeout]);
        try {
            const resolution = parseAuthenticationResolution(
                await revalidateAuthenticationLease(
                    this.#activeAuthentication.lease,
                    signal
                )
            );
            if (
                signal.aborted ||
                resolution.authentication.kind !== "authenticated" ||
                resolution.lease === undefined ||
                !sameSessionPrincipal(
                    this.#activeAuthentication.principal,
                    resolution.authentication.principal
                ) ||
                this.#authenticationLifecycle.authorizeRecentMfa(
                    sessionIdentity(resolution.authentication.principal)
                ) !== "authorized"
            ) {
                this.#authenticationLost();
                return;
            }
            this.#activeAuthentication = Object.freeze({
                lease: resolution.lease,
                principal: resolution.authentication.principal,
            });
            this.#scheduleAuthenticationCheck();
        } catch {
            this.#authenticationLost();
        }
    }

    #authenticationLost(): void {
        this.#policyClose(1008, "Terminal authentication expired");
    }
}

interface AuthorizedTerminalSocket {
    readonly lease: AuthenticationLease;
    readonly principal: AuthenticatedPrincipal & { readonly kind: "session" };
}

async function authorizeTerminalSocket(
    request: Request,
    options: TerminalSocketBoundaryOptions
): Promise<AuthorizedTerminalSocket | Response> {
    const credentials = readAuthenticationHttpCredentials(request);
    if (credentials.isAmbiguous || credentials.authentication.kind !== "session") {
        return noStoreResponse("Unauthorized", 401);
    }
    const resolution = parseAuthenticationResolution(
        await options.authenticateCredential(credentials.authentication)
    );
    if (
        resolution.authentication.kind !== "authenticated" ||
        resolution.lease === undefined
    ) {
        return noStoreResponse("Unauthorized", 401);
    }
    const principal = resolution.authentication.principal;
    if (
        principal.kind !== "session" ||
        !principal.capabilities.includes("terminal:write")
    ) {
        return noStoreResponse("Forbidden", 403);
    }
    const recentMfa = options.authenticationLifecycle.authorizeRecentMfa(
        sessionIdentity(principal)
    );
    if (recentMfa === "session-changed") {
        const headers = new Headers();
        appendClearedDashboardSessionCookie(headers);
        return noStoreResponse("Unauthorized", 401, headers);
    }
    if (recentMfa !== "authorized") {
        return noStoreResponse("Recent multi-factor authentication is required", 403);
    }
    return Object.freeze({ lease: resolution.lease, principal });
}

/**
 * Creates the browser-session-only WebSocket boundary for worker-owned PTYs.
 * @param options Authentication, broker, origin, clock, and scheduler dependencies.
 * @returns Raw upgrade handler, Bun WebSocket handler, and shutdown hook.
 */
export function createTerminalSocketBoundary(
    options: TerminalSocketBoundaryOptions
): TerminalSocketBoundary {
    const browserOrigin =
        options.browserOrigin === undefined
            ? undefined
            : parseBrowserOrigin(options.browserOrigin);
    const nowMs = options.nowMs ?? Date.now;
    const scheduler = options.scheduler ?? defaultScheduler();
    const connections = new Set<TerminalSocketConnection>();
    let shuttingDown = false;

    const websocketDefinition: TerminalSocketWebSocketHandler = {
        backpressureLimit: terminalSocketBufferedMaximumBytes,
        closeOnBackpressureLimit: true,
        close(socket: TerminalSocketServerWebSocket, code: number) {
            socket.data.transportClosed(code);
        },
        drain(socket: TerminalSocketServerWebSocket) {
            socket.data.drain();
        },
        idleTimeout: terminalSocketIdleTimeoutSeconds,
        maxPayloadLength: terminalClientMessageMaximumBytes,
        message(socket: TerminalSocketServerWebSocket, message: string | Uint8Array) {
            const frame =
                typeof message === "string"
                    ? message
                    : new Uint8Array(
                          message.buffer,
                          message.byteOffset,
                          message.byteLength
                      );
            socket.data.message(frame);
        },
        open(socket: TerminalSocketServerWebSocket) {
            socket.data.open(peerFor(socket));
        },
        perMessageDeflate: false,
        sendPings: true,
    };
    const websocket = Object.freeze(websocketDefinition);

    const boundary: TerminalSocketBoundary = {
        async handle(
            request: Request,
            requestUrl: URL,
            server: TerminalSocketUpgradeServer
        ): Promise<TerminalSocketRequestResult> {
            const match = terminalSocketPathPattern.exec(requestUrl.pathname);
            if (match === null) return { kind: "not-matched" };
            const parsedSessionId = v.safeParse(terminalSessionIdSchema, match[1], {
                abortEarly: true,
            });
            if (!parsedSessionId.success) {
                return {
                    kind: "response",
                    response: noStoreResponse("Terminal session not found", 404),
                };
            }
            if (request.method !== "GET") {
                return {
                    kind: "response",
                    response: noStoreResponse("Method not allowed", 405, {
                        allow: "GET",
                    }),
                };
            }
            if (requestUrl.search.length > 0) {
                return {
                    kind: "response",
                    response: noStoreResponse("Invalid WebSocket upgrade", 400),
                };
            }
            if (shuttingDown || request.signal.aborted) {
                return {
                    kind: "response",
                    response: noStoreResponse("Interactive terminal unavailable", 503),
                };
            }
            if (!hasExactBrowserOrigin(request, requestUrl, browserOrigin)) {
                return {
                    kind: "response",
                    response: noStoreResponse("Forbidden", 403),
                };
            }
            const rawConnectionToken = connectionToken(request);
            if (!hasUpgradeHeaders(request) || rawConnectionToken === undefined) {
                return {
                    kind: "response",
                    response: noStoreResponse("Invalid WebSocket upgrade", 400),
                };
            }
            const authorization = await authorizeTerminalSocket(request, options);
            if (authorization instanceof Response) {
                return { kind: "response", response: authorization };
            }
            if (shuttingDown || request.signal.aborted) {
                return {
                    kind: "response",
                    response: noStoreResponse("Interactive terminal unavailable", 503),
                };
            }
            const connection = new TerminalSocketConnection({
                authenticationLifecycle: options.authenticationLifecycle,
                lease: authorization.lease,
                nowMs,
                onFinalized: (finalized) => connections.delete(finalized),
                principal: authorization.principal,
                scheduler,
                sessionId: parsedSessionId.output,
            });
            let relay: TerminalBrokerRelay;
            try {
                relay = await options.broker.attach({
                    callbacks: connection.callbacks,
                    connectionToken: rawConnectionToken,
                    owner: sessionOwner(authorization.principal),
                    sessionId: parsedSessionId.output,
                    signal: request.signal,
                });
                connection.bindRelay(relay);
            } catch (error) {
                connection.shutdown();
                return { kind: "response", response: brokerResponse(error) };
            }
            if (connection.finalized || request.signal.aborted || shuttingDown) {
                connection.shutdown();
                return {
                    kind: "response",
                    response: noStoreResponse("Interactive terminal unavailable", 503),
                };
            }
            connections.add(connection);
            let upgraded: boolean;
            try {
                upgraded = server.upgrade(request, {
                    data: connection,
                    headers: {
                        "cache-control": "no-store",
                        "sec-websocket-protocol": terminalWebSocketProtocol,
                    },
                });
            } catch {
                connections.delete(connection);
                connection.shutdown();
                return {
                    kind: "response",
                    response: noStoreResponse("Interactive terminal unavailable", 503),
                };
            }
            if (!upgraded) {
                connections.delete(connection);
                connection.shutdown();
                return {
                    kind: "response",
                    response: noStoreResponse("Invalid WebSocket upgrade", 400),
                };
            }
            return { kind: "upgraded" };
        },
        shutdown() {
            if (shuttingDown) return;
            shuttingDown = true;
            for (const connection of connections) connection.shutdown();
            connections.clear();
        },
        websocket,
    };
    return Object.freeze(boundary);
}
