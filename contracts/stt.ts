import * as v from "valibot";

import { parseContract } from "./runtime";

export const speechTranscriptionResponseSchema = v.strictObject({
    provider: v.literal("elevenlabs"),
    text: v.string(),
});

export type SpeechTranscriptionResponse = v.InferOutput<
    typeof speechTranscriptionResponseSchema
>;

export function parseSpeechTranscriptionResponse(
    value: unknown,
    path = "speechTranscription"
): SpeechTranscriptionResponse {
    return parseContract(speechTranscriptionResponseSchema, value, path);
}
