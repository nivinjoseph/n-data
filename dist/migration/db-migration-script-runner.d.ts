import { Logger } from "@nivinjoseph/n-log";
export declare class DbMigrationScriptRunner {
    private readonly _logger;
    constructor(logger: Logger);
    runMigrations(migrationScriptPath: string): Promise<void>;
}
//# sourceMappingURL=db-migration-script-runner.d.ts.map