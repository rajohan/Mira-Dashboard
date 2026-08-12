import { describe, expect, test } from "bun:test";

import type {
    WorkspaceFileNode,
    WorkspaceFileReadResult,
    WorkspaceFileReader,
} from "../files/ports.ts";
import {
    OpenClawConfigurationBackupError,
    openClawConfigurationBackupLocator,
} from "./configurationBackup.ts";
import { createWorkspaceFileOpenClawConfigurationBackupSource } from "./configurationBackupSource.ts";
import { createOpenClawConfigurationBackupTicketStore } from "./configurationBackupTickets.ts";

const actor = Object.freeze({
    authenticatorId: "session-1",
    id: "user-1",
});
const bytes = new TextEncoder().encode('{"token":"private"}\n');
const revision = "a".repeat(64);

function readerFixture(
    nodeOverrides: Partial<WorkspaceFileNode> = {},
    resultOverrides: Partial<WorkspaceFileReadResult> = {}
): { readonly calls: string[]; readonly reader: WorkspaceFileReader } {
    const calls: string[] = [];
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
        bytes,
        fileName: "openclaw.json",
        mimeType: "application/json",
        previewKind: "text",
        revision,
        sizeBytes: bytes.byteLength,
        ...resultOverrides,
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
    };
}

describe("OpenClaw configuration export source and tickets", () => {
    test("reads only the exact complete secret-bearing descriptor representation", async () => {
        const fixture = readerFixture();
        const source = createWorkspaceFileOpenClawConfigurationBackupSource(
            fixture.reader
        );

        const exported = await source.read();

        expect(exported).toEqual(bytes);
        expect(exported).not.toBe(bytes);
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

    test("binds exact bytes to one actor/session and consumes each ticket once", () => {
        let now = 1000;
        const store = createOpenClawConfigurationBackupTicketStore({
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
        expect(store.consume(actor, issued.ticketId).bytes).toEqual(bytes);
        expect(() => store.consume(actor, issued.ticketId)).toThrow(
            OpenClawConfigurationBackupError
        );

        const expiring = createOpenClawConfigurationBackupTicketStore({
            generateId: () => "10000000-0000-4000-8000-000000000002",
            nowMs: () => now,
        });
        const expiringTicket = expiring.issue(actor, bytes);
        now = expiringTicket.expiresAtMs;
        expect(() => expiring.inspect(actor, expiringTicket.ticketId)).toThrow(
            OpenClawConfigurationBackupError
        );
    });

    test("fails closed when bounded ticket capacity is exhausted", () => {
        const ids = [
            "10000000-0000-4000-8000-000000000003",
            "10000000-0000-4000-8000-000000000004",
        ];
        const store = createOpenClawConfigurationBackupTicketStore({
            generateId: () => ids.shift()!,
            maximumStoredBytes: bytes.byteLength * 2,
            maximumTickets: 1,
            nowMs: () => 1000,
        });
        store.issue(actor, bytes);
        expect(() => store.issue(actor, bytes)).toThrow(OpenClawConfigurationBackupError);
    });
});
