// Temporary debug: Log session data structure
(() => {
    const originalConsoleLog = console.log;
    console.log = (...args: any[]) => {
        if (args[0] && args[0].includes("Received: session")) {
            originalConsoleLog("[SESSION DEBUG]", ...args);
        }
        originalConsoleLog.apply(console, args);
    };
})();
