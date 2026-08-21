import * as v from "valibot";

const linuxBootIdentityMessage = "Linux boot identity is invalid";

/** Canonical lowercase UUID exposed by Linux for one running kernel boot. */
export const linuxBootIdentitySchema = v.pipe(
    v.string(linuxBootIdentityMessage),
    v.regex(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
        linuxBootIdentityMessage
    )
);

export type LinuxBootIdentity = v.InferOutput<typeof linuxBootIdentitySchema>;
