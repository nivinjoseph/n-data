import { AggregateRoot } from "@nivinjoseph/n-domain";
import { BaseRepository } from "./base-repository.js";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
import { OrgEventStreamBaseRepository } from "./org-event-stream-base-repository.js";
import { RepositoryQueryBuilder } from "./repository-query.js";
import { executeRawQuery } from "./raw-query.js";
import { SnapshotShapeGuard } from "./snapshot-shape-guard.js";
import { snapshotDocumentToState, toSnapshotDocument } from "../migration/snapshot-document.js";
/**
 * The organization-scoped counterpart to `SnapshotBaseRepository`.
 *
 * The snapshot table holds `id` (the primary key), `organization_id`, and `data` (the
 * serialized state as jsonb). {@link get} and {@link getByIds} cover lookup by id, {@link getAll}
 * takes every row this organization has, and all three scope themselves to the current
 * organization automatically.
 *
 * **{@link query} scopes itself to the current organization too, so a subclass never writes that
 * filter.** It owns the statement - `select data from <table> where organization_id = ? and (<your
 * predicate>)` - so a subclass supplies only the predicate, and the filter lands ahead of it, which
 * is both the tenant isolation and the leading index column. There is no way to forget it.
 * {@link queryAcrossOrganizations} is the deliberate exception, named for its consequence, for a read
 * that is genuinely meant to span tenants.
 *
 * As with the plain variant, what is queryable is declared with a `SnapshotQuerySet` exposed by
 * overriding {@link querySet} - one object that both the migration creates the
 * table from and the predicates are built by, so a queried index is necessarily a created one, and so
 * every path and value is checked against that declaration at compile time.
 *
 * ```typescript
 * const indexes = SnapshotQuerySet.for<InvoiceState>()
 *     .withPath("status")
 *     .withComposite(["series", "invoiceNumber"], { unique: true });
 *
 * await tableCreator.createSnapshotTableForOrgAggregate(Invoice, indexes);
 * // -> create index ... on invoice_snaps(organization_id, (data->>'status'));
 * //    create unique index ... on invoice_snaps(organization_id, (data->>'series'), (data->>'invoiceNumber'));
 * ```
 *
 * `organizationId` is deliberately not an indexable path, even though the state declares it. It is a
 * real column here and it leads every index, so constraining the column both isolates the tenant and
 * uses the index; the copy inside `data` is not what any index covers, so both indexing and querying
 * that path are always wrong - which is why the set does not offer it, and why {@link query}
 * constrains the column for you.
 *
 * Because every index leads with `organization_id`, one declared `unique` is unique **within an
 * organization** rather than globally - the same natural key, or tuple of them, can exist once
 * per tenant, which is normally what a tenant-scoped natural key means. Rows whose `data` omits
 * an indexed key are unconstrained; for a composite that means a row missing any member never
 * collides. A collision raises out of {@link save} as a DbException and rolls the unit of work
 * back, rather than surfacing as a domain error.
 *
 * That leading column is also why no expression here is independently searchable: btree serves only a
 * leading prefix, so a predicate must constrain `organization_id` before any indexed expression can
 * be used - which the filter {@link query} adds already does. `info.createdIndexes` reports it as
 * `leadingColumn`.
 *
 * **An array index is the one exception.** A `SnapshotArrayIndex` builds a GIN index, which *cannot*
 * lead with `organization_id` - a multicolumn GIN over a varchar column needs the `btree_gin`
 * extension, which is not trusted on Postgres 12 and would demand superuser at migration time. So
 * declaring one always creates the standalone `(organization_id)` index too, for the planner to
 * BitmapAnd the GIN scan against, and `info.createdIndexes[i].leadingColumn` is `undefined` for it - read it
 * rather than assuming. The organization filter is still applied either way: tenant isolation is a
 * correctness rule independent of the plan.
 *
 * @example
 * ```typescript
 * @inject("InvoiceEventStreamRepository")
 * export class InvoiceRepository extends OrgSnapshotBaseRepository<Invoice, InvoiceState, InvoiceEvent>
 * {
 *     // declared once: the migration creates these, this class queries them, and the paths below are
 *     // checked against exactly this list
 *     public static readonly indexes = SnapshotQuerySet.for<InvoiceState>()
 *         .withPath("status")
 *         .withPath("issuedAt", { type: JsonValueType.bigint })
 *         .withArrayPath("labels");
 *
 *     protected override get querySet(): typeof InvoiceRepository.indexes { return InvoiceRepository.indexes; }
 *
 *     public constructor(eventStreamRepository: InvoiceEventStreamRepository)
 *     {
 *         super(eventStreamRepository);
 *     }
 *
 *     public getByStatus(status: string): Promise<Array<Invoice>>
 *     {
 *         // the predicate only - the organization filter is added ahead of it, for isolation and
 *         // because the index leads with it
 *         return this.query(this.querySet.eq("status", status));
 *     }
 *
 *     public getByLabel(label: string): Promise<Array<Invoice>>
 *     {
 *         return this.query(this.querySet.contains("labels", label));
 *     }
 *
 *     public getRecentByStatus(status: string): Promise<Array<Invoice>>
 *     {
 *         return this.query({
 *             where: this.querySet.eq("status", status),
 *             orderBy: this.querySet.orderBy("issuedAt", "desc"),
 *             limit: 20
 *         });
 *     }
 * }
 *
 * // in the migration - the same object
 * await tableCreator.createSnapshotTableForOrgAggregate(Invoice, InvoiceRepository.indexes);
 * ```
 *
 * @class OrgSnapshotBaseRepository
 */
export class OrgSnapshotBaseRepository extends BaseRepository {
    _eventStreamRepository;
    /**
     * The `organization_id = ?` filter {@link query} prepends, as a predicate you can splice into a
     * statement of your own.
     *
     * The companion to {@link queryAcrossOrganizations} and {@link queryRawAcrossOrganizations}:
     * those two leave the tenant boundary, and this is how a statement that only needed the *shape*
     * they allow - a CTE, a `distinct on`, a group-by - gets the filter back without re-deriving it.
     * Splice `sql` and spread `params` in the same order the fragments appear; positional binding is
     * unforgiving.
     *
     * It exposes nothing new - `domainContext.organizationId` is public - it just means the filter is
     * written once, here, rather than once per statement that needs it.
     *
     * @returns {SnapshotPredicate} The filter and the current organization's id.
     */
    get organizationPredicate() {
        return { sql: "organization_id = ?", params: [this.domainContext.organizationId] };
    }
    get domainContext() { return super.domainContext; }
    get eventStreamRepository() { return this._eventStreamRepository; }
    /**
     * @param {OrgEventStreamBaseRepository} eventStreamRepository - The event stream this snapshot is materialized from; the source of the db, unit of work, logger and domain context.
     */
    constructor(eventStreamRepository) {
        given(eventStreamRepository, "eventStreamRepository").ensureHasValue().ensureIsObject().ensureIsInstanceOf(OrgEventStreamBaseRepository);
        super(eventStreamRepository.domainContext, eventStreamRepository.db, eventStreamRepository.unitOfWork, eventStreamRepository.logger, DataHelper.createSnapshotTableName(eventStreamRepository.aggregateType));
        this._eventStreamRepository = eventStreamRepository;
    }
    /**
     * The aggregates with these ids, within the current organization.
     *
     * Ids that are blank once trimmed are dropped, and if that leaves none the result is empty -
     * asking for zero ids returns zero aggregates, which is unremarkable because the caller passed an
     * array. It was not always: as `getAll(...ids)` this shared a signature with {@link getAll}, so
     * the empty case had to stand for either everything or nothing and could not be read off the call.
     *
     * @param {ReadonlyArray<string>} ids - The aggregate ids to load.
     * @returns {Promise<Array<T>>} The aggregates found; empty when none of the ids matched, or when no usable id was given.
     */
    async getByIds(ids) {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        const trimmed = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());
        if (trimmed.isEmpty)
            return [];
        return this.query(RepositoryQueryBuilder.idPredicate("id", trimmed));
    }
    /**
     * Every row in the snapshot table **for the current organization**.
     *
     * Unbounded within the tenant, and takes no arguments so that it can only be called on purpose.
     * It is {@link query} with no predicate, so the organization filter is still prepended - this is
     * one studio's rows, never the whole table. Crossing that boundary takes
     * {@link queryAcrossOrganizations}, which is named for it.
     *
     * @returns {Promise<Array<T>>} Every aggregate in the current organization, deserialized.
     */
    getAll() {
        return this.query({});
    }
    async get(id) {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();
        const result = await this.query(RepositoryQueryBuilder.idPredicate("id", [id]));
        if (result.length !== 1)
            throw new AggregateNotFoundException(this._eventStreamRepository.aggregateType, id);
        return result[0];
    }
    /**
     * Saves the snapshot and the underlying event stream in a transaction this repository owns, and
     * commits it - or rolls it back and rethrows if anything fails.
     *
     * The transaction is this repository's own {@link BaseRepository.unitOfWork}. If anything else
     * was queued on that same instance, **this commits that too**, because a unit of work commits as
     * a whole. Use {@link saveWithin} when several writes have to land together.
     *
     * The first save each process makes per query set also verifies the declared index paths against
     * the real snapshot document (`SnapshotQuerySet.verifyDocument`): a fatal shape issue - a
     * `@serialize("customKey")` rename, raw-path drift, a Map/Set where an array was declared -
     * throws before anything is queued, and ambiguous findings log one warning. One `WeakSet` lookup
     * per save after that.
     *
     * @param {T} value - The aggregate to save. A no-op when it is neither new nor changed.
     * @throws {ApplicationException} If a declared index path has a fatal shape issue against the document being saved.
     */
    save(value) {
        return this._save(value, this.unitOfWork, true);
    }
    /**
     * Saves the snapshot and the underlying event stream into a transaction the caller owns, and
     * **does not commit**.
     *
     * Shape-verified exactly as {@link save} is - a fatal issue throws before anything is queued on
     * the caller's transaction.
     *
     * @param {T} value - The aggregate to save. A no-op when it is neither new nor changed.
     * @param {UnitOfWork} unitOfWork - The caller's transaction. Required; committing it is theirs to do.
     * @throws {ApplicationException} If a declared index path has a fatal shape issue against the document being saved.
     */
    saveWithin(value, unitOfWork) {
        given(unitOfWork, "unitOfWork").ensureHasValue().ensureIsObject();
        return this._save(value, unitOfWork, false);
    }
    /**
     * Runs a query **scoped to the current organization** and deserializes each row into an
     * aggregate.
     *
     * This owns the statement: `select data from <this.table> where organization_id = ? and (<your
     * predicate>)`. So what you supply is the predicate, without the `where` keyword - and the
     * organization filter is added for you, ahead of it, which is both the tenant isolation and the
     * leading index column every btree index on this table needs.
     *
     * **A predicate always carries its own values.** Every one comes from {@link querySet} - a typed
     * `eq`/`gt`/`in`/`contains`, a combinator, or `raw` for a hand-written fragment - and each binds
     * its own `?` placeholders. There is nothing to pass positionally and no way to mis-order the
     * binding against the organization value that precedes it, which is why this takes no parameters
     * beyond the predicate itself.
     *
     * The predicate is parenthesized, so a top-level `or` in it stays contained rather than escaping
     * the organization filter.
     *
     * Pass a {@link RepositoryQuery} instead of a bare predicate to add `order by`, `limit` or
     * `offset`, or to run with no predicate at all (`{}`). For a read that genuinely spans
     * organizations, and only then, use {@link queryAcrossOrganizations}. For reads whose shape does
     * not map onto the aggregate - counts, group-bys, projections - use
     * {@link queryRawAcrossOrganizations}, which performs no deserialization and, as its name says,
     * adds no organization filter either.
     *
     * @param {SnapshotPredicate | RepositoryQuery} whereOrQuery - A predicate from {@link querySet}, or the predicate and the clauses that follow it.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'; if orderBy is empty or contains a ';'; or if limit or offset is not a non-negative integer.
     */
    async query(whereOrQuery) {
        const built = RepositoryQueryBuilder.build(this.table, whereOrQuery, [], this.domainContext.organizationId);
        return this._deserialize(await this.queryRawAcrossOrganizations(built.sql, ...built.params));
    }
    /**
     * Whether anything matches - without deserializing it.
     *
     * The question a natural-key rule asks: *is this value already taken within the current organization, by
     * someone other than me*. `excludeId` is what makes the "other than me" half work on an update, and it is
     * a parameter rather than something a caller filters out afterwards because it goes into the statement,
     * which is what lets the read stop at the first match instead of materializing every one.
     *
     * Unlike {@link queryRawAcrossOrganizations}, this applies the same filtering {@link query} does - the organization filter included.
     * A hand-written condition reaches it through `SnapshotQuerySet.raw`, so there is no need to assemble a
     * statement to ask a yes-or-no question.
     *
     * Note that it answers about *stored* rows, so it races with a concurrent write. It is a check, not a
     * constraint: declare the path `unique` on the query set and let the index be the guarantee.
     *
     * @param {SnapshotPredicate} [predicate] - What to match; omitted asks whether there is any row at all.
     * @param {string} [excludeId] - An id that does not count as a match.
     * @returns {Promise<boolean>} Whether at least one row matched.
     */
    async exists(predicate, excludeId) {
        const built = RepositoryQueryBuilder.buildExists(this.table, predicate, excludeId, this.domainContext.organizationId);
        return !(await this.queryRawAcrossOrganizations(built.sql, ...built.params)).isEmpty;
    }
    /**
     * How many rows match - without deserializing them.
     *
     * The counterpart to {@link exists}, and scoped the same way. For a count broken down by something -
     * a group-by - use {@link queryRawAcrossOrganizations}: that shape is a projection rather than a single
     * number, and this cannot express it.
     *
     * @param {SnapshotPredicate} [predicate] - What to count; omitted counts every row within the current organization.
     * @returns {Promise<number>} The number of matching rows.
     */
    async count(predicate) {
        const built = RepositoryQueryBuilder.buildCount(this.table, predicate, this.domainContext.organizationId);
        const result = await this.queryRawAcrossOrganizations(built.sql, ...built.params);
        return result.rows[0].count;
    }
    /**
     * Runs a raw SQL query, **with no organization filter added**, and returns the unprocessed
     * {@link QueryResult}.
     *
     * For reads whose shape does not map onto the aggregate - counts, group-bys, projections. It is
     * named for its consequence, like {@link queryAcrossOrganizations}: nothing here scopes the read,
     * so a statement meant to stay within one organization has to constrain the column itself.
     * {@link organizationPredicate} is how, and leading, so the index is used.
     *
     * **This is the only raw door on this class, but not the only way to reach the database.**
     * `this.db` is right there, and has to be - the snapshot repositories are constructed from an
     * event stream repository's `db`, and TypeScript's `protected` does not reach across sibling
     * classes, so it is public. The naming here is guidance about which door reads as the obvious
     * one, not a boundary the type system enforces. It is worth knowing which it is.
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
     * Runs a whole statement, **with no organization filter added**, and deserializes each row into
     * an aggregate.
     *
     * The deliberate exception to {@link query}, for a read that is genuinely meant to span tenants -
     * an admin-wide report, a cross-organization reconciliation - and for the joins, unions and CTEs
     * the statement {@link query} builds cannot express. It is named for its consequence so that the
     * tenant implication is visible at the call site rather than inferred from a flag.
     *
     * Everything {@link query} guarantees is yours to get right here: the select list must be `data`,
     * and if the read is meant to stay within one organization the predicate has to constrain
     * `organization_id` itself - leading, so the index is used. Prefer {@link query} unless it cannot
     * express the read.
     *
     * @param {string} sql - The statement to run. Must select the `data` column.
     * @param {...ReadonlyArray<any>} params - Values bound to the statement's `?` placeholders.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     */
    async queryAcrossOrganizations(sql, ...params) {
        return this._deserialize(await this.queryRawAcrossOrganizations(sql, ...params));
    }
    /**
     * The body both save doors share; `owned` is the whole of what separates them.
     */
    async _save(value, unitOfWork, owned) {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._eventStreamRepository.aggregateType)
            .ensure(t => t.organizationId === this.domainContext.organizationId);
        if (!value.isNew && !value.hasChanges)
            return;
        try {
            // shape-checked against the declared paths before anything is queued on the unit of
            // work, so a fatal issue (a @serialize rename, raw-path drift) rejects the save whole -
            // once per process per query set, one WeakSet lookup per save after that
            const snapshot = toSnapshotDocument(value);
            await SnapshotShapeGuard.verify(this.table, this.querySet, snapshot, this.logger);
            // always the non-committing door: this repository decides whether the transaction gets
            // committed, and the event stream write has to land or not land with the snapshot write
            await this._eventStreamRepository.saveWithin(value, unitOfWork);
            // both branches write the same row from the same values; the conflict clause is the only
            // difference, and it is what makes a second save of a known aggregate an update rather
            // than a primary key violation
            const sql = value.isNew
                ? `insert into ${this.table}
                            (id, organization_id, data)
                            values(?, ?, ?);`
                : `insert into ${this.table}
                            (id, organization_id, data)
                            values(?, ?, ?)
                            on conflict (id) do update
                            set data = excluded.data;`;
            await this.db.executeCommandWithinUnitOfWork(unitOfWork, sql, value.id, this.domainContext.organizationId, snapshot);
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
            .map(t => AggregateRoot.deserializeFromSnapshot(this.domainContext, this._eventStreamRepository.aggregateType, this._eventStreamRepository.aggregateStateFactory, snapshotDocumentToState(t)));
    }
}
//# sourceMappingURL=org-snapshot-base-repository.js.map