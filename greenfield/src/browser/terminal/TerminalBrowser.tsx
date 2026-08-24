import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import {
    terminalSocketBufferedMaximumBytes,
    type TerminalConnectionTicket,
    type TerminalDimensions,
    type TerminalLocation,
    type TerminalRuntime,
    type TerminalServerMessage,
    type TerminalSessionSummary,
} from "../../contracts/terminal.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { classifyDashboardBrowserFailure } from "../api/trpcError.ts";
import { authenticatedAbortSignal } from "../auth/authenticatedOperationRegistry.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import { PageState } from "../ui/PageState.tsx";
import { TerminalCanvas } from "./TerminalCanvas.tsx";
import {
    type TerminalClient,
    terminalClient as createTerminalClient,
} from "./terminalClient.ts";
import type { TerminalEmulator, TerminalEmulatorFactory } from "./terminalEmulator.ts";
import { terminalFailureMessage } from "./terminalPresentation.ts";
import {
    createTerminalSocketConnection,
    type CreateTerminalSocketConnectionOptions,
    type TerminalSocketConnection,
} from "./terminalProtocol.ts";
import { TerminalWorkspace, type TerminalWorkspacePhase } from "./TerminalWorkspace.tsx";

const terminalRuntimeQueryKey = ["terminal", "runtime"] as const;
const terminalActiveQueryKey = ["terminal", "active-session"] as const;
const defaultDimensions: TerminalDimensions = Object.freeze({
    columns: 80,
    rows: 24,
});
const reconnectInitialDelayMs = 120;
const reconnectRetryDelayMs = 250;
const reconnectSafetyMarginMs = 250;

export type TerminalSocketConnectionFactory = (
    options: CreateTerminalSocketConnectionOptions
) => TerminalSocketConnection;

export interface TerminalBrowserProps {
    readonly createEmulator?: TerminalEmulatorFactory;
    readonly createSocketConnection?: TerminalSocketConnectionFactory;
    readonly dockerContainerId?: string;
}

const terminalInputEncoder = new TextEncoder();

function dockerConsoleInput(containerId: string): Uint8Array {
    return terminalInputEncoder.encode(
        `/usr/bin/docker exec --interactive --tty ${containerId} /bin/sh\r`
    );
}

function waitForReconnectDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            reject(new DOMException("Terminal reconnect cancelled", "AbortError"));
            return;
        }
        const timeout = globalThis.setTimeout(resolve, milliseconds);
        signal.addEventListener(
            "abort",
            () => {
                globalThis.clearTimeout(timeout);
                reject(new DOMException("Terminal reconnect cancelled", "AbortError"));
            },
            { once: true }
        );
    });
}

function currentTimeMs(): number {
    return Date.now();
}

function retainedReplayCursor(session: TerminalSessionSummary): number {
    return session.replayAvailableFromSequence - 1;
}

function manualResumeSelection(
    session: TerminalSessionSummary,
    disconnectedCursor: number | undefined
): Readonly<{ cursor: number; replayGap: boolean }> {
    const replayCursor = retainedReplayCursor(session);
    const continuesDisplayedOutput =
        disconnectedCursor !== undefined &&
        disconnectedCursor >= replayCursor &&
        disconnectedCursor < session.nextSequence;
    return continuesDisplayedOutput
        ? { cursor: disconnectedCursor, replayGap: false }
        : { cursor: replayCursor, replayGap: replayCursor > 0 };
}

function connectingAnnouncement(
    phase: "connecting" | "reconnecting" | "resyncing"
): string {
    if (phase === "connecting") return "Opening interactive terminal connection.";
    if (phase === "resyncing") {
        return "Reconnecting and showing the newest available output.";
    }
    return "Reconnecting and restoring recent terminal output.";
}

function socketErrorMessage(
    code: Extract<TerminalServerMessage, { type: "error" }>["code"]
): string {
    switch (code) {
        case "capacity": {
            return "Interactive terminal capacity is currently full.";
        }
        case "invalid-message": {
            return "The terminal received data it could not use. The connection was closed.";
        }
        case "session-ended": {
            return "The terminal session has ended.";
        }
        case "unavailable": {
            return "The terminal connection is temporarily unavailable.";
        }
    }
}

/** @returns Contract-validated lifecycle queries and one non-persistent xterm stream. */
export function TerminalBrowser({
    createEmulator,
    createSocketConnection = createTerminalSocketConnection,
    dockerContainerId,
}: TerminalBrowserProps) {
    const client: TerminalClient = createTerminalClient(useDashboardTrpcClient());
    const boundary = useAuthenticatedMutationBoundary();
    const runtimeQuery = useQuery({
        queryFn: ({ signal }) => client.query("terminal.getRuntime", {}, { signal }),
        queryKey: terminalRuntimeQueryKey,
        retry: false,
        staleTime: 60_000,
    });
    const activeQuery = useQuery({
        queryFn: ({ signal }) =>
            client.query("terminal.getActiveSession", {}, { signal }),
        queryKey: terminalActiveQueryKey,
        retry: false,
        staleTime: 0,
    });
    const [actionError, setActionError] = useState<string>();
    const [announcement, setAnnouncement] = useState("Terminal is ready to start.");
    const [dimensions, setDimensions] = useState(defaultDimensions);
    const [endBusy, setEndBusy] = useState(false);
    const [inputPaused, setInputPaused] = useState(false);
    const [localPhase, setLocalPhase] = useState<TerminalWorkspacePhase>("idle");
    const [localSession, setLocalSession] = useState<TerminalSessionSummary>();
    const [replayGap, setReplayGap] = useState(false);
    const [selectedLocation, setSelectedLocation] = useState<TerminalLocation>();
    const [startBusy, setStartBusy] = useState(false);
    const [terminalReady, setTerminalReady] = useState(false);
    const emulator = useRef<TerminalEmulator | undefined>(undefined);
    const disconnectedCursorBySession = useRef(new Map<string, number>());
    const pendingDockerConsole = useRef(dockerContainerId);
    const pendingOutputBytes = useRef(0);
    const reconnectAbort = useRef<AbortController | undefined>(undefined);
    const socket = useRef<TerminalSocketConnection | undefined>(undefined);
    const socketGeneration = useRef(0);

    useEffect(() => {
        pendingDockerConsole.current = dockerContainerId;
    }, [dockerContainerId]);

    useEffect(
        () => () => {
            socketGeneration.current += 1;
            reconnectAbort.current?.abort();
            reconnectAbort.current = undefined;
            socket.current?.close();
            socket.current = undefined;
        },
        []
    );

    if (runtimeQuery.isPending && runtimeQuery.data === undefined) {
        return <PageState label="Loading terminal settings…" status="loading" />;
    }
    if (runtimeQuery.data === undefined) {
        return (
            <PageState
                message={terminalFailureMessage(runtimeQuery.error)}
                onRetry={() => void runtimeQuery.refetch()}
                retryBusy={runtimeQuery.isFetching}
                status="error"
                title="Terminal settings unavailable"
            />
        );
    }
    if (activeQuery.isPending && activeQuery.data === undefined) {
        return <PageState label="Checking active terminal session…" status="loading" />;
    }
    if (activeQuery.data === undefined) {
        return (
            <PageState
                message={terminalFailureMessage(activeQuery.error)}
                onRetry={() => void activeQuery.refetch()}
                retryBusy={activeQuery.isFetching}
                status="error"
                title="Terminal session state unavailable"
            />
        );
    }

    const runtime: TerminalRuntime = runtimeQuery.data;
    const serverSession =
        activeQuery.data.status === "active" ? activeQuery.data.session : undefined;
    const location = selectedLocation ?? runtime.defaultLocation;
    const externalSession =
        localSession === undefined &&
        localPhase !== "ended" &&
        serverSession !== undefined
            ? serverSession
            : undefined;
    let workspacePhase = localPhase;
    if (
        (localPhase === "idle" || localPhase === "error") &&
        externalSession !== undefined
    ) {
        workspacePhase = "active-elsewhere";
    } else if (
        localPhase === "ended" &&
        activeQuery.data.status === "none" &&
        !activeQuery.isFetching
    ) {
        workspacePhase = "idle";
    }
    const workspaceSession = localSession ?? externalSession;
    const inputEnabled = workspacePhase === "connected" && !inputPaused;

    function cancelReconnect(): void {
        reconnectAbort.current?.abort();
        reconnectAbort.current = undefined;
    }

    function publishSocketControl(
        message: TerminalServerMessage,
        generation: number
    ): void {
        if (generation !== socketGeneration.current) return;
        switch (message.type) {
            case "ready": {
                setLocalSession(message.session);
                setLocalPhase("connected");
                setInputPaused(false);
                setAnnouncement(
                    message.resumed
                        ? "Terminal reconnected and recent output was restored."
                        : "Interactive terminal connected."
                );
                emulator.current?.setInputEnabled(true);
                emulator.current?.focus();
                const containerId = pendingDockerConsole.current;
                if (containerId !== undefined && !message.resumed) {
                    if (socket.current?.sendInput(dockerConsoleInput(containerId))) {
                        pendingDockerConsole.current = undefined;
                        setAnnouncement(
                            `Opening an interactive shell in Docker container ${containerId.slice(0, 12)}.`
                        );
                    } else {
                        setActionError(
                            "The Docker console handoff could not be sent. The host terminal remains available."
                        );
                    }
                }
                return;
            }
            case "error": {
                setActionError(socketErrorMessage(message.code));
                setLocalPhase("error");
                setAnnouncement("Terminal connection failed.");
                emulator.current?.setInputEnabled(false);
                return;
            }
            case "exit": {
                disconnectedCursorBySession.current.delete(message.sessionId);
                setLocalSession(undefined);
                setLocalPhase("ended");
                setAnnouncement(
                    message.reason === "exited"
                        ? `Terminal process exited with code ${message.exitCode}.`
                        : "Terminal session ended."
                );
                emulator.current?.setInputEnabled(false);
                void activeQuery.refetch();
                return;
            }
            case "pong": {
                return;
            }
        }
    }

    function openSocket(
        ticket: TerminalConnectionTicket,
        phase: "connecting" | "reconnecting" | "resyncing"
    ): void {
        const terminal = emulator.current;
        const sessionId = ticket.sessionId;
        if (terminal === undefined) {
            setActionError("The terminal canvas is not ready. Try again.");
            setLocalPhase("error");
            return;
        }
        socket.current?.close();
        const generation = socketGeneration.current + 1;
        socketGeneration.current = generation;
        setLocalPhase(phase);
        setAnnouncement(connectingAnnouncement(phase));
        try {
            const connection = createSocketConnection({
                callbacks: {
                    onClose(event) {
                        if (generation !== socketGeneration.current) return;
                        socket.current = undefined;
                        terminal.setInputEnabled(false);
                        if (event.expected) return;
                        disconnectedCursorBySession.current.set(
                            sessionId,
                            event.afterSequence
                        );
                        if (event.kind === "protocol") {
                            setActionError(
                                "The terminal received unexpected data and was closed."
                            );
                        }
                        void reconnectSession(sessionId, event.afterSequence, runtime);
                    },
                    onControl: (message) => publishSocketControl(message, generation),
                    onInputBackpressure() {
                        if (generation !== socketGeneration.current) return;
                        setInputPaused(true);
                        setAnnouncement(
                            "Terminal input is paused while the connection catches up."
                        );
                        terminal.setInputEnabled(false);
                    },
                    onInputDrain() {
                        if (generation !== socketGeneration.current) return;
                        setInputPaused(false);
                        setAnnouncement("Terminal input resumed.");
                        terminal.setInputEnabled(true);
                        terminal.focus();
                    },
                    onOpen() {
                        if (generation !== socketGeneration.current) return;
                        setAnnouncement(
                            "Terminal connection opened. Waiting for the terminal to start."
                        );
                    },
                    onOutput(data) {
                        if (generation !== socketGeneration.current) return false;
                        if (
                            pendingOutputBytes.current + data.byteLength >
                            terminalSocketBufferedMaximumBytes
                        ) {
                            return false;
                        }
                        pendingOutputBytes.current += data.byteLength;
                        terminal.write(data, () => {
                            pendingOutputBytes.current = Math.max(
                                0,
                                pendingOutputBytes.current - data.byteLength
                            );
                        });
                        return true;
                    },
                },
                ticket,
            });
            socket.current = connection;
        } catch {
            setActionError("The terminal connection could not be opened.");
            setLocalPhase("error");
            void activeQuery.refetch();
        }
    }

    async function reconnectSession(
        sessionId: string,
        afterSequence: number,
        activeRuntime: TerminalRuntime
    ): Promise<void> {
        cancelReconnect();
        const controller = new AbortController();
        reconnectAbort.current = controller;
        const deadline =
            currentTimeMs() + activeRuntime.reconnectGraceMs - reconnectSafetyMarginMs;
        let cursor = afterSequence;
        let resynchronized = false;
        setLocalPhase("reconnecting");
        setAnnouncement("Connection lost. Reconnecting and restoring recent output.");
        emulator.current?.setInputEnabled(false);
        try {
            await waitForReconnectDelay(reconnectInitialDelayMs, controller.signal);
            while (!controller.signal.aborted && currentTimeMs() < deadline) {
                try {
                    const ticket = await boundary.run((signal) =>
                        client.mutation(
                            "terminal.prepareResume",
                            { afterSequence: cursor, sessionId },
                            {
                                signal: authenticatedAbortSignal(signal, [
                                    controller.signal,
                                ]),
                            }
                        )
                    );
                    if (controller.signal.aborted) return;
                    reconnectAbort.current = undefined;
                    openSocket(ticket, resynchronized ? "resyncing" : "reconnecting");
                    return;
                } catch (error) {
                    if (controller.signal.aborted) return;
                    const failure = classifyDashboardBrowserFailure(error);
                    if (failure !== "not-found" && failure !== "conflict") {
                        setActionError(terminalFailureMessage(error));
                        setLocalPhase("error");
                        setAnnouncement("Terminal reconnect failed.");
                        return;
                    }
                    const active = await boundary.run((signal) =>
                        client.query(
                            "terminal.getActiveSession",
                            {},
                            {
                                signal: authenticatedAbortSignal(signal, [
                                    controller.signal,
                                ]),
                            }
                        )
                    );
                    if (active.status === "none") {
                        disconnectedCursorBySession.current.delete(sessionId);
                        setLocalSession(undefined);
                        setLocalPhase("ended");
                        setAnnouncement("Terminal session ended while disconnected.");
                        return;
                    }
                    setLocalSession(active.session);
                    const replayCursor = retainedReplayCursor(active.session);
                    if (
                        active.session.state === "awaiting-reconnect" &&
                        failure === "not-found" &&
                        replayCursor > cursor
                    ) {
                        cursor = replayCursor;
                        resynchronized = true;
                        setReplayGap(true);
                        setLocalPhase("resyncing");
                        setAnnouncement(
                            "Some earlier output is no longer available. Showing the newest output."
                        );
                        continue;
                    }
                    await waitForReconnectDelay(reconnectRetryDelayMs, controller.signal);
                }
            }
            if (!controller.signal.aborted) {
                setActionError(
                    "The terminal was disconnected for too long. Resume it or start a new terminal."
                );
                setLocalPhase("active-elsewhere");
                setAnnouncement("Terminal reconnect window expired.");
                void activeQuery.refetch();
            }
        } catch (error) {
            if (controller.signal.aborted) return;
            setActionError(terminalFailureMessage(error));
            setLocalPhase("error");
            setAnnouncement("Terminal reconnect failed.");
        } finally {
            if (reconnectAbort.current === controller) {
                reconnectAbort.current = undefined;
            }
        }
    }

    async function startTerminal(): Promise<void> {
        const terminal = emulator.current;
        if (terminal === undefined || startBusy) return;
        cancelReconnect();
        disconnectedCursorBySession.current.clear();
        setActionError(undefined);
        setReplayGap(false);
        setStartBusy(true);
        setLocalPhase("starting");
        setAnnouncement("Starting interactive terminal.");
        terminal.reset();
        try {
            const ticket = await boundary.run((signal) =>
                client.mutation(
                    "terminal.prepareSession",
                    { dimensions, location },
                    { signal }
                )
            );
            openSocket(ticket, "connecting");
        } catch (error) {
            setActionError(terminalFailureMessage(error));
            setLocalPhase("error");
            setAnnouncement("Terminal could not be started.");
        } finally {
            setStartBusy(false);
        }
    }

    async function resumeTerminal(): Promise<void> {
        if (serverSession?.state !== "awaiting-reconnect" || startBusy) return;
        cancelReconnect();
        setActionError(undefined);
        setStartBusy(true);
        const resume = manualResumeSelection(
            serverSession,
            disconnectedCursorBySession.current.get(serverSession.sessionId)
        );
        setReplayGap(resume.replayGap);
        setLocalSession(serverSession);
        setLocalPhase(resume.replayGap ? "resyncing" : "reconnecting");
        try {
            const ticket = await boundary.run((signal) =>
                client.mutation(
                    "terminal.prepareResume",
                    {
                        afterSequence: resume.cursor,
                        sessionId: serverSession.sessionId,
                    },
                    { signal }
                )
            );
            openSocket(ticket, resume.replayGap ? "resyncing" : "reconnecting");
        } catch (error) {
            setActionError(terminalFailureMessage(error));
            setLocalPhase("active-elsewhere");
            setAnnouncement("Terminal could not be resumed.");
            void activeQuery.refetch();
        } finally {
            setStartBusy(false);
        }
    }

    async function endTerminal(): Promise<void> {
        const session = workspaceSession;
        if (session === undefined || endBusy) return;
        cancelReconnect();
        setActionError(undefined);
        setEndBusy(true);
        try {
            await boundary.run((signal) =>
                client.mutation(
                    "terminal.terminateSession",
                    { sessionId: session.sessionId },
                    { signal }
                )
            );
            socket.current?.close();
            socket.current = undefined;
            disconnectedCursorBySession.current.delete(session.sessionId);
            setLocalSession(undefined);
            setLocalPhase("ended");
            setInputPaused(false);
            setAnnouncement("Terminal ended by operator.");
            emulator.current?.setInputEnabled(false);
            await activeQuery.refetch();
        } catch (error) {
            setActionError(terminalFailureMessage(error));
            setAnnouncement("Terminal termination could not be confirmed.");
        } finally {
            setEndBusy(false);
        }
    }

    return (
        <TerminalWorkspace
            actionError={actionError}
            announcement={announcement}
            canvas={
                <TerminalCanvas
                    createEmulator={createEmulator}
                    inputEnabled={inputEnabled}
                    onDimensions={(nextDimensions) => {
                        setDimensions(nextDimensions);
                        socket.current?.sendControl({
                            dimensions: nextDimensions,
                            type: "resize",
                        });
                    }}
                    onEmulator={(nextEmulator) => {
                        emulator.current = nextEmulator;
                        setTerminalReady(nextEmulator !== undefined);
                    }}
                    onInput={(data) => {
                        socket.current?.sendInput(data);
                    }}
                />
            }
            dimensions={dimensions}
            endBusy={endBusy}
            inputPaused={inputPaused}
            location={location}
            onClear={() => {
                emulator.current?.clear();
                setAnnouncement("Local terminal buffer cleared.");
            }}
            onCopySelection={() => {
                void (async () => {
                    const result = await emulator.current?.copySelection();
                    if (result === "copied") {
                        setAnnouncement("Terminal selection copied.");
                    } else if (result === "empty") {
                        setAnnouncement("No terminal text is selected.");
                    } else {
                        setAnnouncement("Clipboard access is unavailable.");
                    }
                })();
            }}
            onEnd={() => void endTerminal()}
            onFocus={() => emulator.current?.focus()}
            onLocation={setSelectedLocation}
            onRefreshSession={() => void activeQuery.refetch()}
            onResume={() => void resumeTerminal()}
            onSearch={(query, direction) => {
                const found = emulator.current?.search(query, direction) ?? false;
                setAnnouncement(
                    found
                        ? "Terminal search result selected."
                        : "No matching terminal text."
                );
            }}
            onSendInterrupt={() => {
                const sent = socket.current?.sendControl({
                    signal: "SIGINT",
                    type: "signal",
                });
                setAnnouncement(sent ? "Interrupt sent." : "Interrupt was not sent.");
            }}
            onStart={() => void startTerminal()}
            phase={workspacePhase}
            replayGap={replayGap}
            runtime={runtime}
            session={workspaceSession}
            startBusy={startBusy}
            terminalReady={terminalReady}
        />
    );
}
