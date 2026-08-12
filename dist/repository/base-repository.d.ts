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
export declare abstract class BaseRepository {
    private readonly _domainContext;
    private readonly _db;
    private readonly _unitOfWork;
    private readonly _logger;
    private readonly _table;
    /**
     * The name of the database table this repository reads from and writes to.
     */
    protected get table(): string;
    get domainContext(): DomainContext;
    get db(): Db;
    get unitOfWork(): UnitOfWork;
    get logger(): Logger;
    /**
     * @param {DomainContext} domainContext - The domain context for the current operation.
     * @param {Db} db - The database used to execute queries and commands.
     * @param {UnitOfWork} unitOfWork - The default unit of work for write operations.
     * @param {Logger} logger - The logger used to record errors and activity.
     * @param {string} table - The backing table name for this repository.
     */
    protected constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger, table: string);
}
//# sourceMappingURL=base-repository.d.ts.map