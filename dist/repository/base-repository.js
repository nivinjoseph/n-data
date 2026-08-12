import { given } from "@nivinjoseph/n-defensive";
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
export class BaseRepository {
    _domainContext;
    _db;
    _unitOfWork;
    _logger;
    _table;
    /**
     * The name of the database table this repository reads from and writes to.
     */
    get table() { return this._table; }
    get domainContext() { return this._domainContext; }
    get db() { return this._db; }
    get unitOfWork() { return this._unitOfWork; }
    get logger() { return this._logger; }
    /**
     * @param {DomainContext} domainContext - The domain context for the current operation.
     * @param {Db} db - The database used to execute queries and commands.
     * @param {UnitOfWork} unitOfWork - The default unit of work for write operations.
     * @param {Logger} logger - The logger used to record errors and activity.
     * @param {string} table - The backing table name for this repository.
     */
    constructor(domainContext, db, unitOfWork, logger, table) {
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
//# sourceMappingURL=base-repository.js.map