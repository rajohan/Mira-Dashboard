import * as v from "valibot";

import {
    chatAttachmentIdSchema,
    chatAttachmentLimits,
    chatAttachmentTicketIdSchema,
    chatAttachmentTicketPrepareInputSchema,
    chatAttachmentTicketPrepareOutputSchema,
    normalizeChatAttachmentDeclaredMimeType,
    type ChatAttachmentTicketPrepareInput,
    type ChatAttachmentTicketPrepareOutput,
} from "../../../contracts/chatMedia.ts";
import type {
    ChatAttachmentTicketConsumer,
    ChatAttachmentTicketPreparer,
    ChatAttachmentTicketReservation,
    ChatProviderAttachment,
} from "../../domains/chat/provider.ts";
import { ChatAttachmentTicketError } from "../../domains/chat/provider.ts";

export const chatAttachmentSpoolMaximumBytes = 128 * 1024 * 1024;
export const chatAttachmentTicketMaximum = 128;

export type ChatAttachmentStoreErrorReason =
    | "capacity"
    | "conflict"
    | "expired"
    | "forbidden"
    | "invalid"
    | "not-found"
    | "not-ready"
    | "unavailable";

export class ChatAttachmentStoreError extends ChatAttachmentTicketError {
    constructor(reason: ChatAttachmentStoreErrorReason) {
        super(reason);
        this.name = "ChatAttachmentStoreError";
    }
}

interface AttachmentSlot {
    readonly attachmentId: string;
    readonly fileName: string;
    readonly mimeType: string;
    readonly sizeBytes: number;
    bytes?: Uint8Array;
}

interface AttachmentTicket {
    readonly actorId: string;
    readonly expiresAtMs: number;
    readonly filesFingerprint: string;
    readonly idempotencyKey: string;
    readonly output: ChatAttachmentTicketPrepareOutput;
    readonly sessionKey: string;
    readonly slots: Map<string, AttachmentSlot>;
    readonly ticketId: string;
    reservation?: InternalReservation;
    state: "committed" | "open" | "reserved";
}

interface InternalReservation {
    readonly identity: object;
    readonly port: ChatAttachmentTicketReservation;
}

export interface ChatAttachmentRawUploadInput {
    readonly actorId: string;
    readonly attachmentId: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly ticketId: string;
}

export interface InMemoryChatAttachmentStore
    extends ChatAttachmentTicketConsumer, ChatAttachmentTicketPreparer {
    readonly dispose: () => void;
    readonly upload: (input: ChatAttachmentRawUploadInput) => Promise<void>;
}

export interface InMemoryChatAttachmentStoreOptions {
    readonly createId?: () => string;
    readonly maximumSpoolBytes?: number;
    readonly maximumTickets?: number;
    readonly nowMs?: () => number;
}

function boundedActorId(actorId: string): string {
    if (
        actorId.length === 0 ||
        actorId.length > 256 ||
        actorId !== actorId.trim() ||
        /[\p{Cc}\p{Cf}]/u.test(actorId)
    ) {
        throw new ChatAttachmentStoreError("invalid");
    }
    return actorId;
}

function checkedNow(nowMs: () => number): number {
    const now = nowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
        throw new ChatAttachmentStoreError("invalid");
    }
    return now;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength &&
        Buffer.from(left.buffer, left.byteOffset, left.byteLength).equals(
            Buffer.from(right.buffer, right.byteOffset, right.byteLength)
        )
    );
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
    return prefix.every((value, index) => bytes[index] === value);
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset + start, length).toString("ascii");
}

function hasNoAsciiControlCharacter(value: string): boolean {
    for (const character of value) {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
            return false;
        }
    }
    return true;
}

function utf8Text(bytes: Uint8Array): string | undefined {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return text.includes("\0") ? undefined : text;
    } catch {
        return undefined;
    }
}

function isZipMimeType(mimeType: string): boolean {
    return (
        mimeType === "application/zip" ||
        mimeType ===
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        mimeType ===
            "application/vnd.openxmlformats-officedocument.presentationml.presentation" ||
        mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
}

function isOleMimeType(mimeType: string): boolean {
    return (
        mimeType === "application/msword" ||
        mimeType === "application/vnd.ms-excel" ||
        mimeType === "application/vnd.ms-powerpoint"
    );
}

export const chatAttachmentZipMaximumEntries = 4096;
export const chatAttachmentZipMaximumNameBytes = 256 * 1024;

const zipEndOfCentralDirectorySignature = 0x06_05_4b_50;
const zipCentralDirectorySignature = 0x02_01_4b_50;
const zipLocalFileSignature = 0x04_03_4b_50;
const zipEndOfCentralDirectoryBytes = 22;
const zipCentralDirectoryHeaderBytes = 46;
const zipLocalFileHeaderBytes = 30;
const zipMaximumCommentBytes = 65_535;

interface ZipEntryInventory {
    readonly hasContentTypes: boolean;
    readonly hasPptEntry: boolean;
    readonly hasWordEntry: boolean;
    readonly hasXlEntry: boolean;
    readonly valid: boolean;
}

const invalidZipEntryInventory = Object.freeze({
    hasContentTypes: false,
    hasPptEntry: false,
    hasWordEntry: false,
    hasXlEntry: false,
    valid: false,
} as const);

function uint8RangesEqual(
    bytes: Uint8Array,
    leftOffset: number,
    rightOffset: number,
    length: number
): boolean {
    for (let index = 0; index < length; index += 1) {
        if (bytes[leftOffset + index] !== bytes[rightOffset + index]) return false;
    }
    return true;
}

function findZipEndOfCentralDirectory(
    bytes: Uint8Array,
    view: DataView
): number | undefined {
    if (bytes.byteLength < zipEndOfCentralDirectoryBytes) return undefined;
    const firstCandidate = bytes.byteLength - zipEndOfCentralDirectoryBytes;
    const lastCandidate = Math.max(0, firstCandidate - zipMaximumCommentBytes);
    for (let offset = firstCandidate; offset >= lastCandidate; offset -= 1) {
        if (view.getUint32(offset, true) !== zipEndOfCentralDirectorySignature) {
            continue;
        }
        const commentBytes = view.getUint16(offset + 20, true);
        if (offset + zipEndOfCentralDirectoryBytes + commentBytes === bytes.byteLength) {
            return offset;
        }
    }
    return undefined;
}

/**
 * Performs a bounded ZIP central-directory walk without scanning payload bytes.
 * @param bytes Untrusted ZIP bytes.
 * @returns Validity and the bounded Office entry inventory.
 */
function inspectZipEntries(bytes: Uint8Array): ZipEntryInventory {
    if (bytes.byteLength < zipEndOfCentralDirectoryBytes) {
        return invalidZipEntryInventory;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const firstSignature = view.getUint32(0, true);
    if (
        firstSignature !== zipLocalFileSignature &&
        firstSignature !== zipEndOfCentralDirectorySignature
    ) {
        return invalidZipEntryInventory;
    }
    const endOffset = findZipEndOfCentralDirectory(bytes, view);
    if (endOffset === undefined) return invalidZipEntryInventory;
    const diskNumber = view.getUint16(endOffset + 4, true);
    const centralDiskNumber = view.getUint16(endOffset + 6, true);
    const diskEntries = view.getUint16(endOffset + 8, true);
    const entryCount = view.getUint16(endOffset + 10, true);
    const centralBytes = view.getUint32(endOffset + 12, true);
    const centralOffset = view.getUint32(endOffset + 16, true);
    if (
        diskNumber !== 0 ||
        centralDiskNumber !== 0 ||
        diskEntries !== entryCount ||
        entryCount > chatAttachmentZipMaximumEntries ||
        centralOffset + centralBytes !== endOffset
    ) {
        return invalidZipEntryInventory;
    }
    let offset = centralOffset;
    let nameBytes = 0;
    let hasContentTypes = false;
    let hasPptEntry = false;
    let hasWordEntry = false;
    let hasXlEntry = false;
    for (let index = 0; index < entryCount; index += 1) {
        if (
            offset > endOffset - zipCentralDirectoryHeaderBytes ||
            view.getUint32(offset, true) !== zipCentralDirectorySignature
        ) {
            return invalidZipEntryInventory;
        }
        const flags = view.getUint16(offset + 8, true);
        const compressionMethod = view.getUint16(offset + 10, true);
        const compressedBytes = view.getUint32(offset + 20, true);
        const entryNameBytes = view.getUint16(offset + 28, true);
        const extraBytes = view.getUint16(offset + 30, true);
        const commentBytes = view.getUint16(offset + 32, true);
        const entryDisk = view.getUint16(offset + 34, true);
        const localOffset = view.getUint32(offset + 42, true);
        const nameOffset = offset + zipCentralDirectoryHeaderBytes;
        const nextOffset = nameOffset + entryNameBytes + extraBytes + commentBytes;
        nameBytes += entryNameBytes;
        if (
            (flags & 1) !== 0 ||
            entryDisk !== 0 ||
            entryNameBytes < 1 ||
            entryNameBytes > 1024 ||
            nameBytes > chatAttachmentZipMaximumNameBytes ||
            nextOffset > endOffset ||
            localOffset > centralOffset - zipLocalFileHeaderBytes ||
            view.getUint32(localOffset, true) !== zipLocalFileSignature
        ) {
            return invalidZipEntryInventory;
        }
        const localFlags = view.getUint16(localOffset + 6, true);
        const localCompressionMethod = view.getUint16(localOffset + 8, true);
        const localNameBytes = view.getUint16(localOffset + 26, true);
        const localExtraBytes = view.getUint16(localOffset + 28, true);
        const localNameOffset = localOffset + zipLocalFileHeaderBytes;
        const localDataOffset = localNameOffset + localNameBytes + localExtraBytes;
        if (
            localFlags !== flags ||
            localCompressionMethod !== compressionMethod ||
            localNameBytes !== entryNameBytes ||
            localDataOffset > centralOffset ||
            compressedBytes > centralOffset - localDataOffset ||
            !uint8RangesEqual(bytes, localNameOffset, nameOffset, entryNameBytes)
        ) {
            return invalidZipEntryInventory;
        }
        const name = ascii(bytes, nameOffset, entryNameBytes);
        if (!hasNoAsciiControlCharacter(name)) return invalidZipEntryInventory;
        hasContentTypes ||= name === "[Content_Types].xml";
        hasPptEntry ||= name.startsWith("ppt/");
        hasWordEntry ||= name.startsWith("word/");
        hasXlEntry ||= name.startsWith("xl/");
        offset = nextOffset;
    }
    return offset === endOffset
        ? {
              hasContentTypes,
              hasPptEntry,
              hasWordEntry,
              hasXlEntry,
              valid: true,
          }
        : invalidZipEntryInventory;
}

function bytesContainUtf16LittleEndian(bytes: Uint8Array, value: string): boolean {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(
        Buffer.from(value, "utf16le")
    );
}

/**
 * Conservatively verifies magic/text content; a declared suffix grants no authority.
 * @param bytes Untrusted attachment bytes.
 * @param mimeType Canonical ticket MIME type.
 * @returns Whether the bytes conform to the supported conservative signature.
 */
export function chatAttachmentBytesMatchMimeType(
    bytes: Uint8Array,
    mimeType: string
): boolean {
    if (bytes.byteLength === 0) return false;
    if (mimeType === "image/png") {
        return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
    if (mimeType === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
    if (mimeType === "image/gif") {
        return (
            ascii(bytes, 0, Math.min(6, bytes.byteLength)) === "GIF87a" ||
            ascii(bytes, 0, Math.min(6, bytes.byteLength)) === "GIF89a"
        );
    }
    if (mimeType === "image/webp") {
        return (
            bytes.byteLength >= 12 &&
            ascii(bytes, 0, 4) === "RIFF" &&
            ascii(bytes, 8, 4) === "WEBP"
        );
    }
    if (mimeType === "image/bmp") return ascii(bytes, 0, 2) === "BM";
    if (
        mimeType === "image/avif" ||
        mimeType === "image/heic" ||
        mimeType === "image/heif"
    ) {
        if (bytes.byteLength < 12 || ascii(bytes, 4, 4) !== "ftyp") return false;
        const brand = ascii(bytes, 8, 4);
        return mimeType === "image/avif"
            ? brand === "avif" || brand === "avis"
            : ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand);
    }
    if (mimeType === "application/pdf") return ascii(bytes, 0, 5) === "%PDF-";
    if (isZipMimeType(mimeType)) {
        const entries = inspectZipEntries(bytes);
        if (!entries.valid) return false;
        if (mimeType === "application/zip") return true;
        if (!entries.hasContentTypes) return false;
        if (
            mimeType ===
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        ) {
            return entries.hasWordEntry;
        }
        return mimeType ===
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            ? entries.hasXlEntry
            : entries.hasPptEntry;
    }
    if (isOleMimeType(mimeType)) {
        if (!startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
            return false;
        }
        let streamName = "PowerPoint Document";
        if (mimeType === "application/msword") streamName = "WordDocument";
        else if (mimeType === "application/vnd.ms-excel") streamName = "Workbook";
        return (
            bytesContainUtf16LittleEndian(bytes, streamName) ||
            (mimeType === "application/vnd.ms-excel" &&
                bytesContainUtf16LittleEndian(bytes, "Book"))
        );
    }
    if (mimeType === "audio/wav") {
        return (
            bytes.byteLength >= 12 &&
            ascii(bytes, 0, 4) === "RIFF" &&
            ascii(bytes, 8, 4) === "WAVE"
        );
    }
    if (mimeType === "audio/flac") return ascii(bytes, 0, 4) === "fLaC";
    if (mimeType === "audio/ogg" || mimeType === "audio/opus") {
        return ascii(bytes, 0, 4) === "OggS";
    }
    if (mimeType === "audio/mpeg") {
        return (
            ascii(bytes, 0, Math.min(3, bytes.byteLength)) === "ID3" ||
            (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)
        );
    }
    if (mimeType === "audio/aac") {
        return bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0;
    }
    if (mimeType === "audio/mp4") return false;
    const text = utf8Text(bytes);
    if (text === undefined) return false;
    if (mimeType === "application/json") {
        try {
            JSON.parse(text);
            return true;
        } catch {
            return false;
        }
    }
    if (mimeType === "image/svg+xml") {
        const normalized = text.trimStart().replace(/^<\?xml[^>]*>\s*/u, "");
        return /^<svg(?:\s|>)/iu.test(normalized);
    }
    return mimeType.startsWith("text/");
}

class InMemoryChatAttachmentStoreImplementation implements InMemoryChatAttachmentStore {
    readonly #createId: () => string;
    readonly #idempotencyTickets = new Map<string, AttachmentTicket>();
    readonly #maximumSpoolBytes: number;
    readonly #maximumTickets: number;
    readonly #nowMs: () => number;
    readonly #tickets = new Map<string, AttachmentTicket>();
    #disposed = false;
    #spooledBytes = 0;

    constructor(options: InMemoryChatAttachmentStoreOptions) {
        this.#createId = options.createId ?? (() => crypto.randomUUID());
        this.#maximumSpoolBytes =
            options.maximumSpoolBytes ?? chatAttachmentSpoolMaximumBytes;
        this.#maximumTickets = options.maximumTickets ?? chatAttachmentTicketMaximum;
        this.#nowMs = options.nowMs ?? Date.now;
        if (
            !Number.isSafeInteger(this.#maximumSpoolBytes) ||
            this.#maximumSpoolBytes < chatAttachmentLimits.maximumAggregateRawBytes ||
            !Number.isSafeInteger(this.#maximumTickets) ||
            this.#maximumTickets < 1
        ) {
            throw new TypeError("Chat attachment store capacity is invalid");
        }
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        for (const ticket of this.#tickets.values()) this.#releaseTicketBytes(ticket);
        this.#tickets.clear();
        this.#idempotencyTickets.clear();
    }
    prepare(
        input: ChatAttachmentTicketPrepareInput,
        actorId: string,
        signal?: AbortSignal
    ): Promise<ChatAttachmentTicketPrepareOutput> {
        return synchronousPromise(() => {
            this.#assertAvailable(signal);
            const actor = boundedActorId(actorId);
            const parsed = v.safeParse(chatAttachmentTicketPrepareInputSchema, input, {
                abortEarly: true,
            });
            if (!parsed.success) throw new ChatAttachmentStoreError("invalid");
            const now = checkedNow(this.#nowMs);
            this.#sweep(now);
            const replayKey = JSON.stringify([
                actor,
                parsed.output.sessionKey,
                parsed.output.idempotencyKey,
            ]);
            const filesFingerprint = JSON.stringify(parsed.output.files);
            const replay = this.#idempotencyTickets.get(replayKey);
            if (replay !== undefined) {
                if (
                    replay.filesFingerprint !== filesFingerprint ||
                    replay.state === "committed"
                ) {
                    throw new ChatAttachmentStoreError("conflict");
                }
                return replay.output;
            }
            if (this.#tickets.size >= this.#maximumTickets) {
                throw new ChatAttachmentStoreError("capacity");
            }
            const ticketId = this.#validatedId(
                this.#createId(),
                chatAttachmentTicketIdSchema
            );
            if (this.#tickets.has(ticketId)) {
                throw new ChatAttachmentStoreError("conflict");
            }
            const slots = new Map<string, AttachmentSlot>();
            const uploads = parsed.output.files.map((file) => {
                const attachmentId = this.#validatedId(
                    this.#createId(),
                    chatAttachmentIdSchema
                );
                if (slots.has(attachmentId)) {
                    throw new ChatAttachmentStoreError("conflict");
                }
                slots.set(attachmentId, {
                    attachmentId,
                    fileName: file.fileName,
                    mimeType: file.mimeType,
                    sizeBytes: file.sizeBytes,
                });
                return {
                    attachmentId,
                    uploadUrl: `/api/chat/attachments/${ticketId}/${attachmentId}`,
                };
            });
            const output = v.parse(chatAttachmentTicketPrepareOutputSchema, {
                expiresAtMs: now + chatAttachmentLimits.ticketTtlMs,
                ticketId,
                uploads,
            });
            for (const upload of output.uploads) Object.freeze(upload);
            Object.freeze(output.uploads);
            Object.freeze(output);
            const ticket: AttachmentTicket = {
                actorId: actor,
                expiresAtMs: output.expiresAtMs,
                filesFingerprint,
                idempotencyKey: parsed.output.idempotencyKey,
                output,
                sessionKey: parsed.output.sessionKey,
                slots,
                state: "open",
                ticketId,
            };
            this.#tickets.set(ticketId, ticket);
            this.#idempotencyTickets.set(replayKey, ticket);
            return ticket.output;
        });
    }

    upload(input: ChatAttachmentRawUploadInput): Promise<void> {
        return synchronousPromise(() => {
            this.#assertAvailable();
            const actorId = boundedActorId(input.actorId);
            const ticketId = this.#validatedId(
                input.ticketId,
                chatAttachmentTicketIdSchema
            );
            const attachmentId = this.#validatedId(
                input.attachmentId,
                chatAttachmentIdSchema
            );
            const now = checkedNow(this.#nowMs);
            this.#sweep(now);
            const ticket = this.#tickets.get(ticketId);
            if (ticket === undefined) throw new ChatAttachmentStoreError("not-found");
            if (ticket.expiresAtMs <= now) throw new ChatAttachmentStoreError("expired");
            if (ticket.actorId !== actorId)
                throw new ChatAttachmentStoreError("forbidden");
            if (ticket.state !== "open") throw new ChatAttachmentStoreError("conflict");
            const slot = ticket.slots.get(attachmentId);
            if (slot === undefined) throw new ChatAttachmentStoreError("not-found");
            const declaredMimeType = normalizeChatAttachmentDeclaredMimeType(
                input.contentType
            );
            if (
                input.bytes.byteLength !== slot.sizeBytes ||
                declaredMimeType !== slot.mimeType ||
                !chatAttachmentBytesMatchMimeType(input.bytes, slot.mimeType)
            ) {
                throw new ChatAttachmentStoreError("invalid");
            }
            if (slot.bytes !== undefined) {
                if (!bytesEqual(slot.bytes, input.bytes)) {
                    throw new ChatAttachmentStoreError("conflict");
                }
                return;
            }
            if (this.#spooledBytes > this.#maximumSpoolBytes - input.bytes.byteLength) {
                throw new ChatAttachmentStoreError("capacity");
            }
            slot.bytes = Uint8Array.from(input.bytes);
            this.#spooledBytes += slot.bytes.byteLength;
        });
    }

    reserve(
        request: Readonly<{
            actorId: string;
            idempotencyKey: string;
            sessionKey: string;
            ticketId: string;
        }>,
        signal?: AbortSignal
    ): Promise<ChatAttachmentTicketReservation> {
        return synchronousPromise(() => {
            this.#assertAvailable(signal);
            const now = checkedNow(this.#nowMs);
            this.#sweep(now);
            const ticketId = this.#validatedId(
                request.ticketId,
                chatAttachmentTicketIdSchema
            );
            const ticket = this.#tickets.get(ticketId);
            if (ticket === undefined) throw new ChatAttachmentStoreError("not-found");
            if (ticket.expiresAtMs <= now && ticket.state !== "reserved") {
                throw new ChatAttachmentStoreError("expired");
            }
            if (
                ticket.actorId !== boundedActorId(request.actorId) ||
                ticket.sessionKey !== request.sessionKey ||
                ticket.idempotencyKey !== request.idempotencyKey
            ) {
                throw new ChatAttachmentStoreError("forbidden");
            }
            if (ticket.state === "committed") {
                throw new ChatAttachmentStoreError("conflict");
            }
            if (ticket.reservation !== undefined) return ticket.reservation.port;
            if ([...ticket.slots.values()].some(({ bytes }) => bytes === undefined)) {
                throw new ChatAttachmentStoreError("not-ready");
            }
            const identity = {};
            const attachments = Object.freeze(
                [...ticket.slots.values()].map((slot): ChatProviderAttachment =>
                    Object.freeze({
                        content: Buffer.from(
                            slot.bytes!.buffer,
                            slot.bytes!.byteOffset,
                            slot.bytes!.byteLength
                        ).toString("base64"),
                        fileName: slot.fileName,
                        mimeType: slot.mimeType,
                        sizeBytes: slot.sizeBytes,
                        type: "file",
                    })
                )
            );
            let committed = false;
            let released = false;
            const port: ChatAttachmentTicketReservation = Object.freeze({
                attachments,
                commit: (commitSignal?: AbortSignal) =>
                    synchronousPromise(() => {
                        if (committed) return;
                        if (released) throw new ChatAttachmentStoreError("conflict");
                        this.#assertAvailable(commitSignal);
                        if (ticket.reservation?.identity !== identity) {
                            throw new ChatAttachmentStoreError("conflict");
                        }
                        committed = true;
                        ticket.state = "committed";
                        ticket.reservation = undefined;
                        this.#removeTicket(ticket);
                    }),
                release: (releaseSignal?: AbortSignal) =>
                    synchronousPromise(() => {
                        if (released || committed) return;
                        this.#assertAvailable(releaseSignal);
                        if (ticket.reservation?.identity !== identity) return;
                        released = true;
                        ticket.reservation = undefined;
                        ticket.state = "open";
                        this.#sweep(checkedNow(this.#nowMs));
                    }),
            });
            ticket.reservation = { identity, port };
            ticket.state = "reserved";
            return port;
        });
    }

    #assertAvailable(signal?: AbortSignal): void {
        if (this.#disposed) throw new ChatAttachmentStoreError("unavailable");
        if (signal?.aborted === true) throw new ChatAttachmentStoreError("invalid");
    }

    #releaseTicketBytes(ticket: AttachmentTicket): void {
        for (const slot of ticket.slots.values()) {
            if (slot.bytes === undefined) continue;
            this.#spooledBytes -= slot.bytes.byteLength;
            slot.bytes = undefined;
        }
    }

    #removeTicket(ticket: AttachmentTicket): void {
        this.#releaseTicketBytes(ticket);
        this.#tickets.delete(ticket.ticketId);
        this.#idempotencyTickets.delete(
            JSON.stringify([ticket.actorId, ticket.sessionKey, ticket.idempotencyKey])
        );
    }

    #sweep(now: number): void {
        for (const ticket of this.#tickets.values()) {
            if (ticket.expiresAtMs <= now && ticket.state !== "reserved") {
                this.#removeTicket(ticket);
            }
        }
    }

    #validatedId<TSchema extends v.GenericSchema<string, string>>(
        value: string,
        schema: TSchema
    ): string {
        const parsed = v.safeParse(schema, value, { abortEarly: true });
        if (!parsed.success) throw new ChatAttachmentStoreError("invalid");
        return parsed.output;
    }
}

export function createInMemoryChatAttachmentStore(
    options: InMemoryChatAttachmentStoreOptions = {}
): InMemoryChatAttachmentStore {
    return new InMemoryChatAttachmentStoreImplementation(options);
}

function synchronousPromise<T>(operation: () => T): Promise<T> {
    try {
        return Promise.resolve(operation());
    } catch (error) {
        return Promise.reject(
            error instanceof Error
                ? error
                : new Error("Synchronous attachment operation failed", { cause: error })
        );
    }
}
