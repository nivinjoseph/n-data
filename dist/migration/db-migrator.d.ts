import { Disposable } from "@nivinjoseph/n-util";
import { ComponentInstaller, Registry, ServiceLocator } from "@nivinjoseph/n-ject";
import { Logger } from "@nivinjoseph/n-log";
export declare class DbMigrator implements Disposable {
    private readonly _dbVersionProviderKey;
    private readonly _container;
    private _logger;
    private readonly _migrationRegistrations;
    private _dbVersionProviderClass;
    private _isDisposed;
    private _isBootstrapped;
    get containerRegistry(): Registry;
    get serviceLocator(): ServiceLocator;
    constructor();
    useLogger(logger: Logger): this;
    useInstaller(installer: ComponentInstaller): this;
    registerDbVersionProvider(dbVersionProviderClass: Function): this;
    registerMigrations(...migrationClasses: Function[]): this;
    bootstrap(): this;
    runMigrations(): Promise<void>;
    dispose(): Promise<void>;
    private executeMigrations;
}
