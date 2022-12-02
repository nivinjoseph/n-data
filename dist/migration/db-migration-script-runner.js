"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DbMigrationScriptRunner = void 0;
const tslib_1 = require("tslib");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_ject_1 = require("@nivinjoseph/n-ject");
const child_process_1 = require("child_process");
let DbMigrationScriptRunner = class DbMigrationScriptRunner {
    constructor(logger) {
        (0, n_defensive_1.given)(logger, "logger").ensureHasValue().ensureIsObject();
        this._logger = logger;
    }
    runMigrations(migrationScriptPath) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            const promise = new Promise((resolve, reject) => {
                var _a, _b, _c, _d;
                const child = (0, child_process_1.exec)(`node ${migrationScriptPath}`, 
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
                yield promise;
            }
            catch (error) {
                yield this._logger.logError(error);
                throw error;
            }
        });
    }
};
DbMigrationScriptRunner = tslib_1.__decorate([
    (0, n_ject_1.inject)("Logger"),
    tslib_1.__metadata("design:paramtypes", [Object])
], DbMigrationScriptRunner);
exports.DbMigrationScriptRunner = DbMigrationScriptRunner;
//# sourceMappingURL=db-migration-script-runner.js.map