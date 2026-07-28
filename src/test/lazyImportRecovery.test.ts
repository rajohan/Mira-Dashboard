import { describe, expect, it, jest } from "bun:test";

import { loadLazyModule } from "../lib/lazyImportRecovery";

function recoveryStorage(initialValue?: string) {
    let value = initialValue;
    return {
        getItem: jest.fn(() => value),
        removeItem: jest.fn(() => {
            value = undefined;
        }),
        setItem: jest.fn((_key: string, nextValue: string) => {
            value = nextValue;
        }),
    };
}

describe("lazy import recovery", () => {
    it("clears the module reload guard after a successful import", async () => {
        const storage = recoveryStorage("100");
        const routeModule = { Tasks: () => {} };

        await expect(
            loadLazyModule("route-tasks", async () => routeModule, { storage })
        ).resolves.toBe(routeModule);
        expect(storage.removeItem).toHaveBeenCalledWith(
            "mira-dashboard:lazy-import-reload:route-tasks"
        );
    });

    it("reloads once for a missing chunk and rejects a repeated failure", async () => {
        const importError = new TypeError("Failed to fetch dynamically imported module");
        const storage = recoveryStorage();
        const reload = jest.fn();
        const firstImport = loadLazyModule(
            "route-reports",
            async () => {
                throw importError;
            },
            {
                now: () => 10_000,
                reload,
                storage,
            }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(storage.setItem).toHaveBeenCalledWith(
            "mira-dashboard:lazy-import-reload:route-reports",
            "10000"
        );
        void firstImport;

        await expect(
            loadLazyModule(
                "route-reports",
                async () => {
                    throw importError;
                },
                {
                    now: () => 10_001,
                    reload,
                    storage,
                }
            )
        ).rejects.toBe(importError);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it("allows another recovery reload after the cooldown", async () => {
        const importError = new TypeError("Importing a module script failed");
        const storage = recoveryStorage("10000");
        const reload = jest.fn();
        const importRequest = loadLazyModule(
            "route-database",
            async () => {
                throw importError;
            },
            {
                now: () => 70_001,
                reload,
                storage,
            }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(storage.setItem).toHaveBeenCalledWith(
            "mira-dashboard:lazy-import-reload:route-database",
            "70001"
        );
        void importRequest;
    });

    it("uses the in-memory loop guard when storage is unavailable", async () => {
        const importError = new TypeError("error loading dynamically imported module");
        const storage = {
            getItem: jest.fn(() => {
                throw new Error("storage unavailable");
            }),
            removeItem: jest.fn(() => {
                throw new Error("storage unavailable");
            }),
            setItem: jest.fn(() => {
                throw new Error("storage unavailable");
            }),
        };
        const reload = jest.fn();
        const firstImport = loadLazyModule(
            "chat-markdown-storage-failure",
            async () => {
                throw importError;
            },
            {
                now: () => 20_000,
                reload,
                storage,
            }
        );

        await Promise.resolve();
        await Promise.resolve();
        expect(reload).toHaveBeenCalledTimes(1);
        void firstImport;

        await expect(
            loadLazyModule(
                "chat-markdown-storage-failure",
                async () => {
                    throw importError;
                },
                {
                    now: () => 20_001,
                    reload,
                    storage,
                }
            )
        ).rejects.toBe(importError);
        expect(reload).toHaveBeenCalledTimes(1);
        await expect(
            loadLazyModule("chat-markdown-storage-failure", async () => "loaded", {
                storage,
            })
        ).resolves.toBe("loaded");
    });

    it("surfaces the import error when the browser reload cannot start", async () => {
        const importError = new TypeError("Failed to fetch dynamically imported module");
        const storage = recoveryStorage("invalid timestamp");

        await expect(
            loadLazyModule(
                "route-delivery-reload-failure",
                async () => {
                    throw importError;
                },
                {
                    now: () => 30_000,
                    reload: () => {
                        throw new Error("navigation unavailable");
                    },
                    storage,
                }
            )
        ).rejects.toBe(importError);
    });
});
