import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory.js";
import { QueryResult } from "./query-result.js";
import { ReadDb } from "./read-db.js";
export declare class KnexPgReadDb implements ReadDb {
    private readonly _dbConnectionFactory;
    protected get dbConnectionFactory(): DbConnectionFactory;
    constructor(dbConnectionFactory: DbConnectionFactory);
    executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>;
}
//# sourceMappingURL=knex-pg-read-db.d.ts.map