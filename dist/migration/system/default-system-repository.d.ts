import { Db } from "../../db/db.js";
import { DbInfo } from "./db-info.js";
import { SystemRepository } from "./system-repository.js";
import { SystemTablesProvider } from "./system-tables-provider.js";
export declare class DefaultSystemRepository implements SystemRepository {
    private readonly _db;
    private readonly _systemTableName;
    constructor(db: Db, systemTablesProvider: SystemTablesProvider);
    checkIsInitialized(): Promise<boolean>;
    initialize(): Promise<void>;
    getDbInfo(): Promise<DbInfo>;
    saveDbInfo(dbInfo: DbInfo): Promise<void>;
    private _checkIfKeyExists;
}
//# sourceMappingURL=default-system-repository.d.ts.map