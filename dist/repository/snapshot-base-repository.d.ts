import { AggregateRoot, AggregateState, DomainEvent } from "@nivinjoseph/n-domain";
import { EventStreamBaseRepository } from "./event-stream-base-repository.js";
import { Repository } from "./repository.js";
import { BaseRepository } from "./base-repository.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
/**
 * Reads aggregates from the snapshot table - the materialized current state - and writes
 * both the snapshot and the underlying event stream on save.
 *
 * The snapshot table holds one row per aggregate: `id` (the primary key) and `data` (the
 * serialized state as jsonb). {@link get} and {@link getAll} cover lookup by id, which the
 * primary key already indexes. Any other read - filtering or sorting on a field *inside*
 * `data` - needs a method on the concrete subclass built over {@link query}.
 *
 * To make such a read use an index, declare it with `SnapshotIndex` and let `DbTableCreator` build
 * an expression index over each path. Nothing is added to the table: the index is built directly
 * over the extraction expression.
 *
 * **Declare those indexes here, on the repository that queries them.** One instance both produces
 * the index and hands back the expression to query it with, through its `expressionForPath`.
 * Postgres uses an expression index only when the query expression matches the indexed one
 * *textually*, and a near-miss silently falls back to a sequential scan with no error and no
 * warning. The expression builder is private to `SnapshotIndex`, so an expression can only come from
 * a declaration that also emits the DDL - which is what makes that divergence impossible. The
 * migration then consumes the same declarations.
 *
 * Paths are checked against the aggregate's state shape, so a typo is a compile error rather than a
 * silently useless index. An index marked `asUnique` constrains the extracted value, or for several
 * paths the tuple of them, so a natural key held inside the snapshot state can be enforced by the
 * database. Rows whose `data` omits an indexed key are unconstrained. A collision raises out of
 * {@link save} as a DbException and rolls the unit of work back, rather than surfacing as a domain
 * error.
 *
 * Matching the expression is necessary but not sufficient for the predicate to *use* the index:
 * btree only serves a leading prefix of an index's columns, so the second path of a composite is not
 * independently searchable. Read `info.indexes` from the create call for each index's column order.
 *
 * **An array inside `data` takes the other kind of index.** `SnapshotArrayIndex` builds a GIN index
 * over the array as jsonb and answers containment - "does some element look like this" - which is how
 * a membership query is served. It hands back a whole predicate rather than an expression, because
 * for GIN the operator is part of what makes the index usable. Pass those declarations as
 * `arrayIndexes` on the options object the create method accepts.
 *
 * The distinction that matters for an array of records: every field named in one match must be
 * carried by the **same** element. Two separate containment fragments ANDed together ask a weaker
 * question - some element has one field, some *possibly different* element has the other - and there
 * is no way to tell the two apart by reading the SQL. Name them in one match.
 *
 * @example
 * ```typescript
 * @inject("OrderEventStreamRepository")
 * export class OrderRepository extends SnapshotBaseRepository<Order, OrderState, OrderEvent>
 * {
 *     // declared once: the migration creates these, this class queries them
 *     public static readonly statusIndex = SnapshotIndex.forPath<OrderState>("status");
 *     public static readonly totalIndex = SnapshotIndex.forPath<OrderState>("total", JsonValueType.numeric);
 *     public static readonly numberIndex = SnapshotIndex.forPath<OrderState>("orderNumber").asUnique();
 *     public static readonly tagsIndex = SnapshotArrayIndex.forPath<OrderState>("tags");
 *
 *     public static readonly snapshotIndexes: ReadonlyArray<SnapshotIndex<OrderState>> =
 *         [OrderRepository.statusIndex, OrderRepository.totalIndex, OrderRepository.numberIndex];
 *
 *     public static readonly snapshotArrayIndexes: ReadonlyArray<SnapshotArrayIndex<OrderState>> =
 *         [OrderRepository.tagsIndex];
 *
 *     // resolved at module load, so a path the index does not cover throws at startup rather than
 *     // on the first call to an untested query method
 *     private static readonly _statusExpression = OrderRepository.statusIndex.expressionForPath("status");
 *     private static readonly _totalExpression = OrderRepository.totalIndex.expressionForPath("total");
 *     private static readonly _tags = OrderRepository.tagsIndex.containmentForPath("tags");
 *
 *     public constructor(eventStreamRepository: OrderEventStreamRepository)
 *     {
 *         super(eventStreamRepository);
 *     }
 *
 *     public getByStatus(status: string): Promise<Array<Order>>
 *     {
 *         return this.query(
 *             `select data from ${this.table} where ${OrderRepository._statusExpression} = ?;`,
 *             status);
 *     }
 *
 *     public getOverTotal(total: number): Promise<Array<Order>>
 *     {
 *         return this.query(
 *             `select data from ${this.table} where ${OrderRepository._totalExpression} > ?;`,
 *             total);
 *     }
 *
 *     public getByTag(tag: string): Promise<Array<Order>>
 *     {
 *         // sql and params come from one call - splice and spread them in the same order
 *         const predicate = OrderRepository._tags.contains(tag);
 *
 *         return this.query(`select data from ${this.table} where ${predicate.sql};`, ...predicate.params);
 *     }
 * }
 *
 * // in the migration
 * await tableCreator.createSnapshotTableForAggregate(Order, {
 *     indexes: OrderRepository.snapshotIndexes,
 *     arrayIndexes: OrderRepository.snapshotArrayIndexes
 * });
 * ```
 *
 * @class SnapshotBaseRepository
 */
export declare abstract class SnapshotBaseRepository<T extends AggregateRoot<TState, TDomainEvent>, TState extends AggregateState, TDomainEvent extends DomainEvent<TState>> extends BaseRepository implements Repository<T> {
    private readonly _eventStreamRepository;
    get eventStreamRepository(): EventStreamBaseRepository<T, TState, TDomainEvent>;
    protected constructor(eventStreamRepository: EventStreamBaseRepository<T, TState, TDomainEvent>);
    getAll(...ids: ReadonlyArray<string>): Promise<Array<T>>;
    get(id: string): Promise<T>;
    save(value: T, unitOfWork?: UnitOfWork): Promise<void>;
    /**
     * Runs a query and deserializes each row into an aggregate.
     *
     * The select list must be `data` - each row is deserialized from that column, so a query
     * selecting anything else fails. Parameters bind with `?` placeholders; never interpolate
     * values into the SQL.
     *
     * For reads whose shape does not map onto the aggregate - counts, group-bys, projections -
     * use {@link BaseRepository.queryRaw} instead, which performs no deserialization.
     *
     * @param {string} sql - The query to run. Must select the `data` column.
     * @param {...ReadonlyArray<any>} params - Values bound to the query's `?` placeholders.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     */
    protected query(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>;
}
//# sourceMappingURL=snapshot-base-repository.d.ts.map