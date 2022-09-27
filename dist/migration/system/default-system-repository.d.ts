import { Db } from "../../db/db";
import { DbInfo } from "./db-info";
import { SystemRepository } from "./system-repository";
import { SystemTablesProvider } from "./system-tables-provider";
export declare class DefaultSystemRepository implements SystemRepository {
    private readonly _db;
    private readonly _systemTableName;
    constructor(db: Db, systemTablesProvider: SystemTablesProvider);
    checkIsInitialized(): Promise<boolean>;
    getDbInfo(): Promise<DbInfo>;
    saveDbInfo(dbInfo: DbInfo): Promise<void>;
    private _checkIfKeyExists;
}
