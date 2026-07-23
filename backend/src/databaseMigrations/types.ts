export interface DatabaseMigration {
    name: string;
    sql: string;
    version: number;
}
