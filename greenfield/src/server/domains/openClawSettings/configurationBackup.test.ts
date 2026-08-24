import { afterEach, describe, expect, test } from "bun:test";

import { openClawConfigurationBackupTicketTtlMs } from "../../../contracts/openClawSettings.ts";
import type {
    WorkspaceFileNode,
    WorkspaceFileReadResult,
    WorkspaceFileReader,
} from "../files/ports.ts";
import {
    OpenClawConfigurationBackupError,
    openClawConfigurationBackupLocator,
    type OpenClawConfigurationBackupTicketStore,
} from "./configurationBackup.ts";
import { createWorkspaceFileOpenClawConfigurationBackupSource } from "./configurationBackupSource.ts";
import {
    createOpenClawConfigurationBackupTicketStore,
    type OpenClawConfigurationBackupTicketScheduler,
    type OpenClawConfigurationBackupTicketTimerHandle,
} from "./configurationBackupTickets.ts";

const actor = Object.freeze({
    authenticatorId: "session-1",
    id: "user-1",
});
const bytes = new TextEncoder().encode('{"token":"private"}\n');
const revision = "a".repeat(64);
const ticketStores: OpenClawConfigurationBackupTicketStore[] = [];
class ManualTicketScheduler implements OpenClawConfigurationBackupTicketScheduler {
    public nowMs = 1000;
    public unrefCount = 0;
    #timer:
        | {
              readonly callback: () => void;
              readonly dueAtMs: number;
              readonly handle: OpenClawConfigurationBackupTicketTimerHandle;
          }
        | undefined;

    public clearTimeout(handle: OpenClawConfigurationBackupTicketTimerHandle): void {
        if (this.#timer?.handle === handle) this.#timer = undefined;
    }

    public setTimeout(
        callback: () => void,
        delayMs: number
    ): OpenClawConfigurationBackupTicketTimerHandle {
        const handle = Object.freeze({
            unref: () => {
                this.unrefCount += 1;
            },
        });
        this.#timer = {
            callback,
            dueAtMs: this.nowMs + delayMs,
            handle,
        };
        return handle;
    }

    public advanceBy(delayMs: number): void {
        this.nowMs += delayMs;
        while (this.#timer !== undefined && this.#timer.dueAtMs <= this.nowMs) {
            const { callback } = this.#timer;
            this.#timer = undefined;
            callback();
        }
    }
}

function readerFixture(
    nodeOverrides: Partial<WorkspaceFileNode> = {},
    resultOverrides: Partial<WorkspaceFileReadResult> = {}
): {
    readonly calls: string[];
    readonly reader: WorkspaceFileReader;
    readonly resultBytes: Uint8Array;
} {
    const calls: string[] = [];
    const resultBytes = resultOverrides.bytes ?? Uint8Array.from(bytes);
    const node: WorkspaceFileNode = {
        kind: "file",
        locator: openClawConfigurationBackupLocator,
        mimeType: "application/json",
        modifiedAtMs: 1,
        name: "openclaw.json",
        previewKind: "text",
        requiresSecretReveal: true,
        revision,
        sizeBytes: bytes.byteLength,
        writable: true,
        ...nodeOverrides,
    };
    const result: WorkspaceFileReadResult = {
        fileName: "openclaw.json",
        mimeType: "application/json",
        previewKind: "text",
        revision,
        sizeBytes: bytes.byteLength,
        ...resultOverrides,
        bytes: resultBytes,
    };
    return {
        calls,
        reader: {
            describe(locator, _signal, access) {
                calls.push(`describe:${locator.rootId}:${access}`);
                return Promise.resolve(node);
            },
            dispose() {},
            list: () => Promise.reject(new Error("not used")),
            read(locator, expectedRevision, range, _signal, access) {
                calls.push(
                    `read:${locator.segments.join("/")}:${expectedRevision}:${range === undefined ? "undefined" : JSON.stringify(range)}:${access}`
                );
                return Promise.resolve(result);
            },
            roots: () => [],
        },
        resultBytes,
    };
}

function ticketStore(
    options: Parameters<typeof createOpenClawConfigurationBackupTicketStore>[0]
): OpenClawConfigurationBackupTicketStore {
    const store = createOpenClawConfigurationBackupTicketStore(options);
    ticketStores.push(store);
    return store;
}

afterEach(() => {
    for (const store of ticketStores.splice(0)) store.dispose();
});

describe("OpenClaw configuration export source and tickets", () => {
    test("reads only the exact complete secret-bearing descriptor representation", async () => {
        const fixture = readerFixture();
        const source = createWorkspaceFileOpenClawConfigurationBackupSource(
            fixture.reader
        );

        const exported = await source.read();

        expect(exported).toEqual(bytes);
        expect(exported).not.toBe(fixture.resultBytes);
        expect(fixture.resultBytes).toEqual(
            new Uint8Array(fixture.resultBytes.byteLength)
        );
        expect(fixture.calls).toEqual([
            "describe:openclaw-config:reveal-secrets",
            `read:openclaw.json:${revision}:undefined:reveal-secrets`,
        ]);
    });

    test("rejects redacted, truncated, oversized, or inconsistent source metadata", async () => {
        for (const overrides of [
            { requiresSecretReveal: false },
            { sourceSizeBytes: bytes.byteLength + 1, truncated: true as const },
            { sizeBytes: 0 },
            { mimeType: "text/plain" },
        ]) {
            const fixture = readerFixture(overrides);
            const failure = await createWorkspaceFileOpenClawConfigurationBackupSource(
                fixture.reader
            )
                .read()
                .catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(OpenClawConfigurationBackupError);
            expect(failure).toMatchObject({ reason: "invalid-source" });
            expect(fixture.calls).toHaveLength(1);
        }

        const mismatched = readerFixture({}, { revision: "b".repeat(64) });
        const mismatchFailure =
            await createWorkspaceFileOpenClawConfigurationBackupSource(mismatched.reader)
                .read()
                .catch((error: unknown) => error);
        expect(mismatchFailure).toMatchObject({ reason: "invalid-source" });
    });

    test("rejects and erases incomplete or inconsistent read results", async () => {
        const fixtures = [
            readerFixture({}, { sourceSizeBytes: bytes.byteLength + 1 }),
            readerFixture({}, { truncated: true }),
            readerFixture(
                {},
                {
                    bytes: Uint8Array.from(bytes.subarray(1)),
                    sizeBytes: bytes.byteLength,
                }
            ),
        ];

        for (const fixture of fixtures) {
            const failure = await createWorkspaceFileOpenClawConfigurationBackupSource(
                fixture.reader
            )
                .read()
                .catch((error: unknown) => error);
            expect(failure).toMatchObject({ reason: "invalid-source" });
            expect(fixture.calls).toHaveLength(2);
            expect(fixture.resultBytes).toEqual(
                new Uint8Array(fixture.resultBytes.byteLength)
            );
        }
    });

    test("binds exact bytes to one actor/session and consumes each ticket once", () => {
        let now = 1000;
        const store = ticketStore({
            generateId: () => "10000000-0000-4000-8000-000000000001",
            nowMs: () => now,
        });
        const issued = store.issue(actor, bytes);

        expect(store.inspect(actor, issued.ticketId)).toEqual({
            fileName: "openclaw.json",
            mimeType: "application/json",
            sizeBytes: bytes.byteLength,
        });
        expect(() =>
            store.inspect({ ...actor, authenticatorId: "session-2" }, issued.ticketId)
        ).toThrow(OpenClawConfigurationBackupError);
        const consumed = store.consume(actor, issued.ticketId).bytes;
        expect(consumed).toEqual(bytes);
        expect(consumed).not.toBe(bytes);
        consumed.fill(0);
        expect(() => store.consume(actor, issued.ticketId)).toThrow(
            OpenClawConfigurationBackupError
        );

        const expiring = ticketStore({
            generateId: () => "10000000-0000-4000-8000-000000000002",
            nowMs: () => now,
        });
        const expiringTicket = expiring.issue(actor, bytes);
        now = expiringTicket.expiresAtMs;
        expect(() => expiring.inspect(actor, expiringTicket.ticketId)).toThrow(
            OpenClawConfigurationBackupError
        );
    });

    test("actively expires secret records on an unref timer and retains bounded 410 semantics", () => {
        const scheduler = new ManualTicketScheduler();
        const ids = [
            "10000000-0000-4000-8000-000000000010",
            "10000000-0000-4000-8000-000000000011",
        ];
        const store = ticketStore({
            generateId: () => ids.shift()!,
            maximumStoredBytes: bytes.byteLength,
            maximumTickets: 1,
            nowMs: () => scheduler.nowMs,
            scheduler,
        });
        const expired = store.issue(actor, bytes);

        expect(scheduler.unrefCount).toBe(1);
        scheduler.advanceBy(openClawConfigurationBackupTicketTtlMs);

        expect(() => store.inspect(actor, expired.ticketId)).toThrow(
            expect.objectContaining({ reason: "expired" })
        );
        expect(() =>
            store.inspect({ ...actor, authenticatorId: "session-2" }, expired.ticketId)
        ).toThrow(expect.objectContaining({ reason: "not-found" }));

        const replacement = store.issue(actor, bytes);
        expect(replacement.ticketId).not.toBe(expired.ticketId);
        store.dispose();
    });

    test("fails closed when bounded ticket capacity is exhausted", () => {
        const ids = [
            "10000000-0000-4000-8000-000000000003",
            "10000000-0000-4000-8000-000000000004",
        ];
        const store = ticketStore({
            generateId: () => ids.shift()!,
            maximumStoredBytes: bytes.byteLength * 2,
            maximumTickets: 1,
            nowMs: () => 1000,
        });
        store.issue(actor, bytes);
        expect(() => store.issue(actor, bytes)).toThrow(OpenClawConfigurationBackupError);
    });

    test("validates actors before clock, capacity, sweep, or ID work", () => {
        let generateIdCalls = 0;
        let nowCalls = 0;
        const store = ticketStore({
            generateId: () => {
                generateIdCalls += 1;
                return "10000000-0000-4000-8000-000000000020";
            },
            maximumStoredBytes: bytes.byteLength,
            maximumTickets: 1,
            nowMs: () => {
                nowCalls += 1;
                return 1000;
            },
        });
        const invalidActor = { ...actor, id: "" };

        expect(() => store.issue(invalidActor, bytes)).toThrow(
            expect.objectContaining({ reason: "unavailable" })
        );
        expect(() =>
            store.inspect(invalidActor, "10000000-0000-4000-8000-000000000020")
        ).toThrow(expect.objectContaining({ reason: "unavailable" }));
        expect(generateIdCalls).toBe(0);
        expect(nowCalls).toBe(0);
    });

    test("releases stored-byte accounting when ownership transfers on consume", () => {
        const ids = [
            "10000000-0000-4000-8000-000000000030",
            "10000000-0000-4000-8000-000000000031",
        ];
        const store = ticketStore({
            generateId: () => ids.shift()!,
            maximumStoredBytes: bytes.byteLength,
            maximumTickets: 1,
            nowMs: () => 1000,
        });
        const first = store.issue(actor, bytes);

        const consumed = store.consume(actor, first.ticketId).bytes;
        const second = store.issue(actor, bytes);

        expect(second.ticketId).toBe("10000000-0000-4000-8000-000000000031");
        consumed.fill(0);
    });
});
