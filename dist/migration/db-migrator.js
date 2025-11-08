import { Container } from "@nivinjoseph/n-ject";
import { given } from "@nivinjoseph/n-defensive";
import { ConsoleLogger } from "@nivinjoseph/n-log";
import { DefaultSystemRepository } from "./system/default-system-repository.js";
import { DefaultDbVersionProvider } from "./default-db-version-provider.js";
import { MigrationDependencyKey } from "./migration-dependency-key.js";
export class DbMigrator {
    get containerRegistry() { return this._container; }
    get serviceLocator() { return this._container; }
    constructor() {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
        this._dbVersionProviderClass = null;
        this._systemTableName = null;
        this._container = new Container();
        this._migrationRegistrations = [];
        this._isDisposed = false;
        this._isBootstrapped = false;
    }
    useLogger(logger) {
        given(logger, "logger").ensureHasValue().ensureIsObject();
        given(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");
        this._logger = logger;
        return this;
    }
    useInstaller(installer) {
        given(installer, "installer").ensureHasValue().ensureIsObject();
        given(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");
        this._container.install(installer);
        return this;
    }
    useSystemTable(systemTableName) {
        given(systemTableName, "systemTableName").ensureHasValue().ensureIsString()
            .ensure(t => t.trim().toLowerCase() === t.trim(), "table name must be all lowercase");
        given(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");
        this._systemTableName = systemTableName.trim().toLowerCase();
        return this;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    registerDbVersionProvider(dbVersionProviderClass) {
        given(dbVersionProviderClass, "dbVersionProviderClass").ensureHasValue().ensureIsFunction();
        given(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");
        this._dbVersionProviderClass = dbVersionProviderClass;
        return this;
    }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    registerMigrations(...migrationClasses) {
        given(migrationClasses, "migrationClasses").ensureHasValue().ensureIsArray().ensure(t => t.length > 0);
        given(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");
        this._migrationRegistrations.push(...migrationClasses.map(t => new MigrationRegistration(t)));
        return this;
    }
    bootstrap() {
        given(this, "this")
            .ensure(t => !t._isBootstrapped, "invoking method after bootstrap")
            .ensure(t => t._dbVersionProviderClass != null || t._systemTableName != null, "one of either DbVersionProvider or SystemTableName must be provided")
            .ensure(t => t._dbVersionProviderClass == null || t._systemTableName == null, "cannot provide both DbVersionProvider and SystemTableName")
            .ensure(t => t._migrationRegistrations.length > 0, "no migrations registered")
            .ensure(t => t._migrationRegistrations.distinct(u => u.name).length === t._migrationRegistrations.length, "Duplicate registration names detected.")
            .ensure(t => t._migrationRegistrations.distinct(u => u.version).length === t._migrationRegistrations.length, "Duplicate registration versions detected.");
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this._logger == null)
            this._logger = new ConsoleLogger();
        if (this._dbVersionProviderClass != null)
            this._container.registerSingleton(MigrationDependencyKey.dbVersionProvider, this._dbVersionProviderClass);
        if (this._systemTableName != null) {
            this._container
                .registerInstance(MigrationDependencyKey.dbSystemTablesProvider, { systemTableName: this._systemTableName })
                .registerSingleton(MigrationDependencyKey.dbSystemRepository, DefaultSystemRepository)
                .registerSingleton(MigrationDependencyKey.dbVersionProvider, DefaultDbVersionProvider);
        }
        this._migrationRegistrations.forEach(t => this._container.registerScoped(t.name, t.migration));
        this._container.bootstrap();
        this._isBootstrapped = true;
        return this;
    }
    async runMigrations() {
        given(this, "this").ensure(t => t._isBootstrapped, "invoking method before bootstrap");
        const dbVersionProvider = this._container.resolve(MigrationDependencyKey.dbVersionProvider);
        await this._executeMigrations(dbVersionProvider);
    }
    dispose() {
        if (this._isDisposed)
            return Promise.resolve();
        this._isDisposed = true;
        return this._container.dispose();
    }
    async _executeMigrations(dbVersionProvider) {
        given(dbVersionProvider, "dbVersionProvider").ensureHasValue().ensureIsObject();
        const currentVersion = await dbVersionProvider.getVersion();
        const migrationRegistrations = this._migrationRegistrations
            .filter(t => t.version > currentVersion)
            .orderBy(t => t.version);
        await this._logger.logInfo("Commencing migrations.");
        await this._logger.logInfo(`Current Db version is '${currentVersion}'.`);
        if (migrationRegistrations.length === 0) {
            await this._logger.logWarning("No migrations to execute.");
        }
        else {
            await this._logger.logInfo(`${migrationRegistrations.length} migrations to execute starting with version '${migrationRegistrations[0].version}'.`);
            for (const registration of migrationRegistrations) {
                await this._logger.logInfo(`Commencing migration ${registration.name}`);
                const scope = this._container.createScope();
                try {
                    const migration = scope.resolve(registration.name);
                    await migration.execute();
                    await dbVersionProvider.setVersion(registration.version);
                    await this._logger.logInfo(`Completed migration ${registration.name}`);
                }
                catch (error) {
                    await this._logger.logWarning(`Failed migration ${registration.name}`);
                    throw error;
                }
                finally {
                    await scope.dispose();
                }
            }
        }
        await this._logger.logInfo("Completed migrations.");
    }
}
class MigrationRegistration {
    get name() { return this._name; }
    get version() { return this._version; }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    get migration() { return this._migration; }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    constructor(migration) {
        given(migration, "migration").ensureHasValue().ensureIsFunction();
        const migrationName = migration.getTypeName();
        const errorMessage = `invalid migration name ${migrationName}`;
        given(migrationName, "migrationName").ensureHasValue().ensureIsString()
            .ensure(t => t.contains("_"), errorMessage)
            .ensure(t => t.split("_").length === 2, errorMessage)
            .ensure(t => Number.parseInt(t.split("_")[1]) > 0, errorMessage);
        this._name = migrationName;
        this._version = Number.parseInt(migrationName.split("_")[1]);
        this._migration = migration;
    }
}
//# sourceMappingURL=db-migrator.js.map