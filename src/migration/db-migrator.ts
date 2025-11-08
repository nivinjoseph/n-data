import { Disposable } from "@nivinjoseph/n-util";
import { Container, ComponentInstaller, Registry, ServiceLocator } from "@nivinjoseph/n-ject";
import { given } from "@nivinjoseph/n-defensive";
import { Logger, ConsoleLogger } from "@nivinjoseph/n-log";
import { DbMigration } from "./db-migration.js";
import { DbVersionProvider } from "./db-version-provider.js";
import { SystemTablesProvider } from "./system/system-tables-provider.js";
import { DefaultSystemRepository } from "./system/default-system-repository.js";
import { DefaultDbVersionProvider } from "./default-db-version-provider.js";
import { MigrationDependencyKey } from "./migration-dependency-key.js";


export class DbMigrator implements Disposable
{
    private readonly _container: Container;
    private _logger!: Logger;
    private readonly _migrationRegistrations: Array<MigrationRegistration>;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    private _dbVersionProviderClass: Function | null = null;
    private _systemTableName: string | null = null;
    private _isDisposed: boolean;
    private _isBootstrapped: boolean;


    public get containerRegistry(): Registry { return this._container; }
    public get serviceLocator(): ServiceLocator { return this._container; }


    public constructor()
    {
        this._container = new Container();
        this._migrationRegistrations = [];
        this._isDisposed = false;
        this._isBootstrapped = false;
    }


    public useLogger(logger: Logger): this
    {
        given(logger, "logger").ensureHasValue().ensureIsObject();

        given(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");

        this._logger = logger;

        return this;
    }

    public useInstaller(installer: ComponentInstaller): this
    {
        given(installer, "installer").ensureHasValue().ensureIsObject();

        given(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");

        this._container.install(installer);

        return this;
    }

    public useSystemTable(systemTableName: string): this
    {
        given(systemTableName, "systemTableName").ensureHasValue().ensureIsString()
            .ensure(t => t.trim().toLowerCase() === t.trim(), "table name must be all lowercase");

        given(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");

        this._systemTableName = systemTableName.trim().toLowerCase();

        return this;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    public registerDbVersionProvider(dbVersionProviderClass: Function): this
    {
        given(dbVersionProviderClass, "dbVersionProviderClass").ensureHasValue().ensureIsFunction();

        given(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");

        this._dbVersionProviderClass = dbVersionProviderClass;

        return this;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    public registerMigrations(...migrationClasses: Array<Function>): this
    {
        given(migrationClasses, "migrationClasses").ensureHasValue().ensureIsArray().ensure(t => t.length > 0);

        given(this, "this").ensure(t => !t._isBootstrapped, "invoking method after bootstrap");

        this._migrationRegistrations.push(...migrationClasses.map(t => new MigrationRegistration(t)));

        return this;
    }

    public bootstrap(): this
    {
        given(this, "this")
            .ensure(t => !t._isBootstrapped, "invoking method after bootstrap")
            .ensure(t => t._dbVersionProviderClass != null || t._systemTableName != null,
                "one of either DbVersionProvider or SystemTableName must be provided")
            .ensure(t => t._dbVersionProviderClass == null || t._systemTableName == null,
                "cannot provide both DbVersionProvider and SystemTableName")
            .ensure(t => t._migrationRegistrations.length > 0, "no migrations registered")
            .ensure(t => t._migrationRegistrations.distinct(u => u.name).length === t._migrationRegistrations.length, "Duplicate registration names detected.")
            .ensure(t => t._migrationRegistrations.distinct(u => u.version).length === t._migrationRegistrations.length, "Duplicate registration versions detected.")
            ;

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (this._logger == null)
            this._logger = new ConsoleLogger();

        if (this._dbVersionProviderClass != null)
            this._container.registerSingleton(MigrationDependencyKey.dbVersionProvider, this._dbVersionProviderClass);

        if (this._systemTableName != null)
        {
            this._container
                .registerInstance(MigrationDependencyKey.dbSystemTablesProvider, <SystemTablesProvider>{ systemTableName: this._systemTableName })
                .registerSingleton(MigrationDependencyKey.dbSystemRepository, DefaultSystemRepository)
                .registerSingleton(MigrationDependencyKey.dbVersionProvider, DefaultDbVersionProvider);
        }

        this._migrationRegistrations.forEach(t => this._container.registerScoped(t.name, t.migration));
        this._container.bootstrap();

        this._isBootstrapped = true;

        return this;
    }

    public async runMigrations(): Promise<void>
    {
        given(this, "this").ensure(t => t._isBootstrapped, "invoking method before bootstrap");

        const dbVersionProvider = this._container.resolve<DbVersionProvider>(MigrationDependencyKey.dbVersionProvider);
        await this._executeMigrations(dbVersionProvider);
    }

    public dispose(): Promise<void>
    {
        if (this._isDisposed)
            return Promise.resolve();

        this._isDisposed = true;

        return this._container.dispose();
    }

    private async _executeMigrations(dbVersionProvider: DbVersionProvider): Promise<void>
    {
        given(dbVersionProvider, "dbVersionProvider").ensureHasValue().ensureIsObject();

        const currentVersion = await dbVersionProvider.getVersion();
        const migrationRegistrations = this._migrationRegistrations
            .filter(t => t.version > currentVersion)
            .orderBy(t => t.version);

        await this._logger.logInfo("Commencing migrations.");
        await this._logger.logInfo(`Current Db version is '${currentVersion}'.`);

        if (migrationRegistrations.length === 0)
        {
            await this._logger.logWarning("No migrations to execute.");
        }
        else
        {
            await this._logger.logInfo(`${migrationRegistrations.length} migrations to execute starting with version '${migrationRegistrations[0].version}'.`);

            for (const registration of migrationRegistrations)
            {
                await this._logger.logInfo(`Commencing migration ${registration.name}`);

                const scope = this._container.createScope();

                try
                {
                    const migration = scope.resolve<DbMigration>(registration.name);

                    await migration.execute();

                    await dbVersionProvider.setVersion(registration.version);

                    await this._logger.logInfo(`Completed migration ${registration.name}`);
                }
                catch (error)
                {
                    await this._logger.logWarning(`Failed migration ${registration.name}`);
                    throw error;
                }
                finally
                {
                    await scope.dispose();
                }
            }
        }

        await this._logger.logInfo("Completed migrations.");
    }
}


class MigrationRegistration
{
    private readonly _name: string;
    private readonly _version: number;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    private readonly _migration: Function;


    public get name(): string { return this._name; }
    public get version(): number { return this._version; }
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    public get migration(): Function { return this._migration; }


    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    public constructor(migration: Function)
    {
        given(migration, "migration").ensureHasValue().ensureIsFunction();

        const migrationName = (<Object>migration).getTypeName();

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