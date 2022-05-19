import { DbVersionProvider } from "../src/migration/db-version-provider";
import { given } from "@nivinjoseph/n-defensive";
import { DbMigration } from "../src/migration/db-migration";
import { inject, ComponentInstaller, Registry } from "@nivinjoseph/n-ject";
import { Logger, ConsoleLogger, LogDateTimeZone } from "@nivinjoseph/n-log";
import * as Assert from "assert";
import { DbMigrator } from "../src/migration/db-migrator";


class TestDbVersionProvider implements DbVersionProvider
{
    private _currentVersion: number;
    
    
    public get currentVersion(): number { return this._currentVersion; }
    
    
    public constructor()
    {
        this._currentVersion = 0;
    }
    
    
    public getVersion(): Promise<number>
    {
        return Promise.resolve(this._currentVersion);
    }
    
    public setVersion(version: number): Promise<void>
    {
        given(version, "version").ensureHasValue().ensureIsNumber().ensure(t => t > this._currentVersion);
        
        this._currentVersion = version;
        
        return Promise.resolve();
    }
}

@inject("Logger")
class TestDbMigration_1 implements DbMigration
{
    private readonly _logger: Logger;
    
    
    public constructor(logger: Logger)
    {
        given(logger, "logger").ensureHasValue().ensureIsObject();
        this._logger = logger;
    }
    
    
    public execute(): Promise<void>
    {
        return this._logger.logInfo("I am migration 1");
    }
}

@inject("Logger")
class TestDbMigration_2 implements DbMigration
{
    private readonly _logger: Logger;


    public constructor(logger: Logger)
    {
        given(logger, "logger").ensureHasValue().ensureIsObject();
        this._logger = logger;
    }


    public execute(): Promise<void>
    {
        return this._logger.logInfo("I am migration 2");
    }
}

const logger = new ConsoleLogger(LogDateTimeZone.est);

class TestInstaller implements ComponentInstaller
{
    public install(registry: Registry): void
    {
        given(registry, "registry").ensureHasValue().ensureIsObject();
        
        registry.registerInstance("Logger", logger);
    }
}

suite("Migration tests", () =>
{
    test("Full test", async () =>
    {
        const testMigrator = new DbMigrator()
            .useLogger(logger)
            .useInstaller(new TestInstaller())
            .registerDbVersionProvider(TestDbVersionProvider)
            .registerMigrations(TestDbMigration_2, TestDbMigration_1)
            .bootstrap();
        
        const dbVersionProvider = testMigrator.serviceLocator.resolve<TestDbVersionProvider>("DbVersionProvider");
        
        await testMigrator.runMigrations();
        
        Assert.strictEqual(dbVersionProvider.currentVersion, 2);
    });
});