import * as v from "valibot";

import {
    authPasswordInputSchema,
    type PasswordChangeInput,
} from "../../contracts/auth.ts";

const passwordChangeFormObjectSchema = v.strictObject({
    currentPassword: authPasswordInputSchema,
    newPassword: authPasswordInputSchema,
});

/** Browser-only password form validation. */
export const passwordChangeFormSchema = v.pipe(
    passwordChangeFormObjectSchema,
    v.forward(
        v.check(
            (value) => value.currentPassword !== value.newPassword,
            "Choose a new password that differs from your current password."
        ),
        ["newPassword"]
    )
);

export type PasswordChangeFormValues = v.InferOutput<typeof passwordChangeFormSchema>;

/** @returns The validated transport-safe password-change input. */
export function passwordChangeInput(
    values: PasswordChangeFormValues
): PasswordChangeInput {
    return {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
    };
}
