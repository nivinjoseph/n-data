"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DefaultDbVersionProvider = void 0;
const tslib_1 = require("tslib");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const moment = require("moment");
const db_info_1 = require("./system/db-info");
const n_ject_1 = require("@nivinjoseph/n-ject");
const migration_dependency_key_1 = require("./migration-dependency-key");
let DefaultDbVersionProvider = class DefaultDbVersionProvider {
    constructor(systemRepository) {
        (0, n_defensive_1.given)(systemRepository, "systemRepository").ensureHasValue().ensureIsObject();
        this._systemRepository = systemRepository;
    }
    getVersion() {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const isDbInitialized = yield this._systemRepository.checkIsInitialized();
            if (!isDbInitialized)
                yield this._systemRepository.initialize();
            const info = yield this._systemRepository.getDbInfo();
            return info.version;
        });
    }
    setVersion(version) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(version, "version").ensureHasValue().ensureIsNumber().ensure(t => t > 0);
            const info = new db_info_1.DbInfo(version, moment().format("YYYY-MM-DD"));
            yield this._systemRepository.saveDbInfo(info);
        });
    }
};
DefaultDbVersionProvider = tslib_1.__decorate([
    (0, n_ject_1.inject)(migration_dependency_key_1.MigrationDependencyKey.dbSystemRepository),
    tslib_1.__metadata("design:paramtypes", [Object])
], DefaultDbVersionProvider);
exports.DefaultDbVersionProvider = DefaultDbVersionProvider;
//# sourceMappingURL=default-db-version-provider.js.map