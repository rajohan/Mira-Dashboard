import JSON5 from "json5";

export interface JsonValidation {
    valid: boolean;
    error: string | null;
}

export function validateJsonString(
    value: string,
    mode: "json" | "json5" = "json"
): JsonValidation {
    try {
        if (mode === "json5") {
            JSON5.parse(value);
        } else {
            JSON.parse(value);
        }
        return { valid: true, error: null };
    } catch (error) {
        return {
            valid: false,
            error:
                error instanceof Error
                    ? error.message
                    : mode === "json5"
                      ? "Invalid JSON5"
                      : "Invalid JSON",
        };
    }
}
