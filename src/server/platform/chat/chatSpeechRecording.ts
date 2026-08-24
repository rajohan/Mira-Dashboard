import {
    chatSpeechLimits,
    chatSpeechRecordingContentTypes,
} from "../../../contracts/chatSpeech.ts";

export type ChatSpeechRecordingContentType =
    (typeof chatSpeechRecordingContentTypes)[number];

export interface ValidatedChatSpeechRecording {
    readonly bytes: Uint8Array;
    readonly contentType: ChatSpeechRecordingContentType;
    readonly durationMs: number;
    readonly fileName: "recording.m4a" | "recording.ogg" | "recording.webm";
}

export class ChatSpeechRecordingValidationError extends Error {
    readonly reason: "duration" | "format" | "mime" | "size";

    constructor(reason: ChatSpeechRecordingValidationError["reason"]) {
        super("Chat speech recording is invalid");
        this.name = "ChatSpeechRecordingValidationError";
        this.reason = reason;
    }
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function ascii(bytes: Uint8Array, start: number, end: number): string {
    try {
        return textDecoder.decode(bytes.subarray(start, end));
    } catch {
        throw new ChatSpeechRecordingValidationError("format");
    }
}

function checkedDuration(durationMs: number): number {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    if (durationMs > chatSpeechLimits.maximumRecordingDurationMs) {
        throw new ChatSpeechRecordingValidationError("duration");
    }
    return Math.ceil(durationMs);
}

function readUnsignedBigEndian(bytes: Uint8Array, start: number, length: number): bigint {
    if (length < 1 || start < 0 || start + length > bytes.byteLength) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    let value = 0n;
    for (let index = start; index < start + length; index += 1) {
        value = (value << 8n) | BigInt(bytes[index]!);
    }
    return value;
}

function readUnsignedLittleEndian(
    bytes: Uint8Array,
    start: number,
    length: number
): bigint {
    if (length < 1 || start < 0 || start + length > bytes.byteLength) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    let value = 0n;
    for (let index = length - 1; index >= 0; index -= 1) {
        value = (value << 8n) | BigInt(bytes[start + index]!);
    }
    return value;
}

function safeNumber(value: bigint): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    return Number(value);
}

function joinedPacket(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
    const packet = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
        packet.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return packet;
}

function oggOpusDurationMs(bytes: Uint8Array): number {
    let offset = 0;
    let streamSerial: number | undefined;
    let expectedSequence = 0;
    let preSkip: number | undefined;
    let latestGranule: bigint | undefined;
    let packetChunks: Uint8Array[] = [];
    let packetByteLength = 0;
    let packetIndex = 0;
    let encodedDurationMs = 0;
    let lastAudioPacketDurationMs = 0;
    let sawEnd = false;
    while (offset < bytes.byteLength) {
        if (
            offset + 27 > bytes.byteLength ||
            ascii(bytes, offset, offset + 4) !== "OggS" ||
            bytes[offset + 4] !== 0
        ) {
            throw new ChatSpeechRecordingValidationError("format");
        }
        const headerType = bytes[offset + 5]!;
        const granule = readUnsignedLittleEndian(bytes, offset + 6, 8);
        const serial = safeNumber(readUnsignedLittleEndian(bytes, offset + 14, 4));
        const sequence = safeNumber(readUnsignedLittleEndian(bytes, offset + 18, 4));
        const segmentCount = bytes[offset + 26]!;
        const segmentTableEnd = offset + 27 + segmentCount;
        if (segmentTableEnd > bytes.byteLength) {
            throw new ChatSpeechRecordingValidationError("format");
        }
        let payloadBytes = 0;
        for (let index = offset + 27; index < segmentTableEnd; index += 1) {
            payloadBytes += bytes[index]!;
        }
        const pageEnd = segmentTableEnd + payloadBytes;
        if (pageEnd > bytes.byteLength) {
            throw new ChatSpeechRecordingValidationError("format");
        }
        if (streamSerial === undefined) {
            if (
                (headerType & 0x02) === 0 ||
                (headerType & 0x01) !== 0 ||
                sequence !== 0
            ) {
                throw new ChatSpeechRecordingValidationError("format");
            }
            streamSerial = serial;
        } else if (
            serial !== streamSerial ||
            sequence !== expectedSequence ||
            (headerType & 0x02) !== 0 ||
            ((headerType & 0x01) !== 0) !== packetByteLength > 0
        ) {
            throw new ChatSpeechRecordingValidationError("format");
        }
        expectedSequence = sequence + 1;
        if (granule !== 0xff_ff_ff_ff_ff_ff_ff_ffn) {
            if (latestGranule !== undefined && granule < latestGranule) {
                throw new ChatSpeechRecordingValidationError("format");
            }
            latestGranule = granule;
        }
        let payloadOffset = segmentTableEnd;
        for (let index = offset + 27; index < segmentTableEnd; index += 1) {
            const segmentLength = bytes[index]!;
            const segmentEnd = payloadOffset + segmentLength;
            if (segmentLength > 0) {
                packetChunks.push(bytes.subarray(payloadOffset, segmentEnd));
                packetByteLength += segmentLength;
            }
            payloadOffset = segmentEnd;
            if (segmentLength === 255) continue;
            const packet = joinedPacket(packetChunks, packetByteLength);
            packetChunks = [];
            packetByteLength = 0;
            if (packetIndex === 0) {
                if (
                    packet.byteLength < 19 ||
                    ascii(packet, 0, 8) !== "OpusHead" ||
                    packet[8] !== 1 ||
                    (packet[9] ?? 0) < 1 ||
                    (packet[9] ?? 0) > 8
                ) {
                    throw new ChatSpeechRecordingValidationError("format");
                }
                preSkip = safeNumber(readUnsignedLittleEndian(packet, 10, 2));
                if (preSkip > 3840) {
                    throw new ChatSpeechRecordingValidationError("format");
                }
            } else if (packetIndex === 1) {
                if (packet.byteLength < 8 || ascii(packet, 0, 8) !== "OpusTags") {
                    throw new ChatSpeechRecordingValidationError("format");
                }
            } else {
                lastAudioPacketDurationMs = opusPacketDurationMs(packet);
                encodedDurationMs += lastAudioPacketDurationMs;
                const maximumEncodedDurationMs =
                    chatSpeechLimits.maximumRecordingDurationMs +
                    (preSkip ?? 0) / 48 +
                    120;
                if (encodedDurationMs > maximumEncodedDurationMs) {
                    throw new ChatSpeechRecordingValidationError("duration");
                }
            }
            packetIndex += 1;
        }
        if ((headerType & 0x04) !== 0) {
            if (pageEnd !== bytes.byteLength || packetByteLength !== 0) {
                throw new ChatSpeechRecordingValidationError("format");
            }
            sawEnd = true;
        }
        offset = pageEnd;
    }
    if (
        !sawEnd ||
        preSkip === undefined ||
        latestGranule === undefined ||
        packetByteLength !== 0 ||
        packetIndex < 3 ||
        encodedDurationMs <= 0
    ) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const decodedSamples = latestGranule - BigInt(preSkip);
    if (decodedSamples <= 0n) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const reportedDurationMs = (safeNumber(decodedSamples) * 1000) / 48_000;
    if (
        reportedDurationMs > encodedDurationMs + 1 ||
        encodedDurationMs - reportedDurationMs >
            lastAudioPacketDurationMs + preSkip / 48 + 1
    ) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    checkedDuration(reportedDurationMs);
    return checkedDuration(
        Math.min(encodedDurationMs, chatSpeechLimits.maximumRecordingDurationMs)
    );
}

interface EbmlVint {
    readonly length: number;
    readonly unknown: boolean;
    readonly value: number;
}

function readEbmlVint(
    bytes: Uint8Array,
    offset: number,
    retainLengthMarker: boolean
): EbmlVint {
    const first = bytes[offset];
    if (first === undefined || first === 0) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    let length = 1;
    let marker = 0x80;
    while ((first & marker) === 0) {
        length += 1;
        marker >>= 1;
    }
    if (length > 8 || offset + length > bytes.byteLength) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    let value = BigInt(retainLengthMarker ? first : first & (marker - 1));
    let unknown = !retainLengthMarker && (first & (marker - 1)) === marker - 1;
    for (let index = 1; index < length; index += 1) {
        const next = bytes[offset + index]!;
        value = (value << 8n) | BigInt(next);
        unknown = unknown && next === 0xff;
    }
    return { length, unknown, value: safeNumber(value) };
}

interface EbmlElement {
    readonly dataEnd: number;
    readonly dataStart: number;
    readonly id: number;
    readonly next: number;
    readonly unknownSize: boolean;
}

function readEbmlElement(
    bytes: Uint8Array,
    offset: number,
    parentEnd: number
): EbmlElement {
    const id = readEbmlVint(bytes, offset, true);
    if (id.length > 4) throw new ChatSpeechRecordingValidationError("format");
    const size = readEbmlVint(bytes, offset + id.length, false);
    const dataStart = offset + id.length + size.length;
    const dataEnd = size.unknown ? parentEnd : dataStart + size.value;
    if (dataEnd < dataStart || dataEnd > parentEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    return {
        dataEnd,
        dataStart,
        id: id.value,
        next: dataEnd,
        unknownSize: size.unknown,
    };
}

function ebmlUnsigned(bytes: Uint8Array, element: EbmlElement): number {
    const length = element.dataEnd - element.dataStart;
    if (element.unknownSize || length < 1 || length > 8) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    return safeNumber(readUnsignedBigEndian(bytes, element.dataStart, length));
}

function opusPacketDurationMs(packet: Uint8Array): number {
    const toc = packet[0];
    if (toc === undefined) throw new ChatSpeechRecordingValidationError("format");
    const configuration = toc >> 3;
    let frameDurationMs: number;
    if (configuration < 12) {
        frameDurationMs = [10, 20, 40, 60][configuration % 4]!;
    } else if (configuration < 16) {
        frameDurationMs = [10, 20][configuration % 2]!;
    } else {
        frameDurationMs = [2.5, 5, 10, 20][configuration % 4]!;
    }
    const countCode = toc & 0x03;
    let frames: number;
    if (countCode === 0) {
        frames = 1;
    } else if (countCode === 1 || countCode === 2) {
        frames = 2;
    } else {
        frames = (packet[1] ?? 0) & 0x3f;
    }
    const duration = frameDurationMs * frames;
    if (frames < 1 || duration > 120) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    return duration;
}

interface WebmTrack {
    readonly codec: string;
    readonly number: number;
    readonly type: number;
}

function webmTracks(bytes: Uint8Array, tracks: EbmlElement): readonly WebmTrack[] {
    const result: WebmTrack[] = [];
    let cursor = tracks.dataStart;
    while (cursor < tracks.dataEnd) {
        const entry = readEbmlElement(bytes, cursor, tracks.dataEnd);
        if (entry.unknownSize) throw new ChatSpeechRecordingValidationError("format");
        cursor = entry.next;
        if (entry.id !== 0xae) continue;
        let childCursor = entry.dataStart;
        let codec: string | undefined;
        let number: number | undefined;
        let type: number | undefined;
        while (childCursor < entry.dataEnd) {
            const child = readEbmlElement(bytes, childCursor, entry.dataEnd);
            if (child.unknownSize) {
                throw new ChatSpeechRecordingValidationError("format");
            }
            childCursor = child.next;
            if (child.id === 0x86) {
                codec = ascii(bytes, child.dataStart, child.dataEnd);
            } else if (child.id === 0xd7) {
                number = ebmlUnsigned(bytes, child);
            } else if (child.id === 0x83) {
                type = ebmlUnsigned(bytes, child);
            }
        }
        if (codec !== undefined && number !== undefined && type !== undefined) {
            result.push({ codec, number, type });
        }
    }
    return result;
}

interface WebmBlockTiming {
    readonly packetDurationMs: number;
    readonly relativeTimecode: number;
    readonly trackNumber: number;
}

function webmBlock(bytes: Uint8Array, element: EbmlElement): WebmBlockTiming {
    if (element.unknownSize) throw new ChatSpeechRecordingValidationError("format");
    const track = readEbmlVint(bytes, element.dataStart, false);
    const headerStart = element.dataStart + track.length;
    if (headerStart + 3 > element.dataEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const unsignedTimecode = (bytes[headerStart]! << 8) | bytes[headerStart + 1]!;
    const relativeTimecode =
        unsignedTimecode >= 0x80_00 ? unsignedTimecode - 0x1_00_00 : unsignedTimecode;
    const flags = bytes[headerStart + 2]!;
    if ((flags & 0x06) !== 0) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const packet = bytes.subarray(headerStart + 3, element.dataEnd);
    return {
        packetDurationMs: opusPacketDurationMs(packet),
        relativeTimecode,
        trackNumber: track.value,
    };
}

function webmBlockGroup(bytes: Uint8Array, group: EbmlElement): WebmBlockTiming[] {
    if (group.unknownSize) throw new ChatSpeechRecordingValidationError("format");
    const blocks: WebmBlockTiming[] = [];
    let cursor = group.dataStart;
    while (cursor < group.dataEnd) {
        const child = readEbmlElement(bytes, cursor, group.dataEnd);
        cursor = child.next;
        if (child.id === 0xa1) blocks.push(webmBlock(bytes, child));
    }
    return blocks;
}

function webmClusterBlocks(
    bytes: Uint8Array,
    cluster: EbmlElement
): Readonly<{ readonly clusterTimecode: number; readonly timing: WebmBlockTiming }[]> {
    if (cluster.unknownSize) throw new ChatSpeechRecordingValidationError("format");
    let clusterTimecode: number | undefined;
    const timings: WebmBlockTiming[] = [];
    let cursor = cluster.dataStart;
    while (cursor < cluster.dataEnd) {
        const child = readEbmlElement(bytes, cursor, cluster.dataEnd);
        cursor = child.next;
        if (child.id === 0xe7) clusterTimecode = ebmlUnsigned(bytes, child);
        else if (child.id === 0xa3) timings.push(webmBlock(bytes, child));
        else if (child.id === 0xa0) timings.push(...webmBlockGroup(bytes, child));
    }
    if (clusterTimecode === undefined || timings.length === 0) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    return timings.map((timing) => ({ clusterTimecode, timing }));
}

function webmOpusDurationMs(bytes: Uint8Array): number {
    const header = readEbmlElement(bytes, 0, bytes.byteLength);
    if (header.id !== 0x1a_45_df_a3 || header.unknownSize) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const segment = readEbmlElement(bytes, header.next, bytes.byteLength);
    if (segment.id !== 0x18_53_80_67 || segment.next !== bytes.byteLength) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    let timecodeScale = 1_000_000;
    let tracks: readonly WebmTrack[] = [];
    const blocks: {
        readonly clusterTimecode: number;
        readonly timing: WebmBlockTiming;
    }[] = [];
    let cursor = segment.dataStart;
    while (cursor < segment.dataEnd) {
        const child = readEbmlElement(bytes, cursor, segment.dataEnd);
        if (child.unknownSize) {
            throw new ChatSpeechRecordingValidationError("format");
        }
        cursor = child.next;
        if (child.id === 0x15_49_a9_66) {
            let infoCursor = child.dataStart;
            while (infoCursor < child.dataEnd) {
                const info = readEbmlElement(bytes, infoCursor, child.dataEnd);
                infoCursor = info.next;
                if (info.id === 0x2a_d7_b1) timecodeScale = ebmlUnsigned(bytes, info);
            }
        } else if (child.id === 0x16_54_ae_6b) {
            tracks = webmTracks(bytes, child);
        } else if (child.id === 0x1f_43_b6_75) {
            blocks.push(...webmClusterBlocks(bytes, child));
        }
    }
    const audioTracks = tracks.filter(({ type }) => type === 2);
    if (
        tracks.some(({ type }) => type === 1) ||
        audioTracks.length !== 1 ||
        audioTracks[0]!.codec !== "A_OPUS" ||
        timecodeScale < 1 ||
        timecodeScale > 1_000_000_000 ||
        blocks.length === 0
    ) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const audioTrackNumber = audioTracks[0]!.number;
    let maximumEndMs = 0;
    let encodedDurationMs = 0;
    for (const { clusterTimecode, timing } of blocks) {
        if (timing.trackNumber !== audioTrackNumber) continue;
        const absoluteTimecode = clusterTimecode + timing.relativeTimecode;
        if (absoluteTimecode < 0) {
            throw new ChatSpeechRecordingValidationError("format");
        }
        const endMs =
            (absoluteTimecode * timecodeScale) / 1_000_000 + timing.packetDurationMs;
        maximumEndMs = Math.max(maximumEndMs, endMs);
        encodedDurationMs += timing.packetDurationMs;
        if (encodedDurationMs > chatSpeechLimits.maximumRecordingDurationMs) {
            throw new ChatSpeechRecordingValidationError("duration");
        }
    }
    if (encodedDurationMs <= 0) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    checkedDuration(maximumEndMs);
    return checkedDuration(
        Math.max(
            maximumEndMs,
            Math.min(encodedDurationMs, chatSpeechLimits.maximumRecordingDurationMs)
        )
    );
}

interface Mp4Box {
    readonly dataEnd: number;
    readonly dataStart: number;
    readonly next: number;
    readonly type: string;
}

function readMp4Box(bytes: Uint8Array, offset: number, parentEnd: number): Mp4Box {
    if (offset + 8 > parentEnd) throw new ChatSpeechRecordingValidationError("format");
    let size = safeNumber(readUnsignedBigEndian(bytes, offset, 4));
    const type = ascii(bytes, offset + 4, offset + 8);
    let headerBytes = 8;
    if (size === 1) {
        if (offset + 16 > parentEnd) {
            throw new ChatSpeechRecordingValidationError("format");
        }
        size = safeNumber(readUnsignedBigEndian(bytes, offset + 8, 8));
        headerBytes = 16;
    } else if (size === 0) {
        size = parentEnd - offset;
    }
    if (size < headerBytes || offset + size > parentEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    return {
        dataEnd: offset + size,
        dataStart: offset + headerBytes,
        next: offset + size,
        type,
    };
}

function childMp4Boxes(bytes: Uint8Array, start: number, end: number): Mp4Box[] {
    const boxes: Mp4Box[] = [];
    let cursor = start;
    while (cursor < end) {
        const box = readMp4Box(bytes, cursor, end);
        boxes.push(box);
        cursor = box.next;
    }
    return boxes;
}

function findUniqueMp4Box(boxes: readonly Mp4Box[], type: string): Mp4Box | undefined {
    let match: Mp4Box | undefined;
    for (const box of boxes) {
        if (box.type !== type) continue;
        if (match !== undefined) {
            throw new ChatSpeechRecordingValidationError("format");
        }
        match = box;
    }
    return match;
}

function findMp4Child(
    bytes: Uint8Array,
    parent: Mp4Box,
    type: string
): Mp4Box | undefined {
    return findUniqueMp4Box(childMp4Boxes(bytes, parent.dataStart, parent.dataEnd), type);
}

function mp4FullBoxVersion(bytes: Uint8Array, box: Mp4Box): number {
    if (box.dataStart + 4 > box.dataEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    return bytes[box.dataStart]!;
}

function mp4FullBoxFlags(bytes: Uint8Array, box: Mp4Box): number {
    if (box.dataStart + 4 > box.dataEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    return (
        (bytes[box.dataStart + 1]! << 16) |
        (bytes[box.dataStart + 2]! << 8) |
        bytes[box.dataStart + 3]!
    );
}

interface Mp4Descriptor {
    readonly dataEnd: number;
    readonly dataStart: number;
    readonly next: number;
    readonly tag: number;
}

function readMp4Descriptor(
    bytes: Uint8Array,
    offset: number,
    parentEnd: number
): Mp4Descriptor {
    const tag = bytes[offset];
    if (tag === undefined) throw new ChatSpeechRecordingValidationError("format");
    let cursor = offset + 1;
    let size = 0;
    let terminated = false;
    for (let index = 0; index < 4; index += 1) {
        const value = bytes[cursor];
        if (value === undefined) throw new ChatSpeechRecordingValidationError("format");
        cursor += 1;
        size = size * 128 + (value & 0x7f);
        if ((value & 0x80) === 0) {
            terminated = true;
            break;
        }
    }
    if (!terminated || cursor + size > parentEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    return {
        dataEnd: cursor + size,
        dataStart: cursor,
        next: cursor + size,
        tag,
    };
}

interface Mp4AacConfiguration {
    readonly channelCount: 1 | 2;
    readonly sampleRate: number;
    readonly samplesPerAccessUnit: 960 | 1024;
}

const aacSampleRates = Object.freeze([
    96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000,
    11_025, 8000, 7350,
]);

function mp4aAacLowComplexityConfiguration(
    bytes: Uint8Array,
    sampleEntry: Mp4Box
): Mp4AacConfiguration | undefined {
    if (sampleEntry.dataStart + 28 > sampleEntry.dataEnd) return undefined;
    const sampleEntryVersion = safeNumber(
        readUnsignedBigEndian(bytes, sampleEntry.dataStart + 8, 2)
    );
    if (sampleEntryVersion !== 0) return undefined;
    const channelCount = safeNumber(
        readUnsignedBigEndian(bytes, sampleEntry.dataStart + 16, 2)
    );
    const fixedSampleRate = readUnsignedBigEndian(bytes, sampleEntry.dataStart + 24, 4);
    if (
        (channelCount !== 1 && channelCount !== 2) ||
        (fixedSampleRate & 0xff_ffn) !== 0n
    ) {
        return undefined;
    }
    const sampleRate = safeNumber(fixedSampleRate >> 16n);
    const elementaryStream = findUniqueMp4Box(
        childMp4Boxes(bytes, sampleEntry.dataStart + 28, sampleEntry.dataEnd),
        "esds"
    );
    if (
        elementaryStream === undefined ||
        elementaryStream.dataStart + 4 >= elementaryStream.dataEnd
    ) {
        return undefined;
    }
    const es = readMp4Descriptor(
        bytes,
        elementaryStream.dataStart + 4,
        elementaryStream.dataEnd
    );
    if (es.tag !== 0x03 || es.dataStart + 3 > es.dataEnd) return undefined;
    let cursor = es.dataStart + 3;
    const flags = bytes[es.dataStart + 2]!;
    if ((flags & 0x80) !== 0) cursor += 2;
    if ((flags & 0x40) !== 0) {
        const urlLength = bytes[cursor];
        if (urlLength === undefined) return undefined;
        cursor += 1 + urlLength;
    }
    if ((flags & 0x20) !== 0) cursor += 2;
    if (cursor >= es.dataEnd) return undefined;
    const decoder = readMp4Descriptor(bytes, cursor, es.dataEnd);
    if (
        decoder.tag !== 0x04 ||
        decoder.dataStart + 13 > decoder.dataEnd ||
        bytes[decoder.dataStart] !== 0x40
    ) {
        return undefined;
    }
    const configuration = readMp4Descriptor(
        bytes,
        decoder.dataStart + 13,
        decoder.dataEnd
    );
    if (
        configuration.tag !== 0x05 ||
        configuration.dataStart + 2 > configuration.dataEnd
    ) {
        return undefined;
    }
    const first = bytes[configuration.dataStart]!;
    const second = bytes[configuration.dataStart + 1]!;
    const audioObjectType = first >> 3;
    const sampleRateIndex = ((first & 0x07) << 1) | (second >> 7);
    const configuredSampleRate = aacSampleRates[sampleRateIndex];
    const channelConfiguration = (second >> 3) & 0x0f;
    if (
        audioObjectType !== 2 ||
        configuredSampleRate === undefined ||
        configuredSampleRate !== sampleRate ||
        channelConfiguration !== channelCount
    ) {
        return undefined;
    }
    return {
        channelCount,
        sampleRate,
        samplesPerAccessUnit: (second & 0x04) === 0 ? 1024 : 960,
    };
}

function mp4TrackId(bytes: Uint8Array, track: Mp4Box): number {
    const header = findMp4Child(bytes, track, "tkhd");
    if (header === undefined) throw new ChatSpeechRecordingValidationError("format");
    const version = mp4FullBoxVersion(bytes, header);
    let versionOffset = -1;
    if (version === 1) versionOffset = 20;
    else if (version === 0) versionOffset = 12;
    const offset = header.dataStart + versionOffset;
    if (offset < header.dataStart || offset + 4 > header.dataEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    return safeNumber(readUnsignedBigEndian(bytes, offset, 4));
}

interface Mp4AudioTrack {
    readonly duration: bigint;
    readonly id: number;
    readonly sampleRate: number;
    readonly sampleTable: Mp4Box;
    readonly samplesPerAccessUnit: 960 | 1024;
    readonly timescale: number;
}

interface Mp4SampleDefaults {
    readonly duration?: bigint;
    readonly size?: bigint;
}

function mp4DefaultSampleValues(
    bytes: Uint8Array,
    movie: Mp4Box,
    trackId: number
): Mp4SampleDefaults {
    const extendsMovie = findMp4Child(bytes, movie, "mvex");
    if (extendsMovie === undefined) return {};
    let matchingDefaults: Mp4SampleDefaults | undefined;
    for (const box of childMp4Boxes(
        bytes,
        extendsMovie.dataStart,
        extendsMovie.dataEnd
    )) {
        if (box.type !== "trex") continue;
        if (
            mp4FullBoxVersion(bytes, box) !== 0 ||
            mp4FullBoxFlags(bytes, box) !== 0 ||
            box.dataStart + 24 !== box.dataEnd
        ) {
            throw new ChatSpeechRecordingValidationError("format");
        }
        const candidateTrackId = safeNumber(
            readUnsignedBigEndian(bytes, box.dataStart + 4, 4)
        );
        if (candidateTrackId === trackId) {
            if (matchingDefaults !== undefined) {
                throw new ChatSpeechRecordingValidationError("format");
            }
            const duration = readUnsignedBigEndian(bytes, box.dataStart + 12, 4);
            const size = readUnsignedBigEndian(bytes, box.dataStart + 16, 4);
            matchingDefaults = {
                ...(duration === 0n ? {} : { duration }),
                ...(size === 0n ? {} : { size }),
            };
        }
    }
    return matchingDefaults ?? {};
}

interface Mp4FragmentHeader {
    readonly defaultSampleDuration?: bigint;
    readonly defaultSampleSize?: bigint;
    readonly trackId: number;
}

function mp4FragmentHeader(bytes: Uint8Array, box: Mp4Box): Mp4FragmentHeader {
    const flags = mp4FullBoxFlags(bytes, box);
    const knownFlags =
        0x00_00_01 | 0x00_00_02 | 0x00_00_08 | 0x00_00_10 | 0x00_00_20 | 0x02_00_00;
    if ((flags & ~knownFlags) !== 0 || box.dataStart + 8 > box.dataEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const trackId = safeNumber(readUnsignedBigEndian(bytes, box.dataStart + 4, 4));
    let cursor = box.dataStart + 8;
    if ((flags & 0x00_00_01) !== 0) cursor += 8;
    if ((flags & 0x00_00_02) !== 0) cursor += 4;
    let defaultSampleDuration: bigint | undefined;
    if ((flags & 0x00_00_08) !== 0) {
        defaultSampleDuration = readUnsignedBigEndian(bytes, cursor, 4);
        cursor += 4;
    }
    let defaultSampleSize: bigint | undefined;
    if ((flags & 0x00_00_10) !== 0) {
        defaultSampleSize = readUnsignedBigEndian(bytes, cursor, 4);
        cursor += 4;
    }
    if ((flags & 0x00_00_20) !== 0) cursor += 4;
    if (cursor !== box.dataEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    return {
        ...(defaultSampleDuration === undefined ? {} : { defaultSampleDuration }),
        ...(defaultSampleSize === undefined ? {} : { defaultSampleSize }),
        trackId,
    };
}

function mp4BaseDecodeTime(bytes: Uint8Array, box: Mp4Box): bigint {
    const version = mp4FullBoxVersion(bytes, box);
    let length = 0;
    if (version === 1) length = 8;
    else if (version === 0) length = 4;
    if (length === 0 || box.dataStart + 4 + length !== box.dataEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    return readUnsignedBigEndian(bytes, box.dataStart + 4, length);
}

interface Mp4SampleInventory {
    readonly byteLength: bigint;
    readonly count: number;
}

function checkedAacAccessUnitDurationMs(
    count: number,
    track: Pick<Mp4AudioTrack, "sampleRate" | "samplesPerAccessUnit">
): number {
    return checkedDuration(
        (count * track.samplesPerAccessUnit * 1000) / track.sampleRate
    );
}

function mp4RunInventory(
    bytes: Uint8Array,
    box: Mp4Box,
    defaults: Mp4SampleDefaults,
    track: Mp4AudioTrack
): Mp4SampleInventory {
    const flags = mp4FullBoxFlags(bytes, box);
    const knownFlags =
        0x00_00_01 | 0x00_00_04 | 0x00_01_00 | 0x00_02_00 | 0x00_04_00 | 0x00_08_00;
    if ((flags & ~knownFlags) !== 0 || box.dataStart + 8 > box.dataEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const sampleCount = safeNumber(readUnsignedBigEndian(bytes, box.dataStart + 4, 4));
    if (sampleCount < 1 || sampleCount > 1_000_000) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    checkedAacAccessUnitDurationMs(sampleCount, track);
    let cursor = box.dataStart + 8;
    if ((flags & 0x00_00_01) !== 0) cursor += 4;
    if ((flags & 0x00_00_04) !== 0) cursor += 4;
    const hasDurations = (flags & 0x00_01_00) !== 0;
    const bytesPerSample =
        (hasDurations ? 4 : 0) +
        ((flags & 0x00_02_00) === 0 ? 0 : 4) +
        ((flags & 0x00_04_00) === 0 ? 0 : 4) +
        ((flags & 0x00_08_00) === 0 ? 0 : 4);
    if (cursor + bytesPerSample * sampleCount !== box.dataEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const hasSizes = (flags & 0x00_02_00) !== 0;
    let byteLength = 0n;
    for (let index = 0; index < sampleCount; index += 1) {
        const sampleDuration = hasDurations
            ? readUnsignedBigEndian(bytes, cursor, 4)
            : defaults.duration;
        if (
            sampleDuration === undefined ||
            sampleDuration < 1n ||
            sampleDuration > BigInt(track.samplesPerAccessUnit)
        ) {
            throw new ChatSpeechRecordingValidationError("format");
        }
        if (hasDurations) cursor += 4;
        const sampleSize = hasSizes
            ? readUnsignedBigEndian(bytes, cursor, 4)
            : defaults.size;
        if (sampleSize === undefined || sampleSize < 1n) {
            throw new ChatSpeechRecordingValidationError("format");
        }
        byteLength += sampleSize;
        if (hasSizes) cursor += 4;
        if ((flags & 0x00_04_00) !== 0) cursor += 4;
        if ((flags & 0x00_08_00) !== 0) cursor += 4;
    }
    return { byteLength, count: sampleCount };
}

function mp4FragmentInventory(
    bytes: Uint8Array,
    fragments: readonly Mp4Box[],
    movie: Mp4Box,
    track: Mp4AudioTrack
): Mp4SampleInventory | undefined {
    const movieDefaults = mp4DefaultSampleValues(bytes, movie, track.id);
    let byteLength = 0n;
    let count = 0;
    let sawTrack = false;
    let previousBase: bigint | undefined;
    for (const fragment of fragments) {
        for (const fragmentTrack of childMp4Boxes(
            bytes,
            fragment.dataStart,
            fragment.dataEnd
        ).filter(({ type }) => type === "traf")) {
            const children = childMp4Boxes(
                bytes,
                fragmentTrack.dataStart,
                fragmentTrack.dataEnd
            );
            const headerBox = findUniqueMp4Box(children, "tfhd");
            const decodeTimeBox = findUniqueMp4Box(children, "tfdt");
            const runs = children.filter(({ type }) => type === "trun");
            if (headerBox === undefined) {
                throw new ChatSpeechRecordingValidationError("format");
            }
            const header = mp4FragmentHeader(bytes, headerBox);
            if (header.trackId !== track.id) {
                throw new ChatSpeechRecordingValidationError("format");
            }
            if (decodeTimeBox === undefined || runs.length === 0) {
                throw new ChatSpeechRecordingValidationError("format");
            }
            const base = mp4BaseDecodeTime(bytes, decodeTimeBox);
            if (previousBase !== undefined && base < previousBase) {
                throw new ChatSpeechRecordingValidationError("format");
            }
            previousBase = base;
            let fragmentCount = 0;
            for (const run of runs) {
                const inventory = mp4RunInventory(
                    bytes,
                    run,
                    {
                        duration: header.defaultSampleDuration ?? movieDefaults.duration,
                        size: header.defaultSampleSize ?? movieDefaults.size,
                    },
                    track
                );
                count += inventory.count;
                fragmentCount += inventory.count;
                byteLength += inventory.byteLength;
                checkedAacAccessUnitDurationMs(count, track);
            }
            if (fragmentCount < 1) {
                throw new ChatSpeechRecordingValidationError("format");
            }
            sawTrack = true;
        }
    }
    return sawTrack ? { byteLength, count } : undefined;
}

function mp4SampleTableInventory(
    bytes: Uint8Array,
    track: Mp4AudioTrack
): Mp4SampleInventory {
    const sampleSizes = findMp4Child(bytes, track.sampleTable, "stsz");
    const sampleTimes = findMp4Child(bytes, track.sampleTable, "stts");
    if (
        sampleSizes === undefined ||
        sampleTimes === undefined ||
        mp4FullBoxVersion(bytes, sampleSizes) !== 0 ||
        mp4FullBoxFlags(bytes, sampleSizes) !== 0 ||
        mp4FullBoxVersion(bytes, sampleTimes) !== 0 ||
        mp4FullBoxFlags(bytes, sampleTimes) !== 0 ||
        sampleSizes.dataStart + 12 > sampleSizes.dataEnd ||
        sampleTimes.dataStart + 8 > sampleTimes.dataEnd
    ) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const fixedSize = readUnsignedBigEndian(bytes, sampleSizes.dataStart + 4, 4);
    const count = safeNumber(readUnsignedBigEndian(bytes, sampleSizes.dataStart + 8, 4));
    if (count < 1 || count > 1_000_000) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    checkedAacAccessUnitDurationMs(count, track);
    const expectedSizeEnd =
        sampleSizes.dataStart + 12 + (fixedSize === 0n ? count * 4 : 0);
    if (expectedSizeEnd !== sampleSizes.dataEnd) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    let byteLength = fixedSize * BigInt(count);
    if (fixedSize === 0n) {
        byteLength = 0n;
        for (let index = 0; index < count; index += 1) {
            const size = readUnsignedBigEndian(
                bytes,
                sampleSizes.dataStart + 12 + index * 4,
                4
            );
            if (size < 1n) throw new ChatSpeechRecordingValidationError("format");
            byteLength += size;
        }
    }
    if (byteLength < 1n) throw new ChatSpeechRecordingValidationError("format");
    const timeEntryCount = safeNumber(
        readUnsignedBigEndian(bytes, sampleTimes.dataStart + 4, 4)
    );
    if (
        timeEntryCount < 1 ||
        timeEntryCount > count ||
        sampleTimes.dataStart + 8 + timeEntryCount * 8 !== sampleTimes.dataEnd
    ) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    let timedSamples = 0;
    let declaredDuration = 0n;
    for (let index = 0; index < timeEntryCount; index += 1) {
        const entryOffset = sampleTimes.dataStart + 8 + index * 8;
        const entrySamples = safeNumber(readUnsignedBigEndian(bytes, entryOffset, 4));
        const delta = readUnsignedBigEndian(bytes, entryOffset + 4, 4);
        if (
            entrySamples < 1 ||
            delta < 1n ||
            delta > BigInt(track.samplesPerAccessUnit)
        ) {
            throw new ChatSpeechRecordingValidationError("format");
        }
        timedSamples += entrySamples;
        declaredDuration += BigInt(entrySamples) * delta;
    }
    if (timedSamples !== count) throw new ChatSpeechRecordingValidationError("format");
    checkedDuration((safeNumber(declaredDuration) * 1000) / track.timescale);
    return { byteLength, count };
}

function assertEmptyMp4InitialSampleInventory(
    bytes: Uint8Array,
    track: Mp4AudioTrack
): void {
    const children = childMp4Boxes(
        bytes,
        track.sampleTable.dataStart,
        track.sampleTable.dataEnd
    );
    const sampleSizes = children.filter(({ type }) => type === "stsz");
    const sampleTimes = children.filter(({ type }) => type === "stts");
    if (
        children.some(({ type }) => type === "stz2") ||
        sampleSizes.length > 1 ||
        sampleTimes.length > 1
    ) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    if (sampleSizes.length === 0 && sampleTimes.length === 0) return;
    const sampleSize = sampleSizes[0];
    const sampleTime = sampleTimes[0];
    if (
        sampleSize === undefined ||
        sampleTime === undefined ||
        mp4FullBoxVersion(bytes, sampleSize) !== 0 ||
        mp4FullBoxFlags(bytes, sampleSize) !== 0 ||
        sampleSize.dataStart + 12 !== sampleSize.dataEnd ||
        readUnsignedBigEndian(bytes, sampleSize.dataStart + 4, 4) !== 0n ||
        readUnsignedBigEndian(bytes, sampleSize.dataStart + 8, 4) !== 0n ||
        mp4FullBoxVersion(bytes, sampleTime) !== 0 ||
        mp4FullBoxFlags(bytes, sampleTime) !== 0 ||
        sampleTime.dataStart + 8 !== sampleTime.dataEnd ||
        readUnsignedBigEndian(bytes, sampleTime.dataStart + 4, 4) !== 0n
    ) {
        throw new ChatSpeechRecordingValidationError("format");
    }
}

function mp4Track(bytes: Uint8Array, track: Mp4Box): Mp4AudioTrack | "video" {
    const media = findMp4Child(bytes, track, "mdia");
    if (media === undefined) throw new ChatSpeechRecordingValidationError("format");
    const handler = findMp4Child(bytes, media, "hdlr");
    const mediaHeader = findMp4Child(bytes, media, "mdhd");
    const mediaInformation = findMp4Child(bytes, media, "minf");
    if (
        handler === undefined ||
        mediaHeader === undefined ||
        mediaInformation === undefined ||
        handler.dataStart + 12 > handler.dataEnd
    ) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const handlerType = ascii(bytes, handler.dataStart + 8, handler.dataStart + 12);
    if (handlerType === "vide") return "video";
    if (handlerType !== "soun") throw new ChatSpeechRecordingValidationError("format");
    const sampleTable = findMp4Child(bytes, mediaInformation, "stbl");
    const sampleDescriptions =
        sampleTable === undefined ? undefined : findMp4Child(bytes, sampleTable, "stsd");
    if (
        sampleTable === undefined ||
        sampleDescriptions === undefined ||
        sampleDescriptions.dataStart + 16 > sampleDescriptions.dataEnd
    ) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const entryCount = safeNumber(
        readUnsignedBigEndian(bytes, sampleDescriptions.dataStart + 4, 4)
    );
    const firstEntry = readMp4Box(
        bytes,
        sampleDescriptions.dataStart + 8,
        sampleDescriptions.dataEnd
    );
    const configuration = mp4aAacLowComplexityConfiguration(bytes, firstEntry);
    if (
        entryCount !== 1 ||
        firstEntry.next !== sampleDescriptions.dataEnd ||
        firstEntry.type !== "mp4a" ||
        configuration === undefined
    ) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const version = mp4FullBoxVersion(bytes, mediaHeader);
    let versionOffset = -1;
    if (version === 1) versionOffset = 20;
    else if (version === 0) versionOffset = 12;
    const timescaleOffset = mediaHeader.dataStart + versionOffset;
    const durationOffset = timescaleOffset + 4;
    const durationBytes = version === 1 ? 8 : 4;
    if (
        timescaleOffset < mediaHeader.dataStart ||
        durationOffset + durationBytes > mediaHeader.dataEnd
    ) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const timescale = safeNumber(readUnsignedBigEndian(bytes, timescaleOffset, 4));
    if (timescale !== configuration.sampleRate) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const rawDuration = readUnsignedBigEndian(bytes, durationOffset, durationBytes);
    const unknownDuration =
        durationBytes === 8 ? 0xff_ff_ff_ff_ff_ff_ff_ffn : 0xff_ff_ff_ffn;
    return {
        duration: rawDuration === unknownDuration ? 0n : rawDuration,
        id: mp4TrackId(bytes, track),
        sampleRate: configuration.sampleRate,
        sampleTable,
        samplesPerAccessUnit: configuration.samplesPerAccessUnit,
        timescale,
    };
}

function mp4AacDurationMs(bytes: Uint8Array): number {
    const topLevel = childMp4Boxes(bytes, 0, bytes.byteLength);
    const fileType = findUniqueMp4Box(topLevel, "ftyp");
    const movie = findUniqueMp4Box(topLevel, "moov");
    if (
        fileType === undefined ||
        movie === undefined ||
        fileType.dataEnd - fileType.dataStart < 8
    ) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const brands = ascii(bytes, fileType.dataStart, fileType.dataEnd);
    if (!/(?:M4A |isom|iso[2456]|mp4[12])/u.test(brands)) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const parsedTracks = childMp4Boxes(bytes, movie.dataStart, movie.dataEnd)
        .filter(({ type }) => type === "trak")
        .map((track) => mp4Track(bytes, track));
    if (parsedTracks.includes("video")) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const audioTracks = parsedTracks.filter(
        (track): track is Mp4AudioTrack => track !== "video"
    );
    if (audioTracks.length !== 1) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const audio = audioTracks[0]!;
    const fragments = topLevel.filter(({ type }) => type === "moof");
    if (fragments.length > 0) {
        assertEmptyMp4InitialSampleInventory(bytes, audio);
    }
    const inventory =
        fragments.length === 0
            ? mp4SampleTableInventory(bytes, audio)
            : mp4FragmentInventory(bytes, fragments, movie, audio);
    if (inventory === undefined || inventory.count < 1 || inventory.byteLength < 1n) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    const mediaBytes = topLevel
        .filter(({ type }) => type === "mdat")
        .reduce((sum, box) => sum + BigInt(box.dataEnd - box.dataStart), 0n);
    if (mediaBytes !== inventory.byteLength) {
        throw new ChatSpeechRecordingValidationError("format");
    }
    if (audio.duration > 0n) {
        checkedDuration((safeNumber(audio.duration) * 1000) / audio.timescale);
    }
    return checkedAacAccessUnitDurationMs(inventory.count, audio);
}

/**
 * Sniffs one exact browser recorder format and derives its authoritative duration.
 * @param bytes Fully bounded request bytes.
 * @param contentType Exact declared recorder MIME.
 * @returns Validated ephemeral provider upload metadata.
 */
export function validateChatSpeechRecording(
    bytes: Uint8Array,
    contentType: string
): ValidatedChatSpeechRecording {
    if (
        bytes.byteLength < 1 ||
        bytes.byteLength > chatSpeechLimits.maximumRecordingBytes
    ) {
        throw new ChatSpeechRecordingValidationError("size");
    }
    if (contentType === "audio/webm;codecs=opus") {
        return {
            bytes,
            contentType,
            durationMs: webmOpusDurationMs(bytes),
            fileName: "recording.webm",
        };
    }
    if (contentType === "audio/ogg;codecs=opus") {
        return {
            bytes,
            contentType,
            durationMs: oggOpusDurationMs(bytes),
            fileName: "recording.ogg",
        };
    }
    if (contentType === "audio/mp4;codecs=mp4a.40.2" || contentType === "audio/mp4") {
        return {
            bytes,
            contentType,
            durationMs: mp4AacDurationMs(bytes),
            fileName: "recording.m4a",
        };
    }
    throw new ChatSpeechRecordingValidationError("mime");
}
