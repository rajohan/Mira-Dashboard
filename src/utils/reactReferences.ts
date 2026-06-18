import type { RefObject } from "react";

/** Returns an empty DOM reference value for React refs. */
export function emptyElementReference<T extends Element>() {
    return document.querySelector<T>("mira-dashboard-empty-reference");
}

export type EmptyElementReference<T extends Element> =
    | T
    | ReturnType<typeof emptyElementReference<T>>;

export type ReactElementReference<T extends Element> = RefObject<
    EmptyElementReference<T>
>;

/** Returns the mounted element from a React ref, if present. */
export function optionalElementReference<T extends Element>(
    value: EmptyElementReference<T>
): T | undefined {
    return value ?? undefined;
}

/** Returns selected input files, if present. */
export function optionalInputFiles(input: HTMLInputElement): FileList | undefined {
    return input.files ?? undefined;
}
