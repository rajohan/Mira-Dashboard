import {
    createSortedRowModel,
    rowSortingFeature,
    tableFeatures,
} from "@tanstack/react-table";

/** Shared client-side sorting for bounded Dashboard data tables. */
export const dashboardTableFeatures = tableFeatures({
    rowSortingFeature,
    sortedRowModel: createSortedRowModel(),
});
