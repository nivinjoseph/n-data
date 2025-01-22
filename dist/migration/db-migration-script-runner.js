import { __esDecorate, __runInitializers, __setFunctionName } from "tslib";
import { given } from "@nivinjoseph/n-defensive";
import { inject } from "@nivinjoseph/n-ject";
import { exec } from "child_process";
import { isAbsolute } from "node:path";
let DbMigrationScriptRunner = (() => {
    let _classDecorators = [inject("Logger")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var DbMigrationScriptRunner = _classThis = class {
        constructor(logger) {
            given(logger, "logger").ensureHasValue().ensureIsObject();
            this._logger = logger;
        }
        async runMigrations(migrationScriptPath) {
            given(migrationScriptPath, "migrationScriptPath").ensureHasValue().ensureIsString()
                .ensure(t => isAbsolute(t.trim()), "path must be absolute");
            migrationScriptPath = migrationScriptPath.trim();
            const promise = new Promise((resolve, reject) => {
                var _a, _b, _c, _d;
                const child = exec(`node ${migrationScriptPath}`, 
                // @ts-expect-error: cuz of unused params
                (error, stdout, stderr) => {
                    // if (error)
                    // {
                    //     console.log(error.stack);
                    //     console.log("Error code: " + error.code);
                    //     console.log("Signal received: " + error.signal);
                    // }
                    // console.log("Child Process STDOUT: " + stdout);
                    // console.log("Child Process STDERR: " + stderr);
                });
                child.on("error", (err) => {
                    console.error(err);
                    reject(err);
                });
                (_a = child.stdout) === null || _a === void 0 ? void 0 : _a.setEncoding("utf-8");
                (_b = child.stdout) === null || _b === void 0 ? void 0 : _b.on("data", (data) => {
                    console.log(data);
                });
                (_c = child.stderr) === null || _c === void 0 ? void 0 : _c.setEncoding("utf-8");
                (_d = child.stderr) === null || _d === void 0 ? void 0 : _d.on("data", (data) => {
                    console.log(data);
                });
                child.on("exit", (code) => {
                    if (code !== 0) {
                        reject(`Migration exited with non zero code ${code}`);
                        return;
                    }
                    resolve();
                });
            });
            try {
                await promise;
            }
            catch (error) {
                await this._logger.logError(error);
                throw error;
            }
        }
    };
    __setFunctionName(_classThis, "DbMigrationScriptRunner");
    (() => {
        const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
        __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
        DbMigrationScriptRunner = _classThis = _classDescriptor.value;
        if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        __runInitializers(_classThis, _classExtraInitializers);
    })();
    return DbMigrationScriptRunner = _classThis;
})();
export { DbMigrationScriptRunner };
//# sourceMappingURL=db-migration-script-runner.js.map