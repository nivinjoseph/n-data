import { __esDecorate, __runInitializers, __setFunctionName } from "tslib";
import { given } from "@nivinjoseph/n-defensive";
import { DbInfo } from "./system/db-info.js";
import { inject } from "@nivinjoseph/n-ject";
import { MigrationDependencyKey } from "./migration-dependency-key.js";
import { DateTime } from "@nivinjoseph/n-util";
let DefaultDbVersionProvider = (() => {
    let _classDecorators = [inject(MigrationDependencyKey.dbSystemRepository)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var DefaultDbVersionProvider = _classThis = class {
        constructor(systemRepository) {
            given(systemRepository, "systemRepository").ensureHasValue().ensureIsObject();
            this._systemRepository = systemRepository;
        }
        async getVersion() {
            const isDbInitialized = await this._systemRepository.checkIsInitialized();
            if (!isDbInitialized)
                await this._systemRepository.initialize();
            const info = await this._systemRepository.getDbInfo();
            return info.version;
        }
        async setVersion(version) {
            given(version, "version").ensureHasValue().ensureIsNumber().ensure(t => t > 0);
            const info = new DbInfo(version, DateTime.now().dateValue);
            await this._systemRepository.saveDbInfo(info);
        }
    };
    __setFunctionName(_classThis, "DefaultDbVersionProvider");
    (() => {
        const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        DefaultDbVersionProvider = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return DefaultDbVersionProvider = _classThis;
})();
export { DefaultDbVersionProvider };
//# sourceMappingURL=default-db-version-provider.js.map