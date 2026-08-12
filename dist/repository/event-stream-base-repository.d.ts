import { AggregateRoot, AggregateState, AggregateStateFactory, DomainContext, DomainEvent } from "@nivinjoseph/n-domain";
import { Repository } from "./repository.js";
import { BaseRepository } from "./base-repository.js";
import { Db } from "../db/db.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { Logger } from "@nivinjoseph/n-log";
import { ClassDefinition } from "@nivinjoseph/n-util";
import { QueryResult } from "../db/query-result.js";
/**
 * The append-only event stream for an aggregate: every event ever applied to it, and the aggregate rebuilt by
 * replaying them.
 *
 * **It reads by aggregate id, or in full, and deliberately nothing else.** {@link get} loads one,
 * {@link getByIds} loads a named set, {@link getAll} loads every one of them, {@link save} appends. There is
 * no query surface, and that is the design rather than an omission - two reasons, both of which make a
 * content-based read a mistake:
 *
 * - **There is nothing to query by.** The table carries exactly one index, the unique
 *   `(aggregate_id, aggregate_version)`. A predicate over what is inside `data` sequentially scans, always.
 * - **A partial match produces a wrong aggregate, not fewer aggregates.** Rows are grouped by aggregate id
 *   and each group replayed, and `AggregateRoot` requires exactly one created event among them. So a
 *   predicate that misses the creation row throws `no created event passed`, and one that happens to include
 *   it but excludes later events silently reconstructs the aggregate as it was at an *earlier version* -
 *   a query for `$name = 'SomethingCreated'` returns a table of version-1 aggregates and reports no error.
 *
 * Anything beyond loading by id is what the snapshot repositories are for: `SnapshotBaseRepository` reads a
 * materialized table whose indexes are declared with a `SnapshotQuerySet`, and writes through to this one on
 * save. For a projection over the raw event rows - a count, an audit listing - use
 * {@link queryRaw}, which performs no deserialization and so cannot produce a half-replayed
 * aggregate. Loading a large set in batches is the same pattern: project the ids with `queryRaw`, then hand
 * them to {@link getAll}.
 *
 * @class EventStreamBaseRepository
 */
export declare abstract class EventStreamBaseRepository<T extends AggregateRoot<TState, TDomainEvent>, TState extends AggregateState, TDomainEvent extends DomainEvent<TState>> extends BaseRepository implements Repository<T> {
    private readonly _aggregateType;
    private readonly _aggregateStateFactory;
    get aggregateType(): ClassDefinition<T>;
    get aggregateStateFactory(): AggregateStateFactory<TState>;
    protected constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger, aggregateType: ClassDefinition<T>, aggregateStateFactory: AggregateStateFactory<TState>);
    /**
     * The aggregates with these ids, each replayed from its events.
     *
     * Ids that are blank once trimmed are dropped, and if that leaves none the result is empty -
     * asking for zero ids returns zero aggregates, which is unremarkable because the caller passed an
     * array. It was not always: as `getAll(...ids)` this shared a signature with {@link getAll}, so
     * the empty case had to stand for either every aggregate in the stream or none at all, and could
     * not be read off the call.
     *
     * @param {ReadonlyArray<string>} ids - The aggregate ids to load.
     * @returns {Promise<Array<T>>} The aggregates found; empty when none of the ids matched, or when no usable id was given.
     */
    getByIds(ids: ReadonlyArray<string>): Promise<Array<T>>;
    /**
     * Every aggregate in the stream, each replayed from its events.
     *
     * **The most expensive read in this library**, and it takes no arguments so that it can only be
     * called on purpose: every row of the table is fetched, grouped by aggregate id, and replayed.
     * That is the whole point of it having its own signature rather than sharing one with
     * {@link getByIds} - a lookup over an empty list can no longer land here by accident.
     *
     * It is genuinely what an event-stream-only repository needs for a content-based question, since
     * this class offers no query surface: load them and filter in memory. Once a stream outgrows
     * that, the answer is a snapshot repository rather than a bigger read. To work through a large
     * stream in pieces, project the ids with {@link queryRaw} and hand them to {@link getByIds} in
     * batches.
     *
     * @returns {Promise<Array<T>>} Every aggregate, replayed.
     */
    getAll(): Promise<Array<T>>;
    get(id: string): Promise<T>;
    /**
     * Appends the aggregate's new events in a transaction this repository owns, and commits it - or
     * rolls it back and rethrows if anything fails.
     *
     * The transaction is this repository's own {@link BaseRepository.unitOfWork}. If anything else
     * was queued on that same instance, **this commits that too**, because a unit of work commits as
     * a whole. Use {@link saveWithin} when several writes have to land together - which is what
     * `SnapshotBaseRepository` does when it writes through to this one.
     *
     * @param {T} value - The aggregate whose events to append. A no-op when it is neither new nor changed.
     */
    save(value: T): Promise<void>;
    /**
     * Appends the aggregate's new events into a transaction the caller owns, and **does not commit**.
     *
     * {@link onSave} still runs on commit, whenever the caller gets there - it is registered on their
     * unit of work, so it fires if and only if the events actually land.
     *
     * @param {T} value - The aggregate whose events to append. A no-op when it is neither new nor changed.
     * @param {UnitOfWork} unitOfWork - The caller's transaction. Required; committing it is theirs to do.
     */
    saveWithin(value: T, unitOfWork: UnitOfWork): Promise<void>;
    /**
     * Runs a raw SQL query and returns the unprocessed {@link QueryResult}.
     *
     * The projection door, and the reason this class needs no query surface of its own: a count over
     * the event rows, an audit listing, or the id list that feeds {@link getAll} in batches all read
     * rows rather than aggregates, so none of them can produce the half-replayed aggregate the class
     * documentation warns about.
     *
     * @template TRow - The expected shape of each returned row.
     * @param {string} sql - The statement to run.
     * @param {...ReadonlyArray<any>} params - Values bound to the statement's `?` placeholders.
     * @returns {Promise<QueryResult<TRow>>} The raw query result.
     */
    protected queryRaw<TRow>(sql: string, ...params: ReadonlyArray<any>): Promise<QueryResult<TRow>>;
    /**
     * Runs a statement this class built and replays what comes back.
     *
     * Takes a built statement rather than the ids it came from, so that each read states its own
     * shape at its own call site - {@link getByIds} an `aggregate_id in (...)`, {@link getAll} no
     * predicate at all. It used to be `_load(ids)`, where an empty list meant the whole stream, and
     * folding two reads of such different cost into one optional-shaped parameter is exactly how the
     * two came to be confusable from the outside.
     *
     * There is still deliberately no way to pass a predicate over event *content*, not even from in
     * here - see the class documentation for why that is a mistake rather than a missing feature.
     */
    private _run;
    /**
     * The body both save doors share; `owned` is the whole of what separates them.
     */
    private _save;
    private _deserialize;
    protected abstract onSave(value: T, events: ReadonlyArray<TDomainEvent>): Promise<void>;
}
//# sourceMappingURL=event-stream-base-repository.d.ts.map