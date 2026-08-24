import { createContext, use } from "react";

export const FormFieldInvalidContext = createContext(false);

/**
 * Returns whether the nearest shared form field currently has a validation error.
 * @returns The inherited invalid state for a shared form control.
 */
export function useFormFieldInvalid() {
    return use(FormFieldInvalidContext);
}
