/** Exact Bun PHC parameter prefix approved for Dashboard operator passwords. */
export const dashboardPasswordHashPrefix = "$argon2id$v=19$m=65536,t=3,p=1$";
export const dashboardPasswordHashEncodedValueLength = 43;
export const dashboardPasswordHashBase64CharacterClass = "A-Za-z0-9+/";
export const dashboardPasswordHashCanonicalTailCharacters = "AEIMQUYcgkosw048";
export const dashboardPasswordHashLength =
    dashboardPasswordHashPrefix.length + dashboardPasswordHashEncodedValueLength * 2 + 1;

const dashboardPasswordHashEncodedValuePattern = new RegExp(
    `^[${dashboardPasswordHashBase64CharacterClass}]{${dashboardPasswordHashEncodedValueLength - 1}}[${dashboardPasswordHashCanonicalTailCharacters}]$`,
    "u"
);

function isCanonicalEncodedPasswordHashValue(value: string): boolean {
    return (
        value.length === dashboardPasswordHashEncodedValueLength &&
        dashboardPasswordHashEncodedValuePattern.test(value)
    );
}

/**
 * Rejects persisted PHC parameters that could select unreviewed Argon2 work.
 * @param value Persisted password-hash candidate.
 * @returns Whether the candidate is the exact reviewed Dashboard PHC representation.
 */
export function isDashboardPasswordHash(value: string): boolean {
    if (
        value.length !== dashboardPasswordHashLength ||
        !value.startsWith(dashboardPasswordHashPrefix)
    ) {
        return false;
    }
    const saltStart = dashboardPasswordHashPrefix.length;
    const separatorIndex = saltStart + dashboardPasswordHashEncodedValueLength;
    if (value[separatorIndex] !== "$") return false;
    return (
        isCanonicalEncodedPasswordHashValue(value.slice(saltStart, separatorIndex)) &&
        isCanonicalEncodedPasswordHashValue(value.slice(separatorIndex + 1))
    );
}
