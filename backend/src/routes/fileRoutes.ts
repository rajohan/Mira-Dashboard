import { handleFileListing } from "./fileRoutes/listing.ts";
import { handleFileRead } from "./fileRoutes/read.ts";
import { handleFileWrite } from "./fileRoutes/write.ts";

export const fileRoutes = {
    "/api/files": {
        GET: handleFileListing,
    },

    "/api/files/*": {
        GET: handleFileRead,
        PUT: handleFileWrite,
    },
} as const;
