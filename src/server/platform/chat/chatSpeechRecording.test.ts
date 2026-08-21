import { describe, expect, test } from "bun:test";

import {
    ChatSpeechRecordingValidationError,
    validateChatSpeechRecording,
} from "./chatSpeechRecording.ts";

function join(...parts: readonly Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.byteLength;
    }
    return result;
}

function utf8(value: string): Uint8Array {
    return new TextEncoder().encode(value);
}

function bigEndian(value: number | bigint, length: number): Uint8Array {
    let remaining = BigInt(value);
    const result = new Uint8Array(length);
    for (let index = length - 1; index >= 0; index -= 1) {
        result[index] = Number(remaining & 0xffn);
        remaining >>= 8n;
    }
    return result;
}

function littleEndian(value: number | bigint, length: number): Uint8Array {
    return bigEndian(value, length).toReversed();
}

function ebmlSize(value: number): Uint8Array {
    for (let length = 1; length <= 4; length += 1) {
        if (value < 2 ** (7 * length) - 1) {
            const result = bigEndian(value, length);
            result[0] = result[0]! | (1 << (8 - length));
            return result;
        }
    }
    throw new Error("Test EBML payload is too large");
}

function ebmlElement(id: readonly number[], payload: Uint8Array): Uint8Array {
    return join(Uint8Array.from(id), ebmlSize(payload.byteLength), payload);
}

function ebmlUnsigned(value: number): Uint8Array {
    let length = 3;
    if (value <= 0xff) length = 1;
    else if (value <= 0xff_ff) length = 2;
    return bigEndian(value, length);
}

function representativeChromeWebm(
    clusterTimecode = 0,
    packetCount = 1,
    opusToc = 0
): Uint8Array {
    const info = ebmlElement(
        [0x15, 0x49, 0xa9, 0x66],
        ebmlElement([0x2a, 0xd7, 0xb1], ebmlUnsigned(1_000_000))
    );
    const trackEntry = ebmlElement(
        [0xae],
        join(
            ebmlElement([0xd7], Uint8Array.of(1)),
            ebmlElement([0x83], Uint8Array.of(2)),
            ebmlElement([0x86], utf8("A_OPUS"))
        )
    );
    const tracks = ebmlElement([0x16, 0x54, 0xae, 0x6b], trackEntry);
    const blocks = Array.from({ length: packetCount }, () =>
        ebmlElement([0xa3], Uint8Array.of(0x81, 0, 0, 0, opusToc))
    );
    const cluster = ebmlElement(
        [0x1f, 0x43, 0xb6, 0x75],
        join(ebmlElement([0xe7], ebmlUnsigned(clusterTimecode)), ...blocks)
    );
    return join(
        ebmlElement([0x1a, 0x45, 0xdf, 0xa3], new Uint8Array()),
        ebmlElement([0x18, 0x53, 0x80, 0x67], join(info, tracks, cluster))
    );
}

function oggPage(
    payload: Uint8Array,
    flags: number,
    granule: bigint,
    sequence: number
): Uint8Array {
    if (payload.byteLength >= 255) throw new Error("Test Ogg payload is too large");
    return join(
        utf8("OggS"),
        Uint8Array.of(0, flags),
        littleEndian(granule, 8),
        littleEndian(0x10_20_30_40, 4),
        littleEndian(sequence, 4),
        new Uint8Array(4),
        Uint8Array.of(1, payload.byteLength),
        payload
    );
}

interface OggFixtureOptions {
    readonly end?: boolean;
    readonly packetCount?: number;
    readonly reportedGranule?: bigint;
}

function representativeOggOpus(options: OggFixtureOptions = {}): Uint8Array {
    const packetCount = options.packetCount ?? 50;
    const opusHead = join(
        utf8("OpusHead"),
        Uint8Array.of(1, 1),
        littleEndian(312, 2),
        littleEndian(48_000, 4),
        new Uint8Array(3)
    );
    const pages = [oggPage(opusHead, 0x02, 0n, 0), oggPage(utf8("OpusTags"), 0, 0n, 1)];
    for (let index = 0; index < packetCount; index += 1) {
        const isFinal = index === packetCount - 1;
        pages.push(
            oggPage(
                Uint8Array.of(0x08),
                isFinal && options.end !== false ? 0x04 : 0,
                options.reportedGranule ?? 312n + BigInt(index + 1) * 960n,
                index + 2
            )
        );
    }
    return join(...pages);
}

function mp4Box(type: string, ...payload: readonly Uint8Array[]): Uint8Array {
    const body = join(...payload);
    return join(bigEndian(body.byteLength + 8, 4), utf8(type), body);
}

function fullBox(
    type: string,
    version: number,
    flags: number,
    ...payload: readonly Uint8Array[]
): Uint8Array {
    return mp4Box(
        type,
        Uint8Array.of(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff),
        ...payload
    );
}

function descriptor(tag: number, payload: Uint8Array): Uint8Array {
    if (payload.byteLength >= 128) throw new Error("Test descriptor is too large");
    return join(Uint8Array.of(tag, payload.byteLength), payload);
}

function aacElementaryStreamDescriptor(
    audioSpecificConfig = 0x12,
    audioSpecificConfigSecondByte = 0x08
): Uint8Array {
    const configuration = descriptor(
        0x05,
        Uint8Array.of(audioSpecificConfig, audioSpecificConfigSecondByte)
    );
    const decoder = descriptor(
        0x04,
        join(
            Uint8Array.of(0x40, 0x15),
            new Uint8Array(3),
            new Uint8Array(4),
            new Uint8Array(4),
            configuration
        )
    );
    return descriptor(0x03, join(Uint8Array.of(0, 1, 0), decoder));
}

interface SafariFixtureOptions {
    readonly aacObjectTypeByte?: number;
    readonly decodeTime?: bigint;
    readonly duplicateFragmentDecodeTime?: boolean;
    readonly duplicateFragmentHeader?: boolean;
    readonly duplicateSampleTable?: boolean;
    readonly duplicateTrackExtends?: boolean;
    readonly initialSampleCount?: number;
    readonly mediaDuration?: number;
    readonly mediaTimescale?: number;
    readonly movieDuration?: number;
    readonly sampleCount?: number;
    readonly sampleDuration?: number;
    readonly trailingSampleDescriptionEntry?: boolean;
}

function aacSampleEntry(options: SafariFixtureOptions): Uint8Array {
    return mp4Box(
        "mp4a",
        new Uint8Array(6),
        bigEndian(1, 2),
        new Uint8Array(8),
        bigEndian(1, 2),
        bigEndian(16, 2),
        new Uint8Array(4),
        bigEndian(44_100 * 65_536, 4),
        fullBox(
            "esds",
            0,
            0,
            aacElementaryStreamDescriptor(options.aacObjectTypeByte ?? 0x12)
        )
    );
}

function representativeSafariFragmentedMp4(
    options: SafariFixtureOptions = {}
): Uint8Array {
    const sampleCount = options.sampleCount ?? 44;
    const sampleDuration = options.sampleDuration ?? 1024;
    const initialSampleCount = options.initialSampleCount ?? 0;
    const fileType = mp4Box("ftyp", utf8("M4A "), new Uint8Array(4), utf8("isomM4A "));
    const fragmentHeader = fullBox(
        "tfhd",
        0,
        0x02_00_10,
        bigEndian(1, 4),
        bigEndian(1, 4)
    );
    const fragmentDecodeTime = fullBox(
        "tfdt",
        1,
        0,
        bigEndian(options.decodeTime ?? 0n, 8)
    );
    const fragment = mp4Box(
        "moof",
        mp4Box(
            "traf",
            fragmentHeader,
            ...(options.duplicateFragmentHeader === true ? [fragmentHeader] : []),
            fragmentDecodeTime,
            ...(options.duplicateFragmentDecodeTime === true ? [fragmentDecodeTime] : []),
            fullBox(
                "trun",
                0,
                0x00_01_00,
                bigEndian(sampleCount, 4),
                ...Array.from({ length: sampleCount }, () => bigEndian(sampleDuration, 4))
            )
        )
    );
    const mediaData = mp4Box("mdat", new Uint8Array(sampleCount));
    const movie = (aliasedMediaOffset: number): Uint8Array => {
        const initialSampleTable =
            initialSampleCount === 0
                ? []
                : [
                      fullBox(
                          "stts",
                          0,
                          0,
                          bigEndian(1, 4),
                          bigEndian(initialSampleCount, 4),
                          bigEndian(sampleDuration, 4)
                      ),
                      fullBox(
                          "stsz",
                          0,
                          0,
                          bigEndian(1, 4),
                          bigEndian(initialSampleCount, 4)
                      ),
                      fullBox(
                          "stsc",
                          0,
                          0,
                          bigEndian(1, 4),
                          bigEndian(1, 4),
                          bigEndian(1, 4),
                          bigEndian(1, 4)
                      ),
                      fullBox(
                          "stco",
                          0,
                          0,
                          bigEndian(initialSampleCount, 4),
                          ...Array.from({ length: initialSampleCount }, () =>
                              bigEndian(aliasedMediaOffset, 4)
                          )
                      ),
                  ];
        const sampleEntry = aacSampleEntry(options);
        const sampleTable = mp4Box(
            "stbl",
            fullBox(
                "stsd",
                0,
                0,
                bigEndian(1, 4),
                sampleEntry,
                ...(options.trailingSampleDescriptionEntry === true ? [sampleEntry] : [])
            ),
            ...initialSampleTable
        );
        const media = mp4Box(
            "mdia",
            fullBox(
                "mdhd",
                0,
                0,
                new Uint8Array(8),
                bigEndian(options.mediaTimescale ?? 44_100, 4),
                bigEndian(options.mediaDuration ?? 0, 4),
                new Uint8Array(4)
            ),
            fullBox("hdlr", 0, 0, new Uint8Array(4), utf8("soun"), new Uint8Array(12)),
            mp4Box(
                "minf",
                sampleTable,
                ...(options.duplicateSampleTable === true ? [sampleTable] : [])
            )
        );
        const trackExtends = fullBox(
            "trex",
            0,
            0,
            bigEndian(1, 4),
            bigEndian(1, 4),
            bigEndian(sampleDuration, 4),
            bigEndian(1, 4),
            new Uint8Array(4)
        );
        return mp4Box(
            "moov",
            fullBox(
                "mvhd",
                0,
                0,
                new Uint8Array(8),
                bigEndian(1000, 4),
                bigEndian(options.movieDuration ?? 0, 4)
            ),
            mp4Box(
                "trak",
                fullBox("tkhd", 0, 3, new Uint8Array(8), bigEndian(1, 4)),
                media
            ),
            mp4Box(
                "mvex",
                trackExtends,
                ...(options.duplicateTrackExtends === true ? [trackExtends] : [])
            )
        );
    };
    const preliminaryMovie = movie(0);
    const mediaOffset =
        fileType.byteLength + preliminaryMovie.byteLength + fragment.byteLength + 8;
    return join(fileType, movie(mediaOffset), fragment, mediaData);
}

function representativeOrdinaryAacMp4(options: SafariFixtureOptions = {}): Uint8Array {
    const sampleCount = options.sampleCount ?? 44;
    const sampleDuration = options.sampleDuration ?? 1024;
    const mediaDuration = options.mediaDuration ?? sampleCount * sampleDuration;
    const sampleTable = mp4Box(
        "stbl",
        fullBox("stsd", 0, 0, bigEndian(1, 4), aacSampleEntry(options)),
        fullBox(
            "stts",
            0,
            0,
            bigEndian(1, 4),
            bigEndian(sampleCount, 4),
            bigEndian(sampleDuration, 4)
        ),
        fullBox("stsz", 0, 0, bigEndian(1, 4), bigEndian(sampleCount, 4))
    );
    const media = mp4Box(
        "mdia",
        fullBox(
            "mdhd",
            0,
            0,
            new Uint8Array(8),
            bigEndian(options.mediaTimescale ?? 44_100, 4),
            bigEndian(mediaDuration, 4),
            new Uint8Array(4)
        ),
        fullBox("hdlr", 0, 0, new Uint8Array(4), utf8("soun"), new Uint8Array(12)),
        mp4Box("minf", sampleTable)
    );
    return join(
        mp4Box("ftyp", utf8("M4A "), new Uint8Array(4), utf8("isomM4A ")),
        mp4Box(
            "moov",
            fullBox(
                "mvhd",
                0,
                0,
                new Uint8Array(8),
                bigEndian(1000, 4),
                bigEndian(options.movieDuration ?? mediaDuration, 4)
            ),
            mp4Box(
                "trak",
                fullBox("tkhd", 0, 3, new Uint8Array(8), bigEndian(1, 4)),
                media
            )
        ),
        mp4Box("mdat", new Uint8Array(sampleCount))
    );
}

function expectReason(run: () => unknown, reason: string): void {
    try {
        run();
        throw new Error("Expected recording validation to fail");
    } catch (error: unknown) {
        expect(error).toBeInstanceOf(ChatSpeechRecordingValidationError);
        expect(error).toMatchObject({ reason });
    }
}

describe("chat speech recording validation", () => {
    test("accepts representative Chrome WebM and Ogg Opus recordings", () => {
        expect(
            validateChatSpeechRecording(
                representativeChromeWebm(),
                "audio/webm;codecs=opus"
            )
        ).toMatchObject({ durationMs: 10, fileName: "recording.webm" });
        expect(
            validateChatSpeechRecording(representativeOggOpus(), "audio/ogg;codecs=opus")
        ).toMatchObject({ durationMs: 1000, fileName: "recording.ogg" });
    });

    test("accepts representative ordinary and Safari fragmented AAC MP4", () => {
        const fragmentedRecording = representativeSafariFragmentedMp4();
        for (const contentType of ["audio/mp4;codecs=mp4a.40.2", "audio/mp4"] as const) {
            expect(
                validateChatSpeechRecording(fragmentedRecording, contentType)
            ).toMatchObject({
                contentType,
                durationMs: 1022,
                fileName: "recording.m4a",
            });
        }
        expect(
            validateChatSpeechRecording(representativeOrdinaryAacMp4(), "audio/mp4")
        ).toMatchObject({ durationMs: 1022, fileName: "recording.m4a" });
    });

    test("rejects spoofed MIME, unsupported AAC object types, video-like and overlong timing", () => {
        expectReason(
            () => validateChatSpeechRecording(representativeChromeWebm(), "video/webm"),
            "mime"
        );
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeSafariFragmentedMp4({ aacObjectTypeByte: 0x2a }),
                    "audio/mp4"
                ),
            "format"
        );
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeChromeWebm(120_001),
                    "audio/webm;codecs=opus"
                ),
            "duration"
        );
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeSafariFragmentedMp4({ sampleCount: 6000 }),
                    "audio/mp4"
                ),
            "duration"
        );
    });

    test("rejects Ogg streams without a final page or with excessive duration", () => {
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeOggOpus({ end: false }),
                    "audio/ogg;codecs=opus"
                ),
            "format"
        );
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeOggOpus({ packetCount: 6051 }),
                    "audio/ogg;codecs=opus"
                ),
            "duration"
        );
    });

    test("rejects cumulative Opus duration hidden by falsified Ogg and WebM timestamps", () => {
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeOggOpus({
                        packetCount: 6051,
                        reportedGranule: 48_312n,
                    }),
                    "audio/ogg;codecs=opus"
                ),
            "duration"
        );
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeChromeWebm(0, 2001, 0x18),
                    "audio/webm;codecs=opus"
                ),
            "duration"
        );
    });

    test("prevents AAC duration bypasses through forged container timing metadata", () => {
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeOrdinaryAacMp4({
                        mediaDuration: 1,
                        movieDuration: 1,
                        sampleCount: 6000,
                    }),
                    "audio/mp4"
                ),
            "duration"
        );
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeOrdinaryAacMp4({ mediaTimescale: 1_000_000 }),
                    "audio/mp4"
                ),
            "format"
        );
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeSafariFragmentedMp4({
                        decodeTime: 0n,
                        mediaDuration: 1,
                        movieDuration: 1,
                        sampleCount: 6000,
                    }),
                    "audio/mp4"
                ),
            "duration"
        );
        expect(
            validateChatSpeechRecording(
                representativeSafariFragmentedMp4({ sampleDuration: 1 }),
                "audio/mp4"
            )
        ).toMatchObject({ durationMs: 1022 });
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeSafariFragmentedMp4({
                        mediaTimescale: 1_000_000,
                    }),
                    "audio/mp4"
                ),
            "format"
        );
    });

    test("rejects fragmented AAC with an aliased nonempty initial sample inventory", () => {
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeSafariFragmentedMp4({ initialSampleCount: 6000 }),
                    "audio/mp4"
                ),
            "format"
        );
    });

    test("rejects fragmented AAC with duplicate sibling sample tables", () => {
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeSafariFragmentedMp4({ duplicateSampleTable: true }),
                    "audio/mp4"
                ),
            "format"
        );
    });

    test("rejects fragmented AAC with duplicate fragment headers or decode times", () => {
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeSafariFragmentedMp4({ duplicateFragmentHeader: true }),
                    "audio/mp4"
                ),
            "format"
        );
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeSafariFragmentedMp4({
                        duplicateFragmentDecodeTime: true,
                    }),
                    "audio/mp4"
                ),
            "format"
        );
    });

    test("rejects fragmented AAC with duplicate matching track defaults", () => {
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeSafariFragmentedMp4({ duplicateTrackExtends: true }),
                    "audio/mp4"
                ),
            "format"
        );
    });

    test("rejects AAC with a trailing undeclared sample-description entry", () => {
        expectReason(
            () =>
                validateChatSpeechRecording(
                    representativeSafariFragmentedMp4({
                        trailingSampleDescriptionEntry: true,
                    }),
                    "audio/mp4"
                ),
            "format"
        );
    });
});
