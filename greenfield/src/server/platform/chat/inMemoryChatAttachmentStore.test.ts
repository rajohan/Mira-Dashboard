/* Binary fixtures remain formatter-canonical hexadecimal values. */
/* oxlint-disable unicorn/number-literal-case, unicorn/numeric-separators-style */
import { describe, expect, test } from "bun:test";

import {
    chatAttachmentLimits,
    chatAttachmentSniffableMimeTypes,
    normalizeChatAttachmentMimeType,
} from "../../../contracts/chatMedia.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    ChatAttachmentStoreError,
    chatAttachmentBytesMatchMimeType,
    chatAttachmentZipMaximumEntries,
    chatAttachmentZipMaximumNameBytes,
    createInMemoryChatAttachmentStore,
} from "./inMemoryChatAttachmentStore.ts";

const actorId = "actor-1";
const sessionKey = "agent:main:main";
const idempotencyKey = "A".repeat(32);
const ticketId = "00000000-0000-4000-8000-000000000001";
const pngAttachmentId = "00000000-0000-4000-8000-000000000002";
const textAttachmentId = "00000000-0000-4000-8000-000000000003";
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const text = new TextEncoder().encode("hello");

function zipWithLocalEntries(names: readonly string[]): Uint8Array {
    const encoder = new TextEncoder();
    let localOffset = 0;
    const entries = names.map((name) => {
        const encoded = encoder.encode(name);
        const local = new Uint8Array(30 + encoded.byteLength);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x0403_4b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(26, encoded.byteLength, true);
        local.set(encoded, 30);
        const central = new Uint8Array(46 + encoded.byteLength);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, 0x0201_4b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(28, encoded.byteLength, true);
        centralView.setUint32(42, localOffset, true);
        central.set(encoded, 46);
        const entry = { central, local };
        localOffset += local.byteLength;
        return entry;
    });
    const centralBytes = entries.reduce(
        (total, { central }) => total + central.byteLength,
        0
    );
    const output = new Uint8Array(localOffset + centralBytes + 22);
    let offset = 0;
    for (const { local } of entries) {
        output.set(local, offset);
        offset += local.byteLength;
    }
    for (const { central } of entries) {
        output.set(central, offset);
        offset += central.byteLength;
    }
    const end = new DataView(output.buffer, offset, 22);
    end.setUint32(0, 0x0605_4b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, centralBytes, true);
    end.setUint32(16, localOffset, true);
    return output;
}

function oleWithStream(name: string): Uint8Array {
    const magic = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const stream = Buffer.from(name, "utf16le");
    const output = new Uint8Array(magic.byteLength + stream.byteLength);
    output.set(magic);
    output.set(stream, magic.byteLength);
    return output;
}

function isoBmff(brand: string): Uint8Array {
    const bytes = new Uint8Array(12);
    bytes.set(new TextEncoder().encode("ftyp"), 4);
    bytes.set(new TextEncoder().encode(brand), 8);
    return bytes;
}

function fixtureStore(now: { value: number }) {
    const ids = [ticketId, pngAttachmentId, textAttachmentId];
    return createInMemoryChatAttachmentStore({
        createId: () => {
            const id = ids.shift();
            if (id === undefined) throw new Error("Fixture id budget exhausted");
            return id;
        },
        nowMs: () => now.value,
    });
}

const prepareInput = {
    files: [
        { fileName: "diagram.png", mimeType: "image/png", sizeBytes: png.length },
        { fileName: "notes.txt", mimeType: "text/plain", sizeBytes: text.length },
    ],
    idempotencyKey,
    sessionKey,
};

describe("in-memory chat attachment store", () => {
    test("binds tickets and uploads to exact actor/session/idempotency with exact replay", async () => {
        const now = { value: 1000 };
        const store = fixtureStore(now);
        const prepared = await store.prepare(prepareInput, actorId);
        expect(await store.prepare(prepareInput, actorId)).toBe(prepared);
        expect(prepared).toEqual({
            expiresAtMs: 301_000,
            ticketId,
            uploads: [
                {
                    attachmentId: pngAttachmentId,
                    uploadUrl: `/api/chat/attachments/${ticketId}/${pngAttachmentId}`,
                },
                {
                    attachmentId: textAttachmentId,
                    uploadUrl: `/api/chat/attachments/${ticketId}/${textAttachmentId}`,
                },
            ],
        });

        expect(
            await captureFailure(() =>
                store.upload({
                    actorId: "actor-2",
                    attachmentId: pngAttachmentId,
                    bytes: png,
                    contentType: "image/png",
                    ticketId,
                })
            )
        ).toEqual(new ChatAttachmentStoreError("forbidden"));
        expect(
            await captureFailure(() =>
                store.upload({
                    actorId,
                    attachmentId: pngAttachmentId,
                    bytes: text,
                    contentType: "image/png",
                    ticketId,
                })
            )
        ).toEqual(new ChatAttachmentStoreError("invalid"));

        await store.upload({
            actorId,
            attachmentId: pngAttachmentId,
            bytes: png,
            contentType: "image/png; charset=binary",
            ticketId,
        });
        await store.upload({
            actorId,
            attachmentId: textAttachmentId,
            bytes: text,
            contentType: "text/plain",
            ticketId,
        });
        await store.upload({
            actorId,
            attachmentId: pngAttachmentId,
            bytes: png,
            contentType: "image/png",
            ticketId,
        });
        expect(
            await captureFailure(() =>
                store.reserve({
                    actorId,
                    idempotencyKey,
                    sessionKey: "agent:main:other",
                    ticketId,
                })
            )
        ).toEqual(new ChatAttachmentStoreError("forbidden"));

        const reservation = await store.reserve({
            actorId,
            idempotencyKey,
            sessionKey,
            ticketId,
        });
        expect(
            await store.reserve({ actorId, idempotencyKey, sessionKey, ticketId })
        ).toBe(reservation);
        expect(reservation.attachments).toEqual([
            {
                content: Buffer.from(png).toString("base64"),
                fileName: "diagram.png",
                mimeType: "image/png",
                sizeBytes: png.length,
                type: "file",
            },
            {
                content: Buffer.from(text).toString("base64"),
                fileName: "notes.txt",
                mimeType: "text/plain",
                sizeBytes: text.length,
                type: "file",
            },
        ]);
        await reservation.release();
        const retryReservation = await store.reserve({
            actorId,
            idempotencyKey,
            sessionKey,
            ticketId,
        });
        expect(retryReservation).not.toBe(reservation);
        await retryReservation.commit();
        await retryReservation.commit();
        expect(
            await captureFailure(() =>
                store.reserve({ actorId, idempotencyKey, sessionKey, ticketId })
            )
        ).toEqual(new ChatAttachmentStoreError("conflict"));
        store.dispose();
    });

    test("holds reserved bytes past ticket TTL and fails process-loss recovery explicitly", async () => {
        const now = { value: 1000 };
        const store = fixtureStore(now);
        await store.prepare(prepareInput, actorId);
        await store.upload({
            actorId,
            attachmentId: pngAttachmentId,
            bytes: png,
            contentType: "image/png",
            ticketId,
        });
        await store.upload({
            actorId,
            attachmentId: textAttachmentId,
            bytes: text,
            contentType: "text/plain",
            ticketId,
        });
        const reservation = await store.reserve({
            actorId,
            idempotencyKey,
            sessionKey,
            ticketId,
        });

        now.value = 301_001;
        expect(
            await store.reserve({ actorId, idempotencyKey, sessionKey, ticketId })
        ).toBe(reservation);
        expect(reservation.attachments).toHaveLength(2);

        const restarted = createInMemoryChatAttachmentStore();
        expect(
            await captureFailure(() =>
                restarted.reserve({ actorId, idempotencyKey, sessionKey, ticketId })
            )
        ).toEqual(new ChatAttachmentStoreError("not-found"));
        store.dispose();
        restarted.dispose();
    });

    test("rejects videos and spoofed image bytes before dispatch", async () => {
        const now = { value: 1000 };
        const store = fixtureStore(now);
        expect(
            await captureFailure(() =>
                store.prepare(
                    {
                        files: [
                            {
                                fileName: "clip.mp4",
                                mimeType: "video/mp4",
                                sizeBytes: 8,
                            },
                        ],
                        idempotencyKey,
                        sessionKey,
                    },
                    actorId
                )
            )
        ).toEqual(new ChatAttachmentStoreError("invalid"));
        store.dispose();
    });

    test("distinguishes Office containers and rejects ambiguous ISO-BMFF audio", async () => {
        const docx = zipWithLocalEntries(["[Content_Types].xml", "word/document.xml"]);
        expect(
            chatAttachmentBytesMatchMimeType(
                docx,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            )
        ).toBe(true);
        expect(
            chatAttachmentBytesMatchMimeType(
                docx,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            )
        ).toBe(false);
        expect(
            chatAttachmentBytesMatchMimeType(
                zipWithLocalEntries(["arbitrary.txt"]),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            )
        ).toBe(false);

        const word = oleWithStream("WordDocument");
        expect(chatAttachmentBytesMatchMimeType(word, "application/msword")).toBe(true);
        expect(chatAttachmentBytesMatchMimeType(word, "application/vnd.ms-excel")).toBe(
            false
        );
        expect(
            chatAttachmentBytesMatchMimeType(word, "application/vnd.ms-powerpoint")
        ).toBe(false);

        const isoBmff = new Uint8Array(12);
        isoBmff.set(new TextEncoder().encode("ftypM4A "), 4);
        expect(chatAttachmentBytesMatchMimeType(isoBmff, "audio/mp4")).toBe(false);
        const store = createInMemoryChatAttachmentStore();
        expect(
            await captureFailure(() =>
                store.prepare(
                    {
                        files: [
                            {
                                fileName: "ambiguous.m4a",
                                mimeType: "audio/mp4",
                                sizeBytes: isoBmff.byteLength,
                            },
                        ],
                        idempotencyKey,
                        sessionKey,
                    },
                    actorId
                )
            )
        ).toEqual(new ChatAttachmentStoreError("invalid"));
        store.dispose();
    });

    test("bounds ZIP inspection work, entry count, and cumulative entry-name bytes", () => {
        const adversarial = new Uint8Array(chatAttachmentLimits.maximumFileBytes);
        expect(
            chatAttachmentBytesMatchMimeType(adversarial, "application/zip")
        ).toBeFalse();

        adversarial.set([0x50, 0x4b, 0x03, 0x04]);
        let populatedBytes = 4;
        while (populatedBytes < adversarial.byteLength) {
            const copyBytes = Math.min(
                populatedBytes,
                adversarial.byteLength - populatedBytes
            );
            adversarial.copyWithin(populatedBytes, 0, copyBytes);
            populatedBytes += copyBytes;
        }
        expect(
            chatAttachmentBytesMatchMimeType(
                adversarial,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            )
        ).toBeFalse();

        expect(
            chatAttachmentBytesMatchMimeType(
                zipWithLocalEntries(
                    Array.from(
                        { length: chatAttachmentZipMaximumEntries + 1 },
                        (_, index) => `entry-${index}`
                    )
                ),
                "application/zip"
            )
        ).toBeFalse();
        expect(
            chatAttachmentBytesMatchMimeType(
                zipWithLocalEntries(
                    Array.from(
                        {
                            length:
                                Math.floor(chatAttachmentZipMaximumNameBytes / 1024) + 1,
                        },
                        () => "a".repeat(1024)
                    )
                ),
                "application/zip"
            )
        ).toBeFalse();
    });

    test("keeps picker acceptance in parity with every sniffable raw format", () => {
        const fixtures = [
            ["application/msword", "document.doc", oleWithStream("WordDocument")],
            ["application/pdf", "document.pdf", new TextEncoder().encode("%PDF-1")],
            ["application/vnd.ms-excel", "sheet.xls", oleWithStream("Workbook")],
            [
                "application/vnd.ms-powerpoint",
                "slides.ppt",
                oleWithStream("PowerPoint Document"),
            ],
            [
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                "slides.pptx",
                zipWithLocalEntries(["[Content_Types].xml", "ppt/presentation.xml"]),
            ],
            [
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "sheet.xlsx",
                zipWithLocalEntries(["[Content_Types].xml", "xl/workbook.xml"]),
            ],
            [
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "document.docx",
                zipWithLocalEntries(["[Content_Types].xml", "word/document.xml"]),
            ],
            ["application/zip", "archive.zip", zipWithLocalEntries(["file.txt"])],
            ["audio/aac", "audio.aac", Uint8Array.from([0xff, 0xf0])],
            ["audio/flac", "audio.flac", new TextEncoder().encode("fLaC")],
            ["audio/mpeg", "audio.mp3", new TextEncoder().encode("ID3")],
            ["audio/ogg", "audio.ogg", new TextEncoder().encode("OggS")],
            ["audio/opus", "audio.opus", new TextEncoder().encode("OggS")],
            [
                "audio/wav",
                "audio.wav",
                Uint8Array.from([
                    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
                ]),
            ],
            ["image/avif", "image.avif", isoBmff("avif")],
            ["image/bmp", "image.bmp", new TextEncoder().encode("BM")],
            ["image/gif", "image.gif", new TextEncoder().encode("GIF89a")],
            ["image/heic", "image.heic", isoBmff("heic")],
            ["image/heif", "image.heif", isoBmff("mif1")],
            ["image/jpeg", "image.jpg", Uint8Array.from([0xff, 0xd8, 0xff])],
            ["image/png", "image.png", png],
            ["image/svg+xml", "image.svg", new TextEncoder().encode("<svg></svg>")],
            [
                "image/webp",
                "image.webp",
                Uint8Array.from([
                    0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
                ]),
            ],
        ] as const;

        expect(fixtures.map(([mimeType]) => mimeType)).toEqual([
            ...chatAttachmentSniffableMimeTypes,
        ]);
        for (const [mimeType, fileName, bytes] of fixtures) {
            expect(normalizeChatAttachmentMimeType(fileName, mimeType)).toBe(mimeType);
            expect(chatAttachmentBytesMatchMimeType(bytes, mimeType)).toBeTrue();
        }
        for (const [fileName, mimeType] of [
            ["scan.tiff", "image/tiff"],
            ["audio.bin", "audio/x-custom"],
        ] as const) {
            expect(normalizeChatAttachmentMimeType(fileName, mimeType)).toBeUndefined();
        }
        expect(
            chatAttachmentBytesMatchMimeType(
                new TextEncoder().encode('{"ok":true}'),
                normalizeChatAttachmentMimeType("data.json", "application/json")!
            )
        ).toBeTrue();
        expect(
            chatAttachmentBytesMatchMimeType(
                new TextEncoder().encode("hello"),
                normalizeChatAttachmentMimeType("notes.custom", "text/x-notes")!
            )
        ).toBeTrue();
    });
});
