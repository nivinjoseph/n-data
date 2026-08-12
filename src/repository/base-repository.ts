import { given } from "@nivinjoseph/n-defensive";
import { DomainContext } from "@nivinjoseph/n-domain";
import { Logger } from "@nivinjoseph/n-log";
import { Db } from "../db/db.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";

/**
 * Non-generic base for all aggregate repository implementations.
 *
 * Holds the state and behavior that is common to every repository regardless of the
 * aggregate type it serves: the domain context, the database, the unit of work, the
 * logger, and the backing table name. Generic, aggregate-specific concerns (aggregate
 * type, state factory, etc.) live on the concrete abstract subclasses.
 *
 * @class BaseRepository
 */
export abstract class BaseRepository
{
    private readonly _domainContext: DomainContext;
    private readonly _db: Db;
    private readonly _unitOfWork: UnitOfWork;
    private readonly _logger: Logger;
    private readonly _table: string;

    /**
     * The name of the database table this repository reads from and writes to.
     */
    protected get table(): string { return this._table; }

    public get domainContext(): DomainContext { return this._domainContext; }
    public get db(): Db { return this._db; }
    public get unitOfWork(): UnitOfWork { return this._unitOfWork; }
    public get logger(): Logger { return this._logger; }

    /**
     * @param {DomainContext} domainContext - The domain context for the current operation.
     * @param {Db} db - The database used to execute queries and commands.
     * @param {UnitOfWork} unitOfWork - The default unit of work for write operations.
     * @param {Logger} logger - The logger used to record errors and activity.
     * @param {string} table - The backing table name for this repository.
     */
    protected constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger, table: string)
    {
        given(domainContext, "domainContext").ensureHasValue().ensureIsObject();
        this._domainContext = domainContext;

        given(db, "db").ensureHasValue().ensureIsObject();
        this._db = db;

        given(unitOfWork, "unitOfWork").ensureHasValue().ensureIsObject();
        this._unitOfWork = unitOfWork;

        given(logger, "logger").ensureHasValue().ensureIsObject();
        this._logger = logger;

        given(table, "table").ensureHasValue().ensureIsString();
        this._table = table.trim();
    }
}
