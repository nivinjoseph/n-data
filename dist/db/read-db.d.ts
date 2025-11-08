import { QueryResult } from "./query-result.js";
/**
 * Interface representing a database that supports read operations.
 * Provides methods for executing queries and retrieving data from the database.
 *
 * @interface ReadDb
 */
export interface ReadDb {
    /**
     * Executes a SQL query and returns the results.
     *
     * @template T - The type of the result data
     * @param {string} sql - The SQL query to execute
     * @param {...Array<any>} params - Parameters to be bound to the SQL query
     * @returns {Promise<QueryResult<T>>} A promise that resolves to a QueryResult containing the query results
     * @throws {Error} If the query execution fails
     */
    executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>;
}
//# sourceMappingURL=read-db.d.ts.map