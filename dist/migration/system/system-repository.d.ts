import { DbInfo } from "./db-info";
export interface SystemRepository {
    checkIsInitialized(): Promise<boolean>;
    initialize(): Promise<void>;
    getDbInfo(): Promise<DbInfo>;
    saveDbInfo(dbInfo: DbInfo): Promise<void>;
}
