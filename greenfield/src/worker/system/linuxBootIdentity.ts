import { readFile } from "node:fs/promises";

import * as v from "valibot";

import {
    type LinuxBootIdentity,
    linuxBootIdentitySchema,
} from "../../shared/linuxBootIdentity.ts";

const linuxBootIdentityPath = "/proc/sys/kernel/random/boot_id";

/**
 * Reads the kernel-owned identity for the current Linux boot.
 * @returns One validated canonical boot UUID.
 */
export async function readLinuxBootIdentity(): Promise<LinuxBootIdentity> {
    if (process.platform !== "linux") {
        throw new Error("Linux boot identity is unavailable");
    }
    try {
        const contents = await readFile(linuxBootIdentityPath, "utf8");
        if (contents.length > 64) throw new Error("invalid boot identity");
        return v.parse(linuxBootIdentitySchema, contents.trim());
    } catch {
        throw new Error("Linux boot identity is unavailable");
    }
}
