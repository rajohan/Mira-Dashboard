export interface JsonValidation {
    valid: boolean;
    error: string | null;
}

export function validateJsonString(value: string): JsonValidation {
    try {
        JSON.parse(value);
        return { valid: true, error: null };
    } catch (error) {
        return {
            valid: false,
            error: error instanceof Error ? error.message : "Invalid JSON",
        };
    }
}
