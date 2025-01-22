import { __esDecorate, __runInitializers, __setFunctionName } from "tslib";
import { given } from "@nivinjoseph/n-defensive";
import { inject } from "@nivinjoseph/n-ject";
import { MigrationDependencyKey } from "../migration-dependency-key.js";
import { DbInfo } from "./db-info.js";
import { DateTime } from "@nivinjoseph/n-util";
let DefaultSystemRepository = (() => {
    let _classDecorators = [inject("Db", MigrationDependencyKey.dbSystemTablesProvider)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var DefaultSystemRepository = _classThis = class {
        constructor(db, systemTablesProvider) {
            given(db, "db").ensureHasValue().ensureIsObject();
            this._db = db;
            given(systemTablesProvider, "systemTablesProvider").ensureHasValue().ensureIsObject();
            this._systemTableName = systemTablesProvider.systemTableName.trim().toLowerCase();
        }
        async checkIsInitialized() {
            const sql = `
        SELECT EXISTS (
            SELECT 1
            FROM   information_schema.tables
            WHERE  table_schema = 'public'
            AND    table_name = '${this._systemTableName}'
            );
        `;
            const result = await this._db.executeQuery(sql);
            return result.rows[0].exists;
        }
        async initialize() {
            const sql = `
        create table IF NOT EXISTS ${this._systemTableName}
            (
                key varchar(128) primary key,
                data jsonb not null
            );
        `;
            await this._db.executeCommand(sql);
        }
        async getDbInfo() {
            const key = "db_info";
            const sql = `select data from ${this._systemTableName} where key = ?`;
            const result = await this._db.executeQuery(sql, key);
            if (result.rows.isEmpty)
                return new DbInfo(0, DateTime.now().dateValue);
            return DbInfo.deserialize(result.rows[0].data);
        }
        async saveDbInfo(dbInfo) {
            given(dbInfo, "dbInfo").ensureHasValue().ensureIsObject();
            const key = "db_info";
            const exists = await this._checkIfKeyExists(key);
            let sql = "";
            const params = [];
            if (!exists) {
                sql = `
                insert into ${this._systemTableName}
                    (key, data)
                    values(?, ?);
            `;
                params.push(key, dbInfo.serialize());
            }
            else {
                sql = `
                update ${this._systemTableName}
                    set data = ?
                    where key = ?;
            `;
                params.push(dbInfo.serialize(), key);
            }
            await this._db.executeCommand(sql, ...params);
        }
        async _checkIfKeyExists(key) {
            given(key, "key").ensureHasValue().ensureIsString();
            const sql = `select exists (select 1 from ${this._systemTableName} where key = ?);`;
            const result = await this._db.executeQuery(sql, key);
            return result.rows[0].exists;
        }
    };
    __setFunctionName(_classThis, "DefaultSystemRepository");
    (() => {
        const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        DefaultSystemRepository = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return DefaultSystemRepository = _classThis;
})();
export { DefaultSystemRepository };
//# sourceMappingURL=default-system-repository.js.map