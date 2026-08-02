import path from "node:path";

import { writeReleaseManifest } from "../backend/src/services/releases/manifest.ts";

const releaseRoot = path.resolve(import.meta.dirname, "..");
const manifest = await writeReleaseManifest({ releaseRoot });

console.log(
    JSON.stringify({
        artifactCount: manifest.artifacts.length,
        commit: manifest.commitShort,
        manifestVersion: manifest.formatVersion,
        schema: manifest.schema.target,
    })
);
