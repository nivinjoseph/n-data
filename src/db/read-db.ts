import { QueryResult } from "./query-result";


// public
export interface ReadDb
{
    executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>;
}