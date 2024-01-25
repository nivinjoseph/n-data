import { given } from "@nivinjoseph/n-defensive";
import { inject } from "@nivinjoseph/n-ject";
import { Db } from "../../db/db.js";
import { MigrationDependencyKey } from "../migration-dependency-key.js";
import { DbInfo } from "./db-info.js";
import { SystemRepository } from "./system-repository.js";
import { SystemTablesProvider } from "./system-tables-provider.js";
import { DateTime } from "@nivinjoseph/n-util";


@inject("Db", MigrationDependencyKey.dbSystemTablesProvider)
export class DefaultSystemRepository implements SystemRepository
{
    private readonly _db: Db;
    private readonly _systemTableName: string;


    public constructor(db: Db, systemTablesProvider: SystemTablesProvider)
    {
        given(db, "db").ensureHasValue().ensureIsObject();
        this._db = db;

        given(systemTablesProvider, "systemTablesProvider").ensureHasValue().ensureIsObject();
        this._systemTableName = systemTablesProvider.systemTableName.trim().toLowerCase();
    }


    public async checkIsInitialized(): Promise<boolean>
    {
        const sql = `
        SELECT EXISTS (
            SELECT 1
            FROM   information_schema.tables
            WHERE  table_schema = 'public'
            AND    table_name = '${this._systemTableName}'
            );
        `;

        const result = await this._db.executeQuery<any>(sql);
        return result.rows[0].exists as boolean;
    }

    public async initialize(): Promise<void>
    {
        const sql = `
        create table IF NOT EXISTS ${this._systemTableName}
            (
                key varchar(128) primary key,
                data jsonb not null
            );
        `;

        await this._db.executeCommand(sql);
    }

    public async getDbInfo(): Promise<DbInfo>
    {
        const key = "db_info";

        const sql = `select data from ${this._systemTableName} where key = ?`;
        const result = await this._db.executeQuery<any>(sql, key);

        if (result.rows.isEmpty)
            return new DbInfo(0, DateTime.now().dateValue);

        return DbInfo.deserialize(result.rows[0].data);
    }

    public async saveDbInfo(dbInfo: DbInfo): Promise<void>
    {
        given(dbInfo, "dbInfo").ensureHasValue().ensureIsObject();

        const key = "db_info";

        const exists = await this._checkIfKeyExists(key);

        let sql = "";
        const params = [];

        if (!exists)
        {
            sql = `
                insert into ${this._systemTableName}
                    (key, data)
                    values(?, ?);
            `;

            params.push(key, dbInfo.serialize());
        }
        else
        {
            sql = `
                update ${this._systemTableName}
                    set data = ?
                    where key = ?;
            `;

            params.push(dbInfo.serialize(), key);
        }

        await this._db.executeCommand(sql, ...params);
    }


    private async _checkIfKeyExists(key: string): Promise<boolean>
    {
        given(key, "key").ensureHasValue().ensureIsString();

        const sql = `select exists (select 1 from ${this._systemTableName} where key = ?);`;

        const result = await this._db.executeQuery<any>(sql, key);

        return result.rows[0].exists as boolean;
    }
}