import { DbInfo } from "./db-info";
export interface SystemRepository {
    checkIsInitialized(): Promise<boolean>;
    getDbInfo(): Promise<DbInfo>;
    saveDbInfo(dbInfo: DbInfo): Promise<void>;
}
