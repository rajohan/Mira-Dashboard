import { describe, expect, it, jest, mock } from "bun:test";

const rootRender = jest.fn();
const preloadAgentsCollection = jest.fn();
const preloadLogsCollection = jest.fn();
const preloadSessionsCollection = jest.fn();

mock.module("react-dom/client", () => ({
    createRoot: jest.fn(() => ({ render: rootRender })),
}));

mock.module("./App", () => ({
    default: () => <div>app</div>,
}));

mock.module("./collections/agents", () => ({
    preloadAgentsCollection,
}));

mock.module("./collections/logs", () => ({
    preloadLogsCollection,
}));

mock.module("./collections/sessions", () => ({
    preloadSessionsCollection,
}));

describe("main entrypoint", () => {
    it("preloads collections and renders the app", async () => {
        document.body.innerHTML = '<div id="root"></div>';

        await import("./main");

        expect(preloadAgentsCollection).toHaveBeenCalledTimes(1);
        expect(preloadLogsCollection).toHaveBeenCalledTimes(1);
        expect(preloadSessionsCollection).toHaveBeenCalledTimes(1);
        expect(rootRender).toHaveBeenCalledTimes(1);
    });
});
