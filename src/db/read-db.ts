import { QueryResult } from "./query-result.js";


// public
export interface ReadDb
{
    executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>;
}