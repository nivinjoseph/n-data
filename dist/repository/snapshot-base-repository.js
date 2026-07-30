import { AggregateRoot } from "@nivinjoseph/n-domain";
import { EventStreamBaseRepository } from "./event-stream-base-repository.js";
import { BaseRepository } from "./base-repository.js";
import { given } from "@nivinjoseph/n-defensive";
import { DataHelper } from "./data-helper.js";
import { AggregateNotFoundException } from "./aggregate-not-found-exception.js";
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
 *     { path: "total", type: JsonValueType.numeric },
 *     { path: "orderNumber", isUnique: true }      // also enforces a natural key
 * ]);
 * ```
 *
 * A path marked `isUnique` enforces uniqueness over the extracted value, so a natural key
 * held inside the snapshot state can be constrained by the database. Aggregates whose `data`
 * omits the key are unconstrained. A collision raises out of {@link save} as a DbException
 * and rolls the unit of work back, rather than surfacing as a domain error.
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
export class SnapshotBaseRepository extends BaseRepository {
    _eventStreamRepository;
    get eventStreamRepository() { return this._eventStreamRepository; }
    constructor(eventStreamRepository) {
        given(eventStreamRepository, "eventStreamRepository").ensureHasValue().ensureIsObject().ensureIsInstanceOf(EventStreamBaseRepository);
        super(eventStreamRepository.domainContext, eventStreamRepository.db, eventStreamRepository.unitOfWork, eventStreamRepository.logger, DataHelper.createSnapshotTableName(eventStreamRepository.aggregateType));
        this._eventStreamRepository = eventStreamRepository;
    }
    async getAll(...ids) {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        ids = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());
        const sql = ids.isNotEmpty
            ? `select data from ${this.table} where id in (${ids.map(() => "?").join(",")});`
            : `select data from ${this.table};`;
        return this.query(sql, ...ids);
    }
    async get(id) {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();
        const sql = `select data from ${this.table} where id = ?;`;
        const result = await this.query(sql, id);
        if (result.length !== 1)
            throw new AggregateNotFoundException(this._eventStreamRepository.aggregateType, id);
        return result[0];
    }
    async save(value, unitOfWork) {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._eventStreamRepository.aggregateType);
        given(unitOfWork, "unitOfWork").ensureIsObject();
        if (!value.isNew && !value.hasChanges)
            return;
        try {
            await this._eventStreamRepository.save(value, unitOfWork ?? this.unitOfWork);
            let sql = "";
            const params = [];
            if (value.isNew) {
                sql = `insert into ${this.table}
                            (id, data)
                            values(?, ?);`;
                params.push(value.id, value.snapshot());
            }
            else {
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
        catch (error) {
            await this.logger.logError(error);
            if (!unitOfWork)
                await this.unitOfWork.rollback();
            throw error;
        }
    }
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
    async query(sql, ...params) {
        const queryResult = await this.queryRaw(sql, ...params);
        if (queryResult.isEmpty)
            return [];
        return queryResult.rows.map(t => t.data)
            .map(t => AggregateRoot.deserializeFromSnapshot(this.domainContext, this._eventStreamRepository.aggregateType, this._eventStreamRepository.aggregateStateFactory, t));
    }
}
//# sourceMappingURL=snapshot-base-repository.js.map