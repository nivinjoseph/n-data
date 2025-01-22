import { DbInfo } from "./db-info.js";
export interface SystemRepository {
    checkIsInitialized(): Promise<boolean>;
    initialize(): Promise<void>;
    getDbInfo(): Promise<DbInfo>;
    saveDbInfo(dbInfo: DbInfo): Promise<void>;
}
//# sourceMappingURL=system-repository.d.ts.map