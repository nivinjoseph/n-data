import { given } from "@nivinjoseph/n-defensive";
import { OrgConfigurableDomainContext } from "@nivinjoseph/n-domain";
import { ComponentInstaller, Registry } from "@nivinjoseph/n-ject";
import { DbConnectionConfig, KnexPgDb, KnexPgDbConnectionFactory, KnexPgUnitOfWork } from "../../../src/index.js";
import { ExampleLogger } from "../example-logger.js";

/**
 * The database this example owns. Its own database, not the library suite's `testdb`, because the
 * migrator tracks versions in a system table and one migrator per database is the rule - see
 * `ExDbMigrator`.
 */
export const exampleDbConfig: DbConnectionConfig = {
    host: "localhost",
    port: "5432",
    database: "exdb",
    username: "postgres",
    password: "p@ssw0rd"
};

/**
 * Installs the shared infrastructure, once per process: the logger, the connection pool, the database,
 * the unit of work, and the domain context. A domain installer registers only its own aggregate's
 * factory and repositories and must never install this one - n-ject throws on a duplicate key, so a
 * process hosting two domains would fail at boot.
 *
 * The lifetimes are the load-bearing part:
 *
 * - **`Db` is a singleton** - it wraps the pool, which is meant to be shared.
 * - **`UnitOfWork` is transient.** It is single-use by construction: it holds one transaction, and once
 *   committed or rolled back every method on it throws. A singleton would hand a dead transaction to
 *   the second caller and accumulate commit callbacks across unrelated operations.
 * - **Factories and repositories are scoped** (in the domain installers), so each scope resolves its
 *   own repository over its own unit of work.
 *
 * The domain context is registered as an **instance** under `"UserContext"`, aliased `"DomainContext"`
 * for domain code to inject read-only and `"AppDomainContext"` for the one place that mutates it. It is
 * an `OrgConfigurableDomainContext` so a single key serves both the plain and the organization-scoped
 * aggregates - `Studio` ignores the organization half, `Creator` requires it. A real web application
 * would register a *request-scoped* context instead, configured per request by its authentication
 * handler; a process-wide instance is only defensible because this example drives itself.
 *
 * @class CommonInstaller
 */
export class CommonInstaller implements ComponentInstaller
{
    private readonly _domainContext: OrgConfigurableDomainContext;
    private readonly _logger: ExampleLogger;

    public constructor(domainContext: OrgConfigurableDomainContext, logger: ExampleLogger)
    {
        given(domainContext, "domainContext").ensureHasValue().ensureIsObject();
        this._domainContext = domainContext;

        given(logger, "logger").ensureHasValue().ensureIsObject();
        this._logger = logger;
    }

    public install(registry: Registry): Promise<void>
    {
        given(registry, "registry").ensureHasValue().ensureIsObject();

        registry
            .registerInstance("Logger", this._logger)
            .registerInstance("UserContext", this._domainContext, "DomainContext", "AppDomainContext")
            .registerInstance("DbConnectionFactory", new KnexPgDbConnectionFactory(exampleDbConfig))
            .registerSingleton("Db", KnexPgDb)
            .registerTransient("UnitOfWork", KnexPgUnitOfWork);

        return Promise.resolve();
    }
}
