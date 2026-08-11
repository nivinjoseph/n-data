import { given } from "@nivinjoseph/n-defensive";
import { OrgConfigurableDomainContext } from "@nivinjoseph/n-domain";
import { ComponentInstaller, Registry } from "@nivinjoseph/n-ject";
import { ClassHierarchy } from "@nivinjoseph/n-util";
import { DbMigration, DbMigrator } from "../../src/index.js";
import { ExampleLogger } from "../common/example-logger.js";
import { CommonInstaller } from "../common/ioc/common-installer.js";
import { ExDbMigration_1 } from "./migrations/ex-db-migration_1.js";
import { ExDbMigration_2 } from "./migrations/ex-db-migration_2.js";

/**
 * The isolated container the migrator runs in.
 *
 * `DbMigrator.useInstaller` accepts exactly one installer, so this wrapper is the only way to hand it
 * everything the migrations need. It installs `CommonInstaller` and nothing else, because the migrations only
 * inject `"Db"` and `"Logger"` - a migration must not reach for a repository, since a repository's shape is
 * today's shape and a migration has to keep working against the schema it was written for.
 *
 * This is also the one sanctioned place where installers nest.
 *
 * @class ExDbMigrationInstaller
 */
class ExDbMigrationInstaller implements ComponentInstaller
{
    private readonly _commonInstaller: CommonInstaller;

    public constructor(commonInstaller: CommonInstaller)
    {
        given(commonInstaller, "commonInstaller").ensureHasValue().ensureIsObject();
        this._commonInstaller = commonInstaller;
    }

    public install(registry: Registry): Promise<void>
    {
        given(registry, "registry").ensureHasValue().ensureIsObject();

        return this._commonInstaller.install(registry);
    }
}

// `registerMigrations` takes bare `Function`s - it reads the version off each class name - so a class
// hierarchy is the closest honest type for the list
const migrations: ReadonlyArray<ClassHierarchy<DbMigration>> = [ExDbMigration_1, ExDbMigration_2];

/**
 * Builds the migrator for the `exdb` database.
 *
 * **One migrator per database, each with its own system table.** The version is parsed from the migration
 * class name and recorded in that table, so two migrators sharing one would fight over the same counter.
 * `useSystemTable` is what opts into the built-in version provider - it registers `DefaultSystemRepository`
 * over a key/jsonb table this call names, and the table is created lazily on the first version read. The
 * alternative, `registerDbVersionProvider`, supplies your own; providing both, or neither, fails at
 * bootstrap.
 *
 * Returned rather than exported as a module-level constant so a test can build one per run and dispose it -
 * the migrator owns a container, and that container owns the connection pool.
 *
 * @param {OrgConfigurableDomainContext} domainContext - The identity migrations run as.
 * @param {ExampleLogger} logger - Where the migrator narrates; a test asserts against this.
 * @returns {DbMigrator} A migrator that still needs `bootstrap()` before `runMigrations()`.
 */
export function createExDbMigrator(domainContext: OrgConfigurableDomainContext, logger: ExampleLogger): DbMigrator
{
    given(domainContext, "domainContext").ensureHasValue().ensureIsObject();
    given(logger, "logger").ensureHasValue().ensureIsObject();

    return new DbMigrator()
        .useLogger(logger)
        .useInstaller(new ExDbMigrationInstaller(new CommonInstaller(domainContext, logger)))
        .useSystemTable("ex_db_system")
        .registerMigrations(...migrations);
}
