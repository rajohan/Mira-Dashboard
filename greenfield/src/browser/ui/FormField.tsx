import { Description, Field, Label } from "@headlessui/react";
import type { ReactNode } from "react";

import { FormFieldInvalidContext } from "./formFieldContext.ts";

export interface FormFieldProps {
    readonly children: ReactNode;
    readonly className?: string;
    readonly description?: ReactNode;
    readonly disabled?: boolean;
    readonly error?: string;
    readonly label: ReactNode;
}

/**
 * Associates one arbitrary Headless UI control with shared field metadata.
 * @returns A labelled control and its associated descriptions.
 */
export function FormField({
    children,
    className,
    description,
    disabled = false,
    error,
    label,
}: FormFieldProps) {
    const invalid = error !== undefined;

    return (
        <Field
            className={className}
            data-invalid={invalid ? "" : undefined}
            disabled={disabled}
        >
            <Label className="text-primary-200 block text-sm font-medium data-disabled:opacity-60">
                {label}
            </Label>
            {description !== undefined && (
                <Description className="text-primary-400 mt-1 text-xs leading-5 data-disabled:opacity-60">
                    {description}
                </Description>
            )}
            <FormFieldInvalidContext.Provider value={invalid}>
                {children}
            </FormFieldInvalidContext.Provider>
            {error !== undefined && (
                <Description className="mt-1.5 text-sm text-red-300">{error}</Description>
            )}
        </Field>
    );
}
