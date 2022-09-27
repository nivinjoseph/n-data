"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultSystemRepository = void 0;
const tslib_1 = require("tslib");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_ject_1 = require("@nivinjoseph/n-ject");
const migration_dependency_key_1 = require("../migration-dependency-key");
const db_info_1 = require("./db-info");
let DefaultSystemRepository = class DefaultSystemRepository {
    constructor(db, systemTablesProvider) {
        (0, n_defensive_1.given)(db, "db").ensureHasValue().ensureIsObject();
        this._db = db;
        (0, n_defensive_1.given)(systemTablesProvider, "systemTablesProvider").ensureHasValue().ensureIsObject();
        this._systemTableName = systemTablesProvider.systemTableName.trim().toLowerCase();
    }
    checkIsInitialized() {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const sql = `
        SELECT EXISTS (
            SELECT 1
            FROM   information_schema.tables 
            WHERE  table_schema = 'public'
            AND    table_name = '${this._systemTableName}'
            );
        `;
            const result = yield this._db.executeQuery(sql);
            return result.rows[0].exists;
        });
    }
    getDbInfo() {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const key = "db_info";
            const sql = `select data from ${this._systemTableName} where key = ?`;
            const result = yield this._db.executeQuery(sql, key);
            return db_info_1.DbInfo.deserialize(result.rows[0].data);
        });
    }
    saveDbInfo(dbInfo) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(dbInfo, "dbInfo").ensureHasValue().ensureIsObject();
            const key = "db_info";
            const exists = yield this._checkIfKeyExists(key);
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
            yield this._db.executeCommand(sql, ...params);
        });
    }
    _checkIfKeyExists(key) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(key, "key").ensureHasValue().ensureIsString();
            const sql = `select exists (select 1 from ${this._systemTableName} where key = ?);`;
            const result = yield this._db.executeQuery(sql, key);
            return result.rows[0].exists;
        });
    }
};
DefaultSystemRepository = tslib_1.__decorate([
    (0, n_ject_1.inject)("Db", migration_dependency_key_1.MigrationDependencyKey.dbSystemTablesProvider),
    tslib_1.__metadata("design:paramtypes", [Object, Object])
], DefaultSystemRepository);
exports.DefaultSystemRepository = DefaultSystemRepository;
//# sourceMappingURL=default-system-repository.js.map