import { describe, expect, it } from "vitest";

import { formatBytes, formatNumber, truncateQuery } from "./databaseUtils";

describe("database utils", () => {
    it("formats numbers and byte sizes", () => {
        expect(formatNumber(1234567)).toBe("1,234,567");
        expect(formatBytes(0)).toBe("0 B");
        expect(formatBytes(-1)).toBe("0 B");
        expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
        expect(formatBytes(1024)).toBe("1.0 KB");
        expect(formatBytes(15 * 1024 ** 2)).toBe("15 MB");
    });

    it("truncates long queries and keeps short queries intact", () => {
        expect(truncateQuery("select 1", 20)).toBe("select 1");
        expect(truncateQuery("select * from very_long_table_name", 12)).toBe(
            "select * fro..."
        );
    });
});
