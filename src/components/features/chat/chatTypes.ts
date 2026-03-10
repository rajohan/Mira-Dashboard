export interface ChatImageBlock {
    type: "image";
    mimeType?: string;
    data?: string;
    source?: {
        type?: string;
        media_type?: string;
        data?: string;
    };
}

export interface ChatHistoryMessage {
    role: string;
    content: unknown;
    text: string;
    images?: ChatImageBlock[];
    timestamp?: string;
}

export interface ChatStreamEventMessage {
    sessionKey?: string;
    runId?: string;
    state?: string;
    errorMessage?: string;
    message?: unknown;
}

export interface ChatRow {
    key: string;
    kind: "message" | "stream";
    message: ChatHistoryMessage;
}

export function extractImages(content: unknown): ChatImageBlock[] {
    if (!Array.isArray(content)) {
        return [];
    }

    return content.filter((item): item is ChatImageBlock => {
        if (!item || typeof item !== "object") {
            return false;
        }

        const block = item as Record<string, unknown>;
        return block.type === "image";
    });
}

export function normalizeText(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map((item) => {
                if (typeof item === "string") {
                    return item;
                }

                if (!item || typeof item !== "object") {
                    return "";
                }

                const block = item as Record<string, unknown>;
                if (typeof block.text === "string") {
                    return block.text;
                }

                if (block.type === "image") {
                    return "[image]";
                }

                return "";
            })
            .filter(Boolean)
            .join("\n\n");
    }

    if (content && typeof content === "object") {
        const maybe = content as Record<string, unknown>;
        if (typeof maybe.text === "string") {
            return maybe.text;
        }
    }

    return "";
}
