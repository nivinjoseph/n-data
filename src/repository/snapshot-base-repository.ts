import { AggregateRoot, AggregateState, DomainEvent } from "@nivinjoseph/n-domain";
import { EventStreamBaseRepository } from "./event-stream-base-repository.js";
import { Repository } from "./repository.js";
import { BaseRepository } from "./base-repository.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
import { RepositoryQuery, RepositoryQueryBuilder } from "./repository-query.js";
import { QueryResult } from "../db/query-result.js";
import { SnapshotPredicate, SnapshotQuerySet } from "../migration/snapshot-query-set.js";

/**
 * Reads aggregates from the snapshot table - the materialized current state - and writes
 * both the snapshot and the underlying event stream on save.
 *
 * The snapshot table holds one row per aggregate: `id` (the primary key) and `data` (the
 * serialized state as jsonb). {@link get} and {@link getAll} cover lookup by id, which the
 * primary key already indexes. Any other read - filtering or sorting on a field *inside*
 * `data` - needs a method on the concrete subclass built over {@link query}.
 *
 * {@link query} owns the statement it runs - `select data from <table> where (<your predicate>)` - so
 * a subclass supplies the predicate and nothing else, with `order by`, `limit` and `offset` available
 * through the `RepositoryQuery` object form. {@link queryStatement} is the escape hatch for a read
 * that shape cannot express.
 *
 * **Declare what is queryable with a `SnapshotQuerySet`, handed to `super` and exposed by overriding
 * {@link indexes}.** That one object is both what the migration creates the table's indexes from and
 * what the predicates are built by, so an index that is queried is necessarily one that was created.
 * `DbTableCreator` builds a btree expression index per path; nothing is added to the table, since the
 * index is built directly over the extraction expression.
 *
 * That single source is what the type checking rests on. `this.indexes.eq("status", value)` accepts
 * only a path this repository declared - not merely one that exists on the state - and only a value of
 * that leaf's type. It also rejects a numeric comparison on a path declared without a
 * `JsonValueType`, because an uncast extraction compares as text and `'9' > '100'`.
 *
 * Underneath, an expression only ever comes from the declaration that also emitted the DDL. Postgres
 * uses an expression index only when the query expression matches the indexed one *textually*, and a
 * near-miss silently falls back to a sequential scan with no error and no warning; taking the
 * expression from the declaration is what makes that divergence impossible.
 *
 * A path declared `unique` constrains the extracted value, or for a composite the tuple of them, so a
 * natural key held inside the snapshot state can be enforced by the database. Rows whose `data` omits
 * an indexed key are unconstrained. A collision raises out of {@link save} as a DbException and rolls
 * the unit of work back, rather than surfacing as a domain error.
 *
 * Matching the expression is necessary but not sufficient for the predicate to *use* the index:
 * btree only serves a leading prefix of an index's columns, so the second path of a composite is not
 * independently searchable. That is a property of the plan rather than of the types, so it is not
 * expressible in the set - read `info.indexes` from the create call for each index's column order.
 *
 * **An array inside `data` takes the other kind of index.** `withArrayPath` builds a GIN index over
 * the array as jsonb, and {@link SnapshotQuerySet.contains} answers containment - "does some element
 * look like this" - which is how a membership query is served. It is a whole predicate rather than an
 * expression, because for GIN the operator is part of what makes the index usable.
 *
 * The distinction that matters for an array of records: every field named in one match must be
 * carried by the **same** element. Two separate `contains` fragments ANDed together ask a weaker
 * question - some element has one field, some *possibly different* element has the other - and there
 * is no way to tell the two apart by reading the SQL. Name them in one match.
 *
 * @example
 * ```typescript
 * @inject("OrderEventStreamRepository")
 * export class OrderRepository extends SnapshotBaseRepository<Order, OrderState, OrderEvent>
 * {
 *     // declared once: the migration creates these, this class queries them, and the paths below are
 *     // checked against exactly this list
 *     public static readonly indexes = SnapshotQuerySet.for<OrderState>()
 *         .withPath("status")
 *         .withPath("total", { type: JsonValueType.numeric })
 *         .withPath("orderNumber", { unique: true })
 *         .withArrayPath("tags");
 *
 *     // required by the base, which declares it abstract at a widened type; the `typeof` is what
 *     // carries the narrow one to the call sites
 *     protected override get indexes(): typeof OrderRepository.indexes { return OrderRepository.indexes; }
 *
 *     public constructor(eventStreamRepository: OrderEventStreamRepository)
 *     {
 *         super(eventStreamRepository);
 *     }
 *
 *     public getByStatus(status: string): Promise<Array<Order>>
 *     {
 *         return this.query(this.indexes.eq("status", status));
 *     }
 *
 *     public getOverTotal(total: number): Promise<Array<Order>>
 *     {
 *         // a number, because `total` declared a numeric cast - without one this would not compile
 *         return this.query(this.indexes.gt("total", total));
 *     }
 *
 *     public getByTag(tag: string): Promise<Array<Order>>
 *     {
 *         return this.query(this.indexes.contains("tags", tag));
 *     }
 *
 *     public getLargestOrders(count: number): Promise<Array<Order>>
 *     {
 *         // ordering and paging go on the object form; there is no predicate here
 *         return this.query({ orderBy: this.indexes.orderBy("total", "desc"), limit: count });
 *     }
 * }
 *
 * // in the migration - the same object, so a queried index is necessarily a created one
 * await tableCreator.createSnapshotTableForAggregate(Order, OrderRepository.indexes);
 * ```
 *
 * @class SnapshotBaseRepository
 */
export abstract class SnapshotBaseRepository<T extends AggregateRoot<TState, TDomainEvent>, TState extends AggregateState, TDomainEvent extends DomainEvent<TState>> extends BaseRepository implements Repository<T>
{
    private readonly _eventStreamRepository: EventStreamBaseRepository<T, TState, TDomainEvent>;

    /**
     * The indexes this repository declares, and the typed predicates over them.
     *
     * **Abstract on purpose.** The declared return type is widened - the base cannot know which paths a
     * subclass chooses - so implement it by returning the `SnapshotQuerySet` static, typed with `typeof`:
     *
     * ```typescript
     * public static readonly indexes = SnapshotQuerySet.for<OrderState>().withPath("status");
     *
     * protected override get indexes(): typeof OrderRepository.indexes { return OrderRepository.indexes; }
     * ```
     *
     * The `typeof` is what carries the narrow type to the call sites, and it is the whole point: at the
     * widened type `eq` accepts *any* string as a path, and a numeric path with no declared cast, so an
     * implementation returning `SnapshotQuerySet<TState, any, any>` silently gives up path and cast
     * checking while keeping value checking. Requiring the member is what stops that happening by
     * omission; typing it with `typeof` is what makes it worth having.
     *
     * Nothing in this class reads it, and nothing should read it from a constructor. A subclass may back
     * it with an instance field rather than a static, and a subclass field initializer runs *after*
     * `super()` - so a constructor-time read would see `undefined`.
     */
    protected abstract get indexes(): SnapshotQuerySet<TState, any, any>;

    public get eventStreamRepository(): EventStreamBaseRepository<T, TState, TDomainEvent> { return this._eventStreamRepository; }

    /**
     * @param {EventStreamBaseRepository} eventStreamRepository - The event stream this snapshot is materialized from; the source of the db, unit of work, logger and domain context.
     */
    protected constructor(eventStreamRepository: EventStreamBaseRepository<T, TState, TDomainEvent>)
    {
        given(eventStreamRepository, "eventStreamRepository").ensureHasValue().ensureIsObject().ensureIsInstanceOf(EventStreamBaseRepository);

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
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._eventStreamRepository.aggregateType);

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
                            (id, data)
                            values(?, ?);`;

                params.push(value.id, value.snapshot());
            }
            else
            {
                sql = `insert into ${this.table}
                            (id, data)
                            values(?, ?)
                            on conflict (id) do update
                            set data = excluded.data;`;

                params.push(value.id, value.snapshot());
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
     * Runs a query and deserializes each row into an aggregate.
     *
     * This owns the statement: `select data from <this.table> where (<your predicate>)`. So what you
     * supply is the predicate, without the `where` keyword. Parameters bind with `?` placeholders and
     * are passed positionally; never interpolate a value into the predicate.
     *
     * Pass a {@link RepositoryQuery} instead of a string to add `order by`, `limit` or `offset`, or to
     * run with no predicate at all (`{}`). For a read the built statement cannot express - a join, a
     * union, a CTE - use {@link queryStatement}. For reads whose shape does not map onto the
     * aggregate - counts, group-bys, projections - use {@link BaseRepository.queryRaw}, which performs
     * no deserialization.
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
        const built = RepositoryQueryBuilder.build(this.table, whereOrQuery, params);

        return this._deserialize(await this.queryRaw<any>(built.sql, ...built.params));
    }

    /**
     * Runs a whole statement and deserializes each row into an aggregate.
     *
     * The escape hatch from {@link query}, for the joins, unions, CTEs and set operations the statement
     * it builds cannot express. Everything {@link query} guarantees is yours to get right here: the
     * select list must be `data`, since that is the column each row is deserialized from. Prefer
     * {@link query} unless it cannot express the read.
     *
     * @param {string} sql - The statement to run. Must select the `data` column.
     * @param {...ReadonlyArray<any>} params - Values bound to the statement's `?` placeholders.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     */
    protected async queryStatement(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>
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