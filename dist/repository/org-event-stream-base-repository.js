import { AggregateRoot } from "@nivinjoseph/n-domain";
import { BaseRepository } from "./base-repository.js";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
import { RepositoryQueryBuilder } from "./repository-query.js";
import { executeRawQuery } from "./raw-query.js";
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
export class OrgEventStreamBaseRepository extends BaseRepository {
    _aggregateType;
    _aggregateStateFactory;
    get domainContext() { return super.domainContext; }
    get aggregateType() { return this._aggregateType; }
    get aggregateStateFactory() { return this._aggregateStateFactory; }
    constructor(domainContext, db, unitOfWork, logger, aggregateType, aggregateStateFactory) {
        given(domainContext, "domainContext").ensureHasValue().ensureIsObject()
            .ensureHasStructure({
            userId: "string",
            organizationId: "string"
        });
        super(domainContext, db, unitOfWork, logger, DataHelper.createEventStreamTableName(aggregateType));
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        this._aggregateType = aggregateType;
        given(aggregateStateFactory, "aggregateStateFactory").ensureHasValue().ensureIsObject();
        this._aggregateStateFactory = aggregateStateFactory;
    }
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
    getByIds(ids) {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        const trimmed = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());
        if (trimmed.isEmpty)
            return Promise.resolve([]);
        return this._run(RepositoryQueryBuilder.build(this.table, RepositoryQueryBuilder.idPredicate("aggregate_id", trimmed), [], this.domainContext.organizationId));
    }
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
    getAll() {
        return this._run(RepositoryQueryBuilder.build(this.table, {}, [], this.domainContext.organizationId));
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
     * `OrgSnapshotBaseRepository` does when it writes through to this one.
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
    queryRawAcrossOrganizations(sql, ...params) {
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
     * Both callers go through the builder rather than writing their statement by hand, because the
     * organization filter has to lead both the predicate and the parameter list - and getting that
     * wrong is a tenant leak rather than a syntax error. That is also why this takes the built
     * statement and not raw SQL: there is no way to reach it having skipped the filter.
     */
    async _run(built) {
        return this._deserialize(await this.queryRawAcrossOrganizations(built.sql, ...built.params));
    }
    /**
     * The body both save doors share; `owned` is the whole of what separates them.
     */
    async _save(value, unitOfWork, owned) {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._aggregateType)
            .ensure(t => t.organizationId === this.domainContext.organizationId);
        if (!value.isNew && !value.hasChanges)
            return;
        try {
            const events = (value.isNew ? value.events : value.currentEvents);
            const values = new Array();
            const params = new Array();
            for (const event of events) {
                values.push("(?, ?, ?, ?, ?)");
                params.push(event.id, event.aggregateId, event.version, this.domainContext.organizationId, event.serialize());
            }
            const sql = `insert into ${this.table}
                            (id, aggregate_id, aggregate_version, organization_id, data)
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
//# sourceMappingURL=org-event-stream-base-repository.js.map