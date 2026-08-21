/**
 * Removes a provider namespace from model chrome without changing the canonical value.
 * @param model Canonical provider/model identifier.
 * @returns Compact model label for presentation-only surfaces.
 */
export function chatModelDisplayName(model: string | undefined): string {
    if (model === undefined) return "Unknown model";
    return model.split("/").at(-1) ?? model;
}
