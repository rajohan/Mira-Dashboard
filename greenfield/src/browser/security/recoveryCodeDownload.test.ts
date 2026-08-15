import { describe, expect, jest, test } from "bun:test";

import { downloadRecoveryCodes } from "./recoveryCodeDownload.ts";

function installObjectUrlBoundary() {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const blobs: Blob[] = [];
    const createObjectUrl = jest.fn((blob: Blob) => {
        blobs.push(blob);
        return "blob:recovery-codes";
    });
    const revokeObjectUrl = jest.fn();
    Object.defineProperties(URL, {
        createObjectURL: { configurable: true, value: createObjectUrl },
        revokeObjectURL: { configurable: true, value: revokeObjectUrl },
    });
    return {
        blobs,
        restore() {
            if (createDescriptor === undefined) {
                Reflect.deleteProperty(URL, "createObjectURL");
            } else {
                Object.defineProperty(URL, "createObjectURL", createDescriptor);
            }
            if (revokeDescriptor === undefined) {
                Reflect.deleteProperty(URL, "revokeObjectURL");
            } else {
                Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor);
            }
        },
        revokeObjectUrl,
    };
}

describe("recovery-code download", () => {
    test("downloads the one-time codes as inert text and revokes the object URL", async () => {
        const objectUrls = installObjectUrlBoundary();
        const click = jest
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(function (this: HTMLAnchorElement) {
                expect(this.download).toBe("mira-dashboard-recovery-codes.txt");
                expect(this.href).toBe("blob:recovery-codes");
            });

        try {
            downloadRecoveryCodes(["alpha-bravo", "charlie-delta"]);

            expect(objectUrls.blobs).toHaveLength(1);
            expect(objectUrls.blobs[0]?.type).toBe("text/plain;charset=utf-8");
            expect(await objectUrls.blobs[0]?.text()).toBe(
                "Mira Dashboard recovery codes\nEach code can be used once. Store these offline.\n\nalpha-bravo\ncharlie-delta\n"
            );
            expect(objectUrls.revokeObjectUrl).toHaveBeenCalledWith(
                "blob:recovery-codes"
            );
        } finally {
            click.mockRestore();
            objectUrls.restore();
        }
    });

    test("revokes the object URL when browser activation fails", () => {
        const objectUrls = installObjectUrlBoundary();
        const click = jest
            .spyOn(HTMLAnchorElement.prototype, "click")
            .mockImplementation(() => {
                throw new TypeError("download rejected");
            });

        try {
            expect(() => downloadRecoveryCodes(["one-time-code"])).toThrow(
                "download rejected"
            );
            expect(objectUrls.revokeObjectUrl).toHaveBeenCalledWith(
                "blob:recovery-codes"
            );
        } finally {
            click.mockRestore();
            objectUrls.restore();
        }
    });
});
