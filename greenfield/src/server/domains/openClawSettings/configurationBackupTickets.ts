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

interface ExpiredBackupTicketRecord {
    readonly actorKey: string;
    readonly deleteAfterMs: number;
    readonly ticketId: string;
}

export interface OpenClawConfigurationBackupTicketTimerHandle {
    readonly unref?: () => void;
}

export interface OpenClawConfigurationBackupTicketScheduler {
    readonly clearTimeout: (handle: OpenClawConfigurationBackupTicketTimerHandle) => void;
    readonly setTimeout: (
        callback: () => void,
        delayMs: number
    ) => OpenClawConfigurationBackupTicketTimerHandle;
}

const defaultScheduler: OpenClawConfigurationBackupTicketScheduler = Object.freeze({
    clearTimeout(handle: OpenClawConfigurationBackupTicketTimerHandle) {
        globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    },
    setTimeout(callback: () => void, delayMs: number) {
        return globalThis.setTimeout(
            callback,
            delayMs
        ) as unknown as OpenClawConfigurationBackupTicketTimerHandle;
    },
});

export interface OpenClawConfigurationBackupTicketStoreOptions {
    readonly generateId?: () => string;
    readonly maximumStoredBytes?: number;
    readonly maximumTickets?: number;
    readonly nowMs?: () => number;
    readonly scheduler?: OpenClawConfigurationBackupTicketScheduler;
}

function actorKey(actor: OpenClawConfigurationBackupActor): string {
    if (
        typeof actor.id !== "string" ||
        typeof actor.authenticatorId !== "string" ||
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
    const scheduler = options.scheduler ?? defaultScheduler;
    const expiredTickets = new Map<string, ExpiredBackupTicketRecord>();
    const tickets = new Map<string, BackupTicketRecord>();
    let disposed = false;
    let expiryTimer: OpenClawConfigurationBackupTicketTimerHandle | undefined;
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
        if (tickets.delete(record.ticketId)) {
            storedBytes -= record.bytes.byteLength;
        }
        if (erase) record.bytes.fill(0);
    }

    function sweepExpired(at: number): void {
        for (const record of tickets.values()) {
            if (record.expiresAtMs > at) continue;
            remove(record, true);
            const deleteAfterMs =
                record.expiresAtMs + openClawConfigurationBackupTicketTtlMs;
            if (Number.isSafeInteger(deleteAfterMs)) {
                expiredTickets.set(record.ticketId, {
                    actorKey: record.actorKey,
                    deleteAfterMs,
                    ticketId: record.ticketId,
                });
                while (expiredTickets.size > maximumTickets) {
                    const oldestTicketId = expiredTickets.keys().next().value;
                    if (oldestTicketId === undefined) break;
                    expiredTickets.delete(oldestTicketId);
                }
            }
        }
        for (const record of expiredTickets.values()) {
            if (record.deleteAfterMs <= at) expiredTickets.delete(record.ticketId);
        }
    }

    function scheduleExpiry(at: number): void {
        if (expiryTimer !== undefined) {
            scheduler.clearTimeout(expiryTimer);
            expiryTimer = undefined;
        }
        if (disposed) return;
        let nextAtMs: number | undefined;
        for (const record of tickets.values()) {
            nextAtMs =
                nextAtMs === undefined
                    ? record.expiresAtMs
                    : Math.min(nextAtMs, record.expiresAtMs);
        }
        for (const record of expiredTickets.values()) {
            nextAtMs =
                nextAtMs === undefined
                    ? record.deleteAfterMs
                    : Math.min(nextAtMs, record.deleteAfterMs);
        }
        if (nextAtMs === undefined) return;
        expiryTimer = scheduler.setTimeout(
            () => {
                expiryTimer = undefined;
                if (disposed) return;
                let currentTime: number;
                try {
                    currentTime = now();
                } catch {
                    disposed = true;
                    for (const record of tickets.values()) remove(record, true);
                    expiredTickets.clear();
                    return;
                }
                sweepExpired(currentTime);
                scheduleExpiry(currentTime);
            },
            Math.max(0, nextAtMs - at)
        );
        expiryTimer.unref?.();
    }

    function resolve(
        actor: OpenClawConfigurationBackupActor,
        ticketId: string,
        consume: boolean
    ): BackupTicketRecord {
        const key = actorKey(actor);
        const at = now();
        sweepExpired(at);
        scheduleExpiry(at);
        const parsedId = v.safeParse(openClawConfigurationBackupTicketIdSchema, ticketId);
        if (!parsedId.success) {
            throw new OpenClawConfigurationBackupError("not-found");
        }
        const expired = expiredTickets.get(parsedId.output);
        if (expired !== undefined && expired.actorKey === key) {
            throw new OpenClawConfigurationBackupError("expired");
        }
        const record = tickets.get(parsedId.output);
        if (record === undefined || record.actorKey !== key) {
            throw new OpenClawConfigurationBackupError("not-found");
        }
        if (consume) {
            remove(record, false);
            scheduleExpiry(at);
        }
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
            if (expiryTimer !== undefined) {
                scheduler.clearTimeout(expiryTimer);
                expiryTimer = undefined;
            }
            for (const record of tickets.values()) remove(record, true);
            expiredTickets.clear();
        },
        inspect(actor: OpenClawConfigurationBackupActor, ticketId: string) {
            return metadata(resolve(actor, ticketId, false));
        },
        issue(actor: OpenClawConfigurationBackupActor, bytes: Uint8Array) {
            const key = actorKey(actor);
            const at = now();
            sweepExpired(at);
            scheduleExpiry(at);
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
            if (
                !ticketIdResult.success ||
                tickets.has(ticketIdResult.output) ||
                expiredTickets.has(ticketIdResult.output)
            ) {
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
            const record: BackupTicketRecord = {
                actorKey: key,
                bytes: stored,
                expiresAtMs,
                ticketId,
            };
            try {
                tickets.set(ticketId, record);
                storedBytes += stored.byteLength;
                scheduleExpiry(at);
            } catch (error) {
                remove(record, true);
                throw error;
            }
            return result;
        },
    });
}
