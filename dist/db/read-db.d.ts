import { QueryResult } from "./query-result.js";
export interface ReadDb {
    executeQuery<T>(sql: string, ...params: Array<any>): Promise<QueryResult<T>>;
}
//# sourceMappingURL=read-db.d.ts.map