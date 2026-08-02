import fs from "node:fs";
import path from "node:path";

import { unknownArray } from "../../lib/values.ts";

interface ChatHistoryPayload {
    sessionKey?: string;
    sessionId?: string;
    messages?: unknown[];
}

interface ChatImageBlockRecord {
    type?: string;
    data?: string;
    mimeType?: string;
}

interface RawTranscriptImageMessage {
    role: string;
    text: string;
    timestamp?: number;
    images: ChatImageBlockRecord[];
}

interface OpenClawTranscriptImageHydratorOptions {
    resolveOpenClawHome: () => string;
    resolveSessionId: (sessionKey: string) => string | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function hasImageBlockOmittedData(block: Record<string, unknown>): boolean {
    if (block.type !== "image") {
        return false;
    }
    if (typeof block.data === "string" && block.data.trim()) {
        return false;
    }
    const source = asRecord(block.source);
    return block.omitted === true || source?.omitted === true || !source?.data;
}

function normalizeTranscriptImageBlock(
    value: unknown
): ChatImageBlockRecord | undefined {
    const block = asRecord(value);
    if (block?.type !== "image") {
        return undefined;
    }
    const source = asRecord(block.source);
    let data = typeof source?.data === "string" ? source.data : undefined;
    if (typeof block.data === "string" && block.data.trim().length > 0) {
        data = block.data;
    }
    if (!data?.trim()) {
        return undefined;
    }
    let mimeType =
        typeof source?.media_type === "string" ? source.media_type : "image/jpeg";
    if (typeof block.mimeType === "string") {
        mimeType = block.mimeType;
    }
    return { data, mimeType, type: "image" };
}

function normalizeMessageText(content: unknown): string {
    if (typeof content === "string") {
        return content.trim();
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .map((block) => {
            if (typeof block === "string") {
                return block;
            }
            const record = asRecord(block);
            return typeof record?.text === "string" ? record.text : "";
        })
        .filter(Boolean)
        .join("\n\n")
        .trim();
}

function normalizeTimestamp(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
}

function isPathInsideRoot(root: string, candidate: string): boolean {
    const relativePath = path.relative(root, candidate);
    return !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}

/** Rehydrates Gateway image placeholders from the guarded local transcript. */
export class OpenClawTranscriptImageHydrator {
    readonly #options: OpenClawTranscriptImageHydratorOptions;

    constructor(options: OpenClawTranscriptImageHydratorOptions) {
        this.#options = options;
    }

    #getTranscriptPath(sessionKey: string, sessionId?: string): string | undefined {
        const parts = sessionKey.split(":");
        if (parts[0]?.toLowerCase() !== "agent") {
            return undefined;
        }
        sessionId ||= this.#options.resolveSessionId(sessionKey);
        if (!sessionId || sessionId === "unknown") {
            return undefined;
        }

        const agentId = parts[1];
        const safeAgentPathSegment = /^[A-Za-z0-9._-]+$/u;
        const safeSessionPathSegment = /^[A-Za-z0-9:._-]+$/u;
        if (
            !agentId ||
            agentId === "." ||
            agentId === ".." ||
            !safeAgentPathSegment.test(agentId) ||
            !safeSessionPathSegment.test(sessionId)
        ) {
            return undefined;
        }

        const openClawRoot = path.resolve(this.#options.resolveOpenClawHome());
        const agentDirectory = path.resolve(openClawRoot, "agents", agentId);
        const agentsSessionsRoot = path.resolve(agentDirectory, "sessions");
        const transcriptPath = path.resolve(agentsSessionsRoot, `${sessionId}.jsonl`);
        let realOpenClawRoot: string;
        let realAgentsSessionsRoot: string;
        let realTranscriptPath: string;
        try {
            realOpenClawRoot = fs.realpathSync(openClawRoot);
            const realAgentDirectory = fs.realpathSync(agentDirectory);
            if (
                realAgentDirectory !==
                path.resolve(realOpenClawRoot, "agents", agentId)
            ) {
                return undefined;
            }
            realAgentsSessionsRoot = fs.realpathSync(
                path.resolve(realAgentDirectory, "sessions")
            );
            if (!realAgentsSessionsRoot.startsWith(`${realAgentDirectory}${path.sep}`)) {
                return undefined;
            }
            realTranscriptPath = fs.realpathSync(transcriptPath);
        } catch {
            return undefined;
        }

        if (!realTranscriptPath.startsWith(`${realAgentsSessionsRoot}${path.sep}`)) {
            return undefined;
        }
        return isPathInsideRoot(realOpenClawRoot, realTranscriptPath)
            ? realTranscriptPath
            : undefined;
    }

    async #readRawTranscriptImageMessages(
        sessionKey: string,
        sessionId?: string
    ): Promise<RawTranscriptImageMessage[]> {
        const transcriptPath = this.#getTranscriptPath(sessionKey, sessionId);
        if (!transcriptPath) {
            return [];
        }

        let raw: string;
        try {
            raw = await Bun.file(transcriptPath).text();
        } catch {
            return [];
        }

        const messages: RawTranscriptImageMessage[] = [];
        for (const line of raw.split("\n")) {
            if (!line.trim() || !line.includes('"type":"image"')) {
                continue;
            }
            try {
                const parsed = JSON.parse(line) as {
                    timestamp?: unknown;
                    message?: unknown;
                };
                const message = asRecord(parsed.message);
                if (!message) {
                    continue;
                }
                const content = unknownArray(message.content);
                if (content.length === 0) {
                    continue;
                }
                const images = content
                    .map((block) => normalizeTranscriptImageBlock(block))
                    .filter(
                        (block): block is ChatImageBlockRecord => block !== undefined
                    );
                if (images.length === 0) {
                    continue;
                }
                messages.push({
                    role: typeof message.role === "string" ? message.role : "unknown",
                    text: normalizeMessageText(content),
                    timestamp:
                        normalizeTimestamp(message.timestamp) ??
                        normalizeTimestamp(parsed.timestamp),
                    images,
                });
            } catch {
                // Ignore malformed transcript lines.
            }
        }
        return messages;
    }

    async hydrateHistory(
        payload: unknown,
        requestedSessionKey?: string
    ): Promise<unknown> {
        const history = asRecord(payload) as ChatHistoryPayload | undefined;
        const sessionKey = history?.sessionKey || requestedSessionKey;
        if (!history || !sessionKey || !Array.isArray(history.messages)) {
            return payload;
        }

        const rawImageMessages = await this.#readRawTranscriptImageMessages(
            sessionKey,
            history.sessionId
        );
        if (rawImageMessages.length === 0) {
            return payload;
        }

        let rawCursor = 0;
        history.messages = history.messages.map((message) => {
            const record = asRecord(message);
            if (!record || !Array.isArray(record.content)) {
                return message;
            }
            const omittedImageIndexes = record.content
                .map((block, index) => ({ block: asRecord(block), index }))
                .filter(({ block }) => block && hasImageBlockOmittedData(block));
            if (omittedImageIndexes.length === 0) {
                return message;
            }
            const role = typeof record.role === "string" ? record.role : "unknown";
            const text = normalizeMessageText(record.content);
            const timestamp = normalizeTimestamp(record.timestamp);
            const rawMatchIndex = rawImageMessages.findIndex((candidate, index) => {
                if (index < rawCursor || candidate.role !== role) {
                    return false;
                }
                const isTimestampMatches =
                    timestamp === undefined ||
                    candidate.timestamp === undefined ||
                    Math.abs(candidate.timestamp - timestamp) < 5000;
                const textMatches =
                    !text ||
                    !candidate.text ||
                    candidate.text === text ||
                    candidate.text.endsWith(text) ||
                    candidate.text.includes(text);
                return isTimestampMatches && textMatches;
            });
            if (rawMatchIndex === -1) {
                return message;
            }

            rawCursor = rawMatchIndex + 1;
            const rawImages = rawImageMessages[rawMatchIndex]!.images;
            let imageCursor = 0;
            return {
                ...record,
                content: unknownArray(record.content).map((block) => {
                    const blockRecord = asRecord(block);
                    if (!blockRecord || !hasImageBlockOmittedData(blockRecord)) {
                        return block;
                    }
                    const rawImage = rawImages[imageCursor++];
                    return rawImage || block;
                }),
            };
        });
        return history;
    }

    async hydrateMessage(
        payload: unknown,
        requestedSessionKey?: string
    ): Promise<unknown> {
        const result = asRecord(payload);
        if (!result || !asRecord(result.message)) {
            return payload;
        }
        const hydratedHistory = asRecord(
            await this.hydrateHistory(
                {
                    messages: [result.message],
                    sessionId:
                        typeof result.sessionId === "string"
                            ? result.sessionId
                            : undefined,
                    sessionKey:
                        typeof result.sessionKey === "string"
                            ? result.sessionKey
                            : requestedSessionKey,
                },
                requestedSessionKey
            )
        ) as ChatHistoryPayload | undefined;
        const hydratedMessage = hydratedHistory?.messages?.[0];
        return hydratedMessage ? { ...result, message: hydratedMessage } : payload;
    }
}
