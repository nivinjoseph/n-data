import { AggregateRoot, AggregateState, OrgAggregateRoot, OrgAggregateState, OrgDomainContext, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { Repository } from "./repository.js";
import { BaseRepository } from "./base-repository.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
import { OrgEventStreamBaseRepository } from "./org-event-stream-base-repository.js";
import { RepositoryQuery, RepositoryQueryBuilder } from "./repository-query.js";
import { QueryResult } from "../db/query-result.js";
import { SnapshotPredicate, SnapshotQuerySet } from "../migration/snapshot-query-set.js";

/**
 * The organization-scoped counterpart to `SnapshotBaseRepository`.
 *
 * The snapshot table holds `id` (the primary key), `organization_id`, and `data` (the
 * serialized state as jsonb). {@link get} and {@link getAll} cover lookup by id and scope
 * themselves to the current organization automatically.
 *
 * **{@link query} scopes itself to the current organization too, so a subclass never writes that
 * filter.** It owns the statement - `select data from <table> where organization_id = ? and (<your
 * predicate>)` - so a subclass supplies only the predicate, and the filter lands ahead of it, which
 * is both the tenant isolation and the leading index column. There is no way to forget it.
 * {@link queryAcrossOrganizations} is the deliberate exception, named for its consequence, for a read
 * that is genuinely meant to span tenants.
 *
 * As with the plain variant, what is queryable is declared with a `SnapshotQuerySet` handed to
 * `super` and exposed by overriding {@link indexes} - one object that both the migration creates the
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
 * be used - which the filter {@link query} adds already does. `info.indexes` reports it as
 * `leadingColumn`.
 *
 * **An array index is the one exception.** A `SnapshotArrayIndex` builds a GIN index, which *cannot*
 * lead with `organization_id` - a multicolumn GIN over a varchar column needs the `btree_gin`
 * extension, which is not trusted on Postgres 12 and would demand superuser at migration time. So
 * declaring one always creates the standalone `(organization_id)` index too, for the planner to
 * BitmapAnd the GIN scan against, and `info.indexes[i].leadingColumn` is `undefined` for it - read it
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
 *     protected override get indexes(): typeof InvoiceRepository.indexes { return InvoiceRepository.indexes; }
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
 *         return this.query(this.indexes.eq("status", status));
 *     }
 *
 *     public getByLabel(label: string): Promise<Array<Invoice>>
 *     {
 *         return this.query(this.indexes.contains("labels", label));
 *     }
 *
 *     public getRecentByStatus(status: string): Promise<Array<Invoice>>
 *     {
 *         return this.query({
 *             where: this.indexes.eq("status", status),
 *             orderBy: this.indexes.orderBy("issuedAt", "desc"),
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
export abstract class OrgSnapshotBaseRepository<T extends OrgAggregateRoot<TState, TDomainEvent>, TState extends OrgAggregateState, TDomainEvent extends OrgDomainEvent<TState>> extends BaseRepository implements Repository<T>
{
    private readonly _eventStreamRepository: OrgEventStreamBaseRepository<T, TState, TDomainEvent>;

    /**
     * The indexes this repository declares, and the typed predicates over them.
     *
     * **Abstract on purpose.** The declared return type is widened - the base cannot know which paths a
     * subclass chooses - so implement it by returning the `SnapshotQuerySet` static, typed with `typeof`:
     *
     * ```typescript
     * public static readonly indexes = SnapshotQuerySet.for<InvoiceState>().withPath("status");
     *
     * protected override get indexes(): typeof InvoiceRepository.indexes { return InvoiceRepository.indexes; }
     * ```
     *
     * The `typeof` is what carries the narrow type to the call sites, and it is the whole point: at the
     * widened type `eq` accepts *any* string as a path - including `organizationId`, which is a column here
     * and never queryable through `data` - and a numeric path with no declared cast. So an implementation
     * returning `SnapshotQuerySet<TState, any, any>` silently gives up path and cast checking while keeping
     * value checking. Requiring the member is what stops that happening by omission; typing it with
     * `typeof` is what makes it worth having.
     *
     * Nothing in this class reads it, and nothing should read it from a constructor. A subclass may back
     * it with an instance field rather than a static, and a subclass field initializer runs *after*
     * `super()` - so a constructor-time read would see `undefined`.
     */
    protected abstract get indexes(): SnapshotQuerySet<TState, any, any>;

    public override get domainContext(): OrgDomainContext { return super.domainContext as OrgDomainContext; }
    public get eventStreamRepository(): OrgEventStreamBaseRepository<T, TState, TDomainEvent> { return this._eventStreamRepository; }

    /**
     * @param {OrgEventStreamBaseRepository} eventStreamRepository - The event stream this snapshot is materialized from; the source of the db, unit of work, logger and domain context.
     */
    protected constructor(eventStreamRepository: OrgEventStreamBaseRepository<T, TState, TDomainEvent>)
    {
        given(eventStreamRepository, "eventStreamRepository").ensureHasValue().ensureIsObject().ensureIsInstanceOf(OrgEventStreamBaseRepository);

        super(eventStreamRepository.domainContext, eventStreamRepository.db, eventStreamRepository.unitOfWork,
            eventStreamRepository.logger, DataHelper.createSnapshotTableName(eventStreamRepository.aggregateType));

        this._eventStreamRepository = eventStreamRepository;
    }


    public async getAll(...ids: ReadonlyArray<string>): Promise<Array<T>>
    {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        ids = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());

        if (ids.isNotEmpty)
            return this.query(`id in (${ids.map(() => "?").join(",")})`, ...ids);

        return this.query({});
    }

    public async get(id: string): Promise<T>
    {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();

        const result = await this.query("id = ?", id);

        if (result.length !== 1)
            throw new AggregateNotFoundException(this._eventStreamRepository.aggregateType, id);

        return result[0];
    }

    public async save(value: T, unitOfWork?: UnitOfWork): Promise<void>
    {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._eventStreamRepository.aggregateType)
            .ensure(t => t.organizationId === this.domainContext.organizationId);

        given(unitOfWork, "unitOfWork").ensureIsObject();

        if (!value.isNew && !value.hasChanges)
            return;

        try
        {
            await this._eventStreamRepository.save(value, unitOfWork ?? this.unitOfWork);

            let sql = "";
            const params = [];

            if (value.isNew)
            {
                sql = `insert into ${this.table}
                            (id, organization_id, data)
                            values(?, ?, ?);`;

                params.push(value.id, this.domainContext.organizationId, value.snapshot());
            }
            else
            {
                sql = `insert into ${this.table}
                            (id, organization_id, data)
                            values(?, ?, ?)
                            on conflict (id) do update
                            set data = excluded.data;`;

                params.push(value.id, this.domainContext.organizationId, value.snapshot());
            }

            await this.db.executeCommandWithinUnitOfWork(unitOfWork ?? this.unitOfWork, sql, ...params);

            if (!unitOfWork)
                await this.unitOfWork.commit();
        }
        catch (error)
        {
            await this.logger.logError(error as any);

            if (!unitOfWork)
                await this.unitOfWork.rollback();

            throw error;
        }
    }

    /**
     * Runs a query **scoped to the current organization** and deserializes each row into an
     * aggregate.
     *
     * This owns the statement: `select data from <this.table> where organization_id = ? and (<your
     * predicate>)`. So what you supply is the predicate, without the `where` keyword - and the
     * organization filter is added for you, ahead of it, which is both the tenant isolation and the
     * leading index column every btree index on this table needs. Parameters bind with `?`
     * placeholders and are passed positionally; never interpolate a value into the predicate.
     *
     * The predicate is parenthesized, so a top-level `or` in it stays contained rather than escaping
     * the organization filter.
     *
     * Pass a {@link RepositoryQuery} instead of a string to add `order by`, `limit` or `offset`, or to
     * run with no predicate at all (`{}`). For a read that genuinely spans organizations, and only
     * then, use {@link queryAcrossOrganizations}. For reads whose shape does not map onto the
     * aggregate - counts, group-bys, projections - use {@link BaseRepository.queryRaw}, which
     * performs no deserialization.
     *
     * @param {string} where - The `where` predicate, without the `where` keyword.
     * @param {...ReadonlyArray<any>} params - Values bound to the predicate's `?` placeholders.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'.
     */
    protected query(where: string, ...params: ReadonlyArray<any>): Promise<Array<T>>;
    /**
     * @param {SnapshotPredicate} where - A predicate from {@link indexes}. It carries its own values, so none are passed alongside it.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     */
    protected query(where: SnapshotPredicate): Promise<Array<T>>;
    /**
     * @param {RepositoryQuery} query - The predicate and the clauses that follow it.
     * @param {...ReadonlyArray<any>} params - Values bound to the predicate's `?` placeholders, when it is a raw string.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     */
    protected query(query: RepositoryQuery, ...params: ReadonlyArray<any>): Promise<Array<T>>;
    protected async query(whereOrQuery: string | SnapshotPredicate | RepositoryQuery, ...params: ReadonlyArray<any>): Promise<Array<T>>
    {
        const built = RepositoryQueryBuilder.build(this.table, whereOrQuery, params,
            this.domainContext.organizationId);

        return this._deserialize(await this.queryRaw<any>(built.sql, ...built.params));
    }

    /**
     * Whether anything matches - without deserializing it.
     *
     * The question a natural-key rule asks: *is this value already taken within the current organization, by
     * someone other than me*. `excludeId` is what makes the "other than me" half work on an update, and it is
     * a parameter rather than something a caller filters out afterwards because it goes into the statement,
     * which is what lets the read stop at the first match instead of materializing every one.
     *
     * Unlike {@link BaseRepository.queryRaw}, this applies the same filtering {@link query} does - the organization filter included.
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
    protected async exists(predicate?: SnapshotPredicate, excludeId?: string): Promise<boolean>
    {
        const built = RepositoryQueryBuilder.buildExists(this.table, predicate, excludeId, this.domainContext.organizationId);

        return !(await this.queryRaw<unknown>(built.sql, ...built.params)).isEmpty;
    }

    /**
     * How many rows match - without deserializing them.
     *
     * The counterpart to {@link exists}, and scoped the same way. For a count broken down by something -
     * a group-by - use {@link BaseRepository.queryRaw}: that shape is a projection rather than a single
     * number, and this cannot express it.
     *
     * @param {SnapshotPredicate} [predicate] - What to count; omitted counts every row within the current organization.
     * @returns {Promise<number>} The number of matching rows.
     */
    protected async count(predicate?: SnapshotPredicate): Promise<number>
    {
        const built = RepositoryQueryBuilder.buildCount(this.table, predicate, this.domainContext.organizationId);
        const result = await this.queryRaw<{ count: number; }>(built.sql, ...built.params);

        return result.rows[0].count;
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
    protected async queryAcrossOrganizations(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>
    {
        return this._deserialize(await this.queryRaw<any>(sql, ...params));
    }

    private _deserialize(queryResult: QueryResult<any>): Array<T>
    {
        if (queryResult.isEmpty)
            return [];

        return queryResult.rows.map(t => t.data as AggregateState)
            .map(t => AggregateRoot.deserializeFromSnapshot(this.domainContext, this._eventStreamRepository.aggregateType, this._eventStreamRepository.aggregateStateFactory, t));
    }
}