import express from "express";
import fs from "fs";
import path from "path";

/** Registers static API routes. */
export default function staticRoutes(
    app: express.Application,
    frontendPath: string
): void {
    // Check if frontend build exists
    const indexExists = fs.existsSync(path.join(frontendPath, "index.html"));

    if (indexExists) {
        // Serve static files. Avoid stale dashboard bundles during active development;
        // hashed asset names still keep payloads stable, but the browser must revalidate
        // so chat capability fixes land immediately after a deploy/restart.
        app.use(
            express.static(frontendPath, {
                index: false,
                setHeaders: (response) => {
                    response.setHeader("Cache-Control", "no-store");
                },
            })
        );

        // SPA fallback - serve index.html for all non-API routes
        app.get(/^(?!\/api\/).*/, (req, res, next) => {
            // Skip API routes
            if (req.path.startsWith("/api/")) {
                next();
                return;
            }

            const indexPath = path.join(frontendPath, "index.html");
            res.setHeader("Cache-Control", "no-store");
            res.sendFile(indexPath, (err) => {
                if (err) {
                    console.error("[Static] Error serving index.html:", err.message);
                    res.status(500).send("Error loading application");
                }
            });
        });
    } else {
        // Frontend not built - serve a placeholder
        app.get(/^(?!\/api\/).*/, (req, res, next) => {
            if (req.path.startsWith("/api/")) {
                next();
                return;
            }

            res.status(503).send(`
                <html>
                <head><title>Mira Dashboard - Not Built</title></head>
                <body style="font-family: system-ui; padding: 2rem; background: #1a1a2e; color: #eee;">
                    <h1>🚧 Frontend Not Built</h1>
                    <p>Run <code style="background: #333; padding: 2px 6px; border-radius: 4px;">npm run build</code> in the frontend directory.</p>
                    <p style="color: #888; margin-top: 2rem;">
                        Backend API is available at <code style="background: #333; padding: 2px 6px;">/api/*</code>
                    </p>
                </body>
                </html>
            `);
        });
    }
}
