import { OrgAggregateRoot, OrgAggregateState, OrgAggregateStateFactory, OrgDomainContext, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { Repository } from "./repository.js";
import { BaseRepository } from "./base-repository.js";
import { Db } from "../db/db.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { Logger } from "@nivinjoseph/n-log";
import { ClassDefinition } from "@nivinjoseph/n-util";
import { QueryResult } from "../db/query-result.js";
/**
 * The organization-scoped counterpart to `EventStreamBaseRepository`: the append-only event stream for one
 * tenant's aggregates.
 *
 * **It reads by aggregate id, or in full, and deliberately nothing else** - and every read is scoped to
 * `this.domainContext.organizationId` without a caller saying so. {@link get} loads one, {@link getByIds}
 * loads a named set, {@link getAll} loads every one this organization has, {@link save} appends. There is no
 * query surface, and no way out of the tenant scope, because neither is wanted here:
 *
 * - **There is nothing to query by.** The table carries one index, the unique
 *   `(organization_id, aggregate_id, aggregate_version)`.
 * - **A partial match produces a wrong aggregate.** Rows are grouped by aggregate id and replayed, and
 *   `AggregateRoot` requires exactly one created event among them - so a content-based predicate either
 *   throws `no created event passed` or silently rebuilds the aggregate at an earlier version.
 *
 * Anything else is what `OrgSnapshotBaseRepository` is for: it reads a materialized table whose indexes are
 * declared with a `SnapshotQuerySet`, prepends the organization filter to every predicate, and offers
 * `queryAcrossOrganizations` for the rare read that is genuinely meant to span tenants. For a projection over
 * the raw event rows use {@link queryRawAcrossOrganizations} - which gets no organization filter, so such a
 * statement must constrain `organization_id` itself.
 *
 * @class OrgEventStreamBaseRepository
 */
export declare abstract class OrgEventStreamBaseRepository<T extends OrgAggregateRoot<TState, TDomainEvent>, TState extends OrgAggregateState, TDomainEvent extends OrgDomainEvent<TState>> extends BaseRepository implements Repository<T> {
    private readonly _aggregateType;
    private readonly _aggregateStateFactory;
    get domainContext(): OrgDomainContext;
    get aggregateType(): ClassDefinition<T>;
    get aggregateStateFactory(): OrgAggregateStateFactory<TState>;
    protected constructor(domainContext: OrgDomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger, aggregateType: ClassDefinition<T>, aggregateStateFactory: OrgAggregateStateFactory<TState>);
    /**
     * The aggregates with these ids, within the current organization, each replayed from its events.
     *
     * Ids that are blank once trimmed are dropped, and if that leaves none the result is empty -
     * asking for zero ids returns zero aggregates, which is unremarkable because the caller passed an
     * array. It was not always: as `getAll(...ids)` this shared a signature with {@link getAll}, so
     * the empty case had to stand for either every aggregate the organization has or none at all, and
     * could not be read off the call.
     *
     * @param {ReadonlyArray<string>} ids - The aggregate ids to load.
     * @returns {Promise<Array<T>>} The aggregates found; empty when none of the ids matched, or when no usable id was given.
     */
    getByIds(ids: ReadonlyArray<string>): Promise<Array<T>>;
    /**
     * Every aggregate the current organization has, each replayed from its events.
     *
     * **The most expensive read in this library**, and it takes no arguments so that it can only be
     * called on purpose: every row this organization owns is fetched, grouped by aggregate id, and
     * replayed. That is the whole point of it having its own signature rather than sharing one with
     * {@link getByIds} - a lookup over an empty list can no longer land here by accident.
     *
     * Still scoped: the organization filter is prepended and leads the statement, so this is one
     * tenant's aggregates rather than every tenant's. It is genuinely what an event-stream-only
     * repository needs for a content-based question, since this class offers no query surface - load
     * them and filter in memory. Once a stream outgrows that, the answer is
     * `OrgSnapshotBaseRepository` rather than a bigger read; to work through one in pieces, project
     * the ids with {@link queryRawAcrossOrganizations} and hand them to {@link getByIds} in batches.
     *
     * @returns {Promise<Array<T>>} Every aggregate in the current organization, replayed.
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
     * `OrgSnapshotBaseRepository` does when it writes through to this one.
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
     * Runs a raw SQL query, **with no organization filter added**, and returns the unprocessed
     * {@link QueryResult}.
     *
     * The projection door - a count over the event rows, an audit listing, or the id list that feeds
     * {@link getAll} in batches - and the reason this class needs no query surface of its own: all of
     * those read rows rather than aggregates, so none can produce the half-replayed aggregate the
     * class documentation warns about.
     *
     * **This is the only raw door on this class, but not the only way to reach the database.**
     * `this.db` is right there, and is public because the snapshot repositories are constructed from
     * an event stream repository's `db` and TypeScript's `protected` does not reach across sibling
     * classes. The naming here is guidance about which door reads as the obvious one, not a boundary
     * the type system enforces.
     *
     * It is named for its consequence: unlike every other read here, nothing scopes it, so a
     * statement meant to stay within one organization must constrain `organization_id` itself,
     * leading, so the index is used.
     *
     * @template TRow - The expected shape of each returned row.
     * @param {string} sql - The statement to run.
     * @param {...ReadonlyArray<any>} params - Values bound to the statement's `?` placeholders.
     * @returns {Promise<QueryResult<TRow>>} The raw query result.
     */
    protected queryRawAcrossOrganizations<TRow>(sql: string, ...params: ReadonlyArray<any>): Promise<QueryResult<TRow>>;
    /**
     * Runs a statement this class built and replays what comes back.
     *
     * Takes a built statement rather than the ids it came from, so that each read states its own
     * shape at its own call site - {@link getByIds} an `aggregate_id in (...)`, {@link getAll} no
     * predicate at all. It used to be `_load(ids)`, where an empty list meant the whole stream, and
     * folding two reads of such different cost into one optional-shaped parameter is exactly how the
     * two came to be confusable from the outside.
     *
     * Both callers go through the builder rather than writing their statement by hand, because the
     * organization filter has to lead both the predicate and the parameter list - and getting that
     * wrong is a tenant leak rather than a syntax error. That is also why this takes the built
     * statement and not raw SQL: there is no way to reach it having skipped the filter.
     */
    private _run;
    /**
     * The body both save doors share; `owned` is the whole of what separates them.
     */
    private _save;
    private _deserialize;
    protected abstract onSave(value: T, events: ReadonlyArray<TDomainEvent>): Promise<void>;
}
//# sourceMappingURL=org-event-stream-base-repository.d.ts.map