import * as v from "valibot";

import { parseContract, strictJsonObjectSchema } from "./runtime";

export const MAX_TTS_TEXT_LENGTH = 4000;

export const textToSpeechRequestSchema = strictJsonObjectSchema({
    text: v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(MAX_TTS_TEXT_LENGTH)),
});

export type TextToSpeechRequest = v.InferOutput<typeof textToSpeechRequestSchema>;

/**
 * Parses a text-to-speech request at the backend HTTP trust boundary.
 * @param value Value to process.
 * @returns Parsed text-to-speech request.
 */
export function parseTextToSpeechRequest(value: unknown): TextToSpeechRequest {
    return parseContract(textToSpeechRequestSchema, value);
}
