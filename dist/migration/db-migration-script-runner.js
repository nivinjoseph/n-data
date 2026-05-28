import { __esDecorate, __runInitializers } from "tslib";
import { given } from "@nivinjoseph/n-defensive";
import { inject } from "@nivinjoseph/n-ject";
import { exec } from "child_process";
import { isAbsolute } from "node:path";
let DbMigrationScriptRunner = (() => {
    let _classDecorators = [inject("Logger")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var DbMigrationScriptRunner = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            DbMigrationScriptRunner = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        _logger;
        constructor(logger) {
            given(logger, "logger").ensureHasValue().ensureIsObject();
            this._logger = logger;
        }
        async runMigrations(migrationScriptPath) {
            given(migrationScriptPath, "migrationScriptPath").ensureHasValue().ensureIsString()
                .ensure(t => isAbsolute(t.trim()), "path must be absolute");
            migrationScriptPath = migrationScriptPath.trim();
            const promise = new Promise((resolve, reject) => {
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
                child.stdout?.setEncoding("utf-8");
                child.stdout?.on("data", (data) => {
                    console.log(data);
                });
                child.stderr?.setEncoding("utf-8");
                child.stderr?.on("data", (data) => {
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
    return DbMigrationScriptRunner = _classThis;
})();
export { DbMigrationScriptRunner };
//# sourceMappingURL=db-migration-script-runner.js.map