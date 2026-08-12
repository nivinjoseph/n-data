import { AggregateRoot } from "@nivinjoseph/n-domain";
import { BaseRepository } from "./base-repository.js";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
import { RepositoryQueryBuilder } from "./repository-query.js";
import { executeRawQuery } from "./raw-query.js";
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
export class EventStreamBaseRepository extends BaseRepository {
    _aggregateType;
    _aggregateStateFactory;
    get aggregateType() { return this._aggregateType; }
    get aggregateStateFactory() { return this._aggregateStateFactory; }
    constructor(domainContext, db, unitOfWork, logger, aggregateType, aggregateStateFactory) {
        given(domainContext, "domainContext").ensureHasValue().ensureIsObject()
            .ensureHasStructure({
            userId: "string"
        });
        super(domainContext, db, unitOfWork, logger, DataHelper.createEventStreamTableName(aggregateType));
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        this._aggregateType = aggregateType;
        given(aggregateStateFactory, "aggregateStateFactory").ensureHasValue().ensureIsObject();
        this._aggregateStateFactory = aggregateStateFactory;
    }
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
    getByIds(ids) {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        const trimmed = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());
        if (trimmed.isEmpty)
            return Promise.resolve([]);
        return this._run(RepositoryQueryBuilder.build(this.table, RepositoryQueryBuilder.idPredicate("aggregate_id", trimmed), []));
    }
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
    getAll() {
        return this._run(RepositoryQueryBuilder.build(this.table, {}, []));
    }
    async get(id) {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();
        const result = await this.getByIds([id]);
        if (result.length !== 1)
            throw new AggregateNotFoundException(this._aggregateType, id);
        return result[0];
    }
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
    save(value) {
        return this._save(value, this.unitOfWork, true);
    }
    /**
     * Appends the aggregate's new events into a transaction the caller owns, and **does not commit**.
     *
     * {@link onSave} still runs on commit, whenever the caller gets there - it is registered on their
     * unit of work, so it fires if and only if the events actually land.
     *
     * @param {T} value - The aggregate whose events to append. A no-op when it is neither new nor changed.
     * @param {UnitOfWork} unitOfWork - The caller's transaction. Required; committing it is theirs to do.
     */
    saveWithin(value, unitOfWork) {
        given(unitOfWork, "unitOfWork").ensureHasValue().ensureIsObject();
        return this._save(value, unitOfWork, false);
    }
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
    queryRaw(sql, ...params) {
        return executeRawQuery(this.db, sql, params);
    }
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
    async _run(built) {
        return this._deserialize(await this.queryRaw(built.sql, ...built.params));
    }
    /**
     * The body both save doors share; `owned` is the whole of what separates them.
     */
    async _save(value, unitOfWork, owned) {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._aggregateType);
        if (!value.isNew && !value.hasChanges)
            return;
        try {
            const events = (value.isNew ? value.events : value.currentEvents);
            const values = new Array();
            const params = new Array();
            for (const event of events) {
                values.push("(?, ?, ?, ?)");
                params.push(event.id, event.aggregateId, event.version, event.serialize());
            }
            const sql = `insert into ${this.table}
                            (id, aggregate_id, aggregate_version, data)
                            values ${values.join(",")};`;
            await this.db.executeCommandWithinUnitOfWork(unitOfWork, sql, ...params);
            unitOfWork.onCommit(() => this.onSave(value, events));
            if (owned)
                await unitOfWork.commit();
        }
        catch (error) {
            await this.logger.logError(error);
            if (owned)
                await unitOfWork.rollback();
            throw error;
        }
    }
    _deserialize(queryResult) {
        if (queryResult.isEmpty)
            return [];
        return queryResult.rows.map(t => t.data)
            .groupBy(t => t.$aggregateId)
            .map(t => AggregateRoot.deserializeFromEvents(this.domainContext, this._aggregateType, this._aggregateStateFactory, t.values));
    }
}
//# sourceMappingURL=event-stream-base-repository.js.map