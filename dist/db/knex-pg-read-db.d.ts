import { DbConnectionFactory } from "../db-connection-factory/db-connection-factory";
import { QueryResult } from "./query-result";
import { ReadDb } from "./read-db";
export declare class KnexPgReadDb implements ReadDb {
    private readonly _dbConnectionFactory;
    protected get dbConnectionFactory(): DbConnectionFactory;
    constructor(dbConnectionFactory: DbConnectionFactory);
    executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>;
}
