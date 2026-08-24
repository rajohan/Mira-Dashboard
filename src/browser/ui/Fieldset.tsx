import { Fieldset as HeadlessFieldset, Legend } from "@headlessui/react";
import { useId, type ReactNode } from "react";

import { cn } from "../lib/classNames.ts";
import { FormFieldInvalidContext } from "./formFieldContext.ts";

export interface FieldsetRenderContext {
    readonly describedBy: string | undefined;
    readonly invalid: boolean;
}

interface FieldsetProps {
    readonly ariaDescribedBy?: string;
    readonly children: ReactNode | ((context: FieldsetRenderContext) => ReactNode);
    readonly className?: string;
    readonly description?: ReactNode;
    readonly disabled?: boolean;
    readonly error?: ReactNode;
    readonly invalid?: boolean;
    readonly legend: ReactNode;
}

/**
 * Groups related controls behind one accessible legend and validation boundary.
 * @returns A native fieldset enhanced with Headless UI disabled-state semantics.
 */
export function Fieldset({
    ariaDescribedBy,
    children,
    className,
    description,
    disabled = false,
    error,
    invalid,
    legend,
}: FieldsetProps) {
    const descriptionId = useId();
    const errorId = useId();
    const resolvedInvalid = invalid ?? error !== undefined;
    const describedBy = [
        ariaDescribedBy,
        description === undefined ? undefined : descriptionId,
        error === undefined ? undefined : errorId,
    ]
        .filter((id): id is string => id !== undefined)
        .join(" ");
    const context = {
        describedBy: describedBy.length === 0 ? undefined : describedBy,
        invalid: resolvedInvalid,
    } satisfies FieldsetRenderContext;

    return (
        <HeadlessFieldset
            aria-describedby={context.describedBy}
            aria-invalid={resolvedInvalid || undefined}
            className={cn("m-0 min-w-0 border-0 p-0", className)}
            data-invalid={resolvedInvalid ? "" : undefined}
            disabled={disabled}
        >
            <Legend className="text-primary-200 block text-sm font-medium data-disabled:opacity-60">
                {legend}
            </Legend>
            {description !== undefined && (
                <p
                    className={cn(
                        "text-primary-400 mt-1 text-xs leading-5",
                        disabled && "opacity-60"
                    )}
                    id={descriptionId}
                >
                    {description}
                </p>
            )}
            <FormFieldInvalidContext.Provider value={resolvedInvalid}>
                {typeof children === "function" ? children(context) : children}
            </FormFieldInvalidContext.Provider>
            {error !== undefined && (
                <p className="mt-1.5 text-sm text-red-300" id={errorId}>
                    {error}
                </p>
            )}
        </HeadlessFieldset>
    );
}
