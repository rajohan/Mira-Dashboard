import type { FormHTMLAttributes, ReactNode } from "react";

interface FormProps extends Omit<
    FormHTMLAttributes<HTMLFormElement>,
    "children" | "onSubmit"
> {
    readonly children: ReactNode;
    readonly onSubmit: () => void;
}

/**
 * Prevents native navigation and delegates submission without deprecated React event types.
 * @returns A client-managed HTML form boundary.
 */
export function Form({
    children,
    noValidate = true,
    onSubmit,
    ...properties
}: FormProps) {
    return (
        <form
            {...properties}
            noValidate={noValidate}
            onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onSubmit();
            }}
        >
            {children}
        </form>
    );
}
