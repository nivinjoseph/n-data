import { __esDecorate, __runInitializers, __setFunctionName } from "tslib";
import { given } from "@nivinjoseph/n-defensive";
import { DbException } from "../exceptions/db-exception.js";
import { OperationType } from "../exceptions/operation-type.js";
import { inject } from "@nivinjoseph/n-ject";
import { QueryResult } from "./query-result.js";
// public
let KnexPgReadDb = (() => {
    let _classDecorators = [inject("ReadDbConnectionFactory")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var KnexPgReadDb = _classThis = class {
        get dbConnectionFactory() { return this._dbConnectionFactory; }
        constructor(dbConnectionFactory) {
            given(dbConnectionFactory, "dbConnectionFactory").ensureHasValue().ensureIsObject();
            this._dbConnectionFactory = dbConnectionFactory;
        }
        executeQuery(sql, ...params) {
            const promise = new Promise((resolve, reject) => {
                this._dbConnectionFactory.create()
                    .then((knex) => {
                    // eslint-disable-next-line @typescript-eslint/no-floating-promises
                    knex.raw(sql, params).asCallback((err, result) => {
                        if (err) {
                            reject(new DbException(OperationType.query, sql, params, err));
                        }
                        else {
                            resolve(new QueryResult(result.rows));
                        }
                    });
                })
                    .catch(err => reject(err));
            });
            return promise;
        }
    };
    __setFunctionName(_classThis, "KnexPgReadDb");
    (() => {
        const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        KnexPgReadDb = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return KnexPgReadDb = _classThis;
})();
export { KnexPgReadDb };
//# sourceMappingURL=knex-pg-read-db.js.map