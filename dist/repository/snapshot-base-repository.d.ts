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
 * To make such a read use an index, declare the keys when the table is created and let
 * `DbTableCreator` build an expression index over each one. Nothing is added to the table:
 * the index is built directly over the extraction expression.
 *
 * ```typescript
 * await tableCreator.createSnapshotTableForAggregate(Order, [
 *     { path: "status" },
 *     { path: "total", type: JsonValueType.numeric }
 * ]);
 * ```
 *
 * Then build the predicate with {@link DataHelper.createJsonPathExpression} - the same
 * function the index was built from. Never hand-write the expression: Postgres only uses an
 * expression index when the query expression matches the indexed one textually, so a
 * near-miss silently falls back to a sequential scan with no error and no warning.
 *
 * @example
 * ```typescript
 * @inject("OrderEventStreamRepository")
 * export class OrderRepository extends SnapshotBaseRepository<Order, OrderState, OrderEvent>
 * {
 *     // computed once, from the same helper the index was built from
 *     private static readonly _statusExpression = DataHelper.createJsonPathExpression("status");
 *     private static readonly _totalExpression = DataHelper.createJsonPathExpression("total", JsonValueType.numeric);
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
 * }
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