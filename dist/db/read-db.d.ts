import { QueryResult } from "./query-result";
export interface ReadDb {
    executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>;
}
