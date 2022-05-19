"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DbMigrator = void 0;
const tslib_1 = require("tslib");
const n_ject_1 = require("@nivinjoseph/n-ject");
const n_defensive_1 = require("@nivinjoseph/n-defensive");
const n_log_1 = require("@nivinjoseph/n-log");
class DbMigrator {
    constructor() {
        this._dbVersionProviderKey = "DbVersionProvider";
        this._container = new n_ject_1.Container();
        this._migrationRegistrations = [];
        this._isDisposed = false;
        this._isBootstrapped = false;
    }
    get containerRegistry() { return this._container; }
    get serviceLocator() { return this._container; }
    useLogger(logger) {
        (0, n_defensive_1.given)(logger, "logger").ensureHasValue().ensureIsObject();
        (0, n_defensive_1.given)(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");
        this._logger = logger;
        return this;
    }
    useInstaller(installer) {
        (0, n_defensive_1.given)(installer, "installer").ensureHasValue().ensureIsObject();
        (0, n_defensive_1.given)(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");
        this._container.install(installer);
        return this;
    }
    registerDbVersionProvider(dbVersionProviderClass) {
        (0, n_defensive_1.given)(dbVersionProviderClass, "dbVersionProviderClass").ensureHasValue().ensureIsFunction();
        (0, n_defensive_1.given)(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");
        this._dbVersionProviderClass = dbVersionProviderClass;
        return this;
    }
    registerMigrations(...migrationClasses) {
        (0, n_defensive_1.given)(migrationClasses, "migrationClasses").ensureHasValue().ensureIsArray().ensure(t => t.length > 0);
        (0, n_defensive_1.given)(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");
        this._migrationRegistrations.push(...migrationClasses.map(t => new MigrationRegistration(t)));
        return this;
    }
    bootstrap() {
        (0, n_defensive_1.given)(this, "this")
            .ensure(t => !t._isBootstrapped, "invoking method after bootstrap")
            .ensure(t => !!t._dbVersionProviderClass, "no DbVersionProvider registered")
            .ensure(t => t._migrationRegistrations.length > 0, "no migrations registered")
            .ensure(t => t._migrationRegistrations.distinct(u => u.name).length === t._migrationRegistrations.length, "Duplicate registration names detected.")
            .ensure(t => t._migrationRegistrations.distinct(u => u.version).length === t._migrationRegistrations.length, "Duplicate registration versions detected.");
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!this._logger)
            this._logger = new n_log_1.ConsoleLogger();
        this._container.registerSingleton(this._dbVersionProviderKey, this._dbVersionProviderClass);
        this._migrationRegistrations.forEach(t => this._container.registerScoped(t.name, t.migration));
        this._container.bootstrap();
        this._isBootstrapped = true;
        return this;
    }
    runMigrations() {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(this, "this").ensure(t => t._isBootstrapped, "invoking method before bootstrap");
            const dbVersionProvider = this._container.resolve(this._dbVersionProviderKey);
            yield this._executeMigrations(dbVersionProvider);
        });
    }
    dispose() {
        if (this._isDisposed)
            return Promise.resolve();
        this._isDisposed = true;
        return this._container.dispose();
    }
    _executeMigrations(dbVersionProvider) {
        return tslib_1.__awaiter(this, void 0, void 0, function* () {
            (0, n_defensive_1.given)(dbVersionProvider, "dbVersionProvider").ensureHasValue().ensureIsObject();
            const currentVersion = yield dbVersionProvider.getVersion();
            const migrationRegistrations = this._migrationRegistrations
                .filter(t => t.version > currentVersion)
                .orderBy(t => t.version);
            yield this._logger.logInfo("Commencing migrations.");
            yield this._logger.logInfo(`Current Db version is '${currentVersion}'.`);
            if (migrationRegistrations.length === 0) {
                yield this._logger.logWarning("No migrations to execute.");
            }
            else {
                yield this._logger.logInfo(`${migrationRegistrations.length} migrations to execute starting with version '${migrationRegistrations[0].version}'.`);
                for (const registration of migrationRegistrations) {
                    yield this._logger.logInfo(`Commencing migration ${registration.name}`);
                    const scope = this._container.createScope();
                    try {
                        const migration = scope.resolve(registration.name);
                        yield migration.execute();
                        yield dbVersionProvider.setVersion(registration.version);
                        yield this._logger.logInfo(`Completed migration ${registration.name}`);
                    }
                    catch (error) {
                        yield this._logger.logWarning(`Failed migration ${registration.name}`);
                        throw error;
                    }
                    finally {
                        yield scope.dispose();
                    }
                }
            }
            yield this._logger.logInfo("Completed migrations.");
        });
    }
}
exports.DbMigrator = DbMigrator;
class MigrationRegistration {
    constructor(migration) {
        (0, n_defensive_1.given)(migration, "migration").ensureHasValue().ensureIsFunction();
        const migrationName = migration.getTypeName();
        const errorMessage = `invalid migration name ${migrationName}`;
        (0, n_defensive_1.given)(migrationName, "migrationName").ensureHasValue().ensureIsString()
            .ensure(t => t.contains("_"), errorMessage)
            .ensure(t => t.split("_").length === 2, errorMessage)
            .ensure(t => Number.parseInt(t.split("_")[1]) > 0, errorMessage);
        this._name = migrationName;
        this._version = Number.parseInt(migrationName.split("_")[1]);
        this._migration = migration;
    }
    get name() { return this._name; }
    get version() { return this._version; }
    get migration() { return this._migration; }
}
//# sourceMappingURL=db-migrator.js.map