import { randomUUID } from "node:crypto";

import * as v from "valibot";

import {
    createOpenClawConfigurationBackupResultSchema,
    openClawConfigurationBackupTicketIdSchema,
    openClawConfigurationBackupTicketTtlMs,
    openClawConfigurationUpstreamMaximumBytes,
} from "../../../contracts/openClawSettings.ts";
import {
    OpenClawConfigurationBackupError,
    openClawConfigurationBackupFileName,
    openClawConfigurationBackupMimeType,
    type OpenClawConfigurationBackupActor,
    type OpenClawConfigurationBackupContent,
    type OpenClawConfigurationBackupMetadata,
    type OpenClawConfigurationBackupTicketStore,
} from "./configurationBackup.ts";

const defaultMaximumTickets = 8;
const defaultMaximumStoredBytes =
    defaultMaximumTickets * openClawConfigurationUpstreamMaximumBytes;

interface BackupTicketRecord {
    readonly actorKey: string;
    readonly bytes: Uint8Array;
    readonly expiresAtMs: number;
    readonly ticketId: string;
}

export interface OpenClawConfigurationBackupTicketStoreOptions {
    readonly generateId?: () => string;
    readonly maximumStoredBytes?: number;
    readonly maximumTickets?: number;
    readonly nowMs?: () => number;
}

function actorKey(actor: OpenClawConfigurationBackupActor): string {
    if (
        actor.id.length === 0 ||
        actor.authenticatorId.length === 0 ||
        actor.id.includes("\0") ||
        actor.authenticatorId.includes("\0")
    ) {
        throw new OpenClawConfigurationBackupError("unavailable");
    }
    return `${actor.id}\0${actor.authenticatorId}`;
}

function positiveLimit(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new TypeError(`OpenClaw configuration export ${name} is invalid`);
    }
    return value;
}

function metadata(record: BackupTicketRecord): OpenClawConfigurationBackupMetadata {
    return Object.freeze({
        fileName: openClawConfigurationBackupFileName,
        mimeType: openClawConfigurationBackupMimeType,
        sizeBytes: record.bytes.byteLength,
    });
}

/**
 * Creates a bounded in-memory store for exact one-shot secret-bearing exports.
 * @returns The process-local ticket lifecycle.
 */
export function createOpenClawConfigurationBackupTicketStore(
    options: OpenClawConfigurationBackupTicketStoreOptions = {}
): OpenClawConfigurationBackupTicketStore {
    const generateId = options.generateId ?? randomUUID;
    const maximumStoredBytes = positiveLimit(
        options.maximumStoredBytes ?? defaultMaximumStoredBytes,
        "byte capacity"
    );
    const maximumTickets = positiveLimit(
        options.maximumTickets ?? defaultMaximumTickets,
        "ticket capacity"
    );
    const nowMs = options.nowMs ?? Date.now;
    const tickets = new Map<string, BackupTicketRecord>();
    let disposed = false;
    let storedBytes = 0;

    function now(): number {
        if (disposed) throw new OpenClawConfigurationBackupError("unavailable");
        const value = nowMs();
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new OpenClawConfigurationBackupError("unavailable");
        }
        return value;
    }

    function remove(record: BackupTicketRecord, erase: boolean): void {
        if (!tickets.delete(record.ticketId)) return;
        storedBytes -= record.bytes.byteLength;
        if (erase) record.bytes.fill(0);
    }

    function sweepExpired(at: number): void {
        for (const record of tickets.values()) {
            if (record.expiresAtMs <= at) remove(record, true);
        }
    }

    function resolve(
        actor: OpenClawConfigurationBackupActor,
        ticketId: string,
        consume: boolean
    ): BackupTicketRecord {
        const at = now();
        const parsedId = v.safeParse(openClawConfigurationBackupTicketIdSchema, ticketId);
        if (!parsedId.success) {
            throw new OpenClawConfigurationBackupError("not-found");
        }
        const record = tickets.get(parsedId.output);
        if (record === undefined || record.actorKey !== actorKey(actor)) {
            throw new OpenClawConfigurationBackupError("not-found");
        }
        if (record.expiresAtMs <= at) {
            remove(record, true);
            throw new OpenClawConfigurationBackupError("expired");
        }
        if (consume) remove(record, false);
        return record;
    }

    return Object.freeze({
        consume(
            actor: OpenClawConfigurationBackupActor,
            ticketId: string
        ): OpenClawConfigurationBackupContent {
            const record = resolve(actor, ticketId, true);
            return Object.freeze({ ...metadata(record), bytes: record.bytes });
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            for (const record of tickets.values()) remove(record, true);
        },
        inspect(actor: OpenClawConfigurationBackupActor, ticketId: string) {
            return metadata(resolve(actor, ticketId, false));
        },
        issue(actor: OpenClawConfigurationBackupActor, bytes: Uint8Array) {
            const at = now();
            sweepExpired(at);
            if (
                bytes.byteLength < 1 ||
                bytes.byteLength > openClawConfigurationUpstreamMaximumBytes
            ) {
                throw new OpenClawConfigurationBackupError("invalid-source");
            }
            if (
                tickets.size >= maximumTickets ||
                storedBytes > maximumStoredBytes - bytes.byteLength
            ) {
                throw new OpenClawConfigurationBackupError("capacity");
            }
            const ticketIdResult = v.safeParse(
                openClawConfigurationBackupTicketIdSchema,
                generateId()
            );
            if (!ticketIdResult.success || tickets.has(ticketIdResult.output)) {
                throw new OpenClawConfigurationBackupError("unavailable");
            }
            const expiresAtMs = at + openClawConfigurationBackupTicketTtlMs;
            if (!Number.isSafeInteger(expiresAtMs)) {
                throw new OpenClawConfigurationBackupError("unavailable");
            }
            const ticketId = ticketIdResult.output;
            const result = v.parse(createOpenClawConfigurationBackupResultSchema, {
                downloadUrl: `/api/openclaw-settings/configuration-backups/${ticketId}`,
                expiresAtMs,
                ticketId,
            });
            const stored = Uint8Array.from(bytes);
            tickets.set(ticketId, {
                actorKey: actorKey(actor),
                bytes: stored,
                expiresAtMs,
                ticketId,
            });
            storedBytes += stored.byteLength;
            return result;
        },
    });
}
