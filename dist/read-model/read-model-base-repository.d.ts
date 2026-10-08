import { DomainContext } from "@nivinjoseph/n-domain";
import { Logger } from "@nivinjoseph/n-log";
import { Db } from "../db/db.js";
import { QueryResult } from "../db/query-result.js";
import { BaseRepository } from "../repository/base-repository.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { AnyReadModel } from "./read-model.js";
import { ReadModelQuery } from "./read-model-query.js";
import { ReadModelRepository } from "./read-model-repository.js";
import { IntactReadModelSchema, ReadModelPredicate, ReadModelSchema } from "./read-model-schema.js";
/**
 * Reads and writes one read model's table: one row per instance, one real typed column per data
 * key, declared once by a {@link ReadModelSchema}.
 *
 * Publicly, {@link get} and {@link getByIds} cover lookup by id, {@link getAll} takes the whole
 * table, and {@link save}/{@link saveAll}/{@link delete} (with their `Within` forms) are the explicit writes. Any
 * other read is a method the concrete subclass names for itself, built over one of the `protected`
 * doors below:
 *
 * - **Filtering or sorting on a column** - {@link query}. It owns the statement - `select <columns>
 *   from <table> where (<your predicate>)` - so a subclass supplies the predicate and nothing else,
 *   with `order by`, `limit` and `offset` available through the {@link ReadModelQuery} object form.
 * - **By id, *and* on a column** - {@link queryById} or {@link queryByIds}, which return null or
 *   empty rather than throwing.
 * - **A shape none of those can express** - a join across read models, a CTE - {@link queryStatement},
 *   where the select list is the caller's to get right.
 * - **A read that does not map onto the model at all** - a group-by, a window function, an
 *   aggregate - {@link queryRaw}, which performs no hydration. This is the analytical door, and
 *   real columns are what make it worth having: any SQL runs against them. {@link exists} and
 *   {@link count} answer the two commonest shapes without a statement to write.
 *
 * **The schema is handed to the constructor, and that is the whole declaration.** The migration
 * creates the table from the same static, the row mapper writes and reads through it, and every
 * predicate is built by it - so a column that is queried is necessarily one that exists, with the
 * type it was declared at. Because `ReadModelSchema<T>` is fully determined by the model there is no
 * getter to override and nothing to widen; the only thing that can go wrong at the constructor is
 * handing it another model's schema, and that is a compile error.
 *
 * **Every save is an upsert.** A read model carries no change tracking, so `save` always writes
 * the row; re-projecting an unchanged model costs one statement and changes nothing.
 *
 * **Every column is nullable.** A column added to the schema after rows were written reads NULL
 * for them until they are re-projected, and a property typed non-null then fails in the class's own
 * constructor at hydration - re-project, rather than expecting the repository to invent a value.
 *
 * **No organization filter.** A read model is cross-organization by design: if a tenant id belongs
 * in it, it is a column like any other, and a subclass filters on it deliberately.
 *
 * @example
 * ```typescript
 * @inject("DomainContext", "Db", "UnitOfWork", "Logger")
 * export class PgOrderSummaryRepository extends ReadModelBaseRepository<OrderSummary> implements OrderSummaryRepository
 * {
 *     public static readonly schema = ReadModelSchema.for(OrderSummary, {
 *         customerId: { type: ColumnType.text, index: true },
 *         total: { type: ColumnType.numeric },
 *         placedAt: { type: ColumnType.timestamptz, index: true },
 *         tags: { type: ColumnType.textArray, index: true }
 *     });
 *
 *     public constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger)
 *     {
 *         super(domainContext, db, unitOfWork, logger, PgOrderSummaryRepository.schema);
 *     }
 *
 *     public getByCustomer(customerId: string): Promise<Array<OrderSummary>>
 *     {
 *         return this.query(this.schema.eq("customerId", customerId));
 *     }
 *
 *     public getPlacedSince(ms: number): Promise<Array<OrderSummary>>
 *     {
 *         return this.query({ where: this.schema.gte("placedAt", ms), orderBy: this.schema.orderBy("placedAt", "desc") });
 *     }
 *
 *     public async revenueByCustomer(): Promise<ReadonlyArray<{ customerId: string; revenue: number; }>>
 *     {
 *         const result = await this.queryRaw<{ customerId: string; revenue: number; }>(
 *             `select ${this.schema.columnFor("customerId")} as "customerId", cast(sum(${this.schema.columnFor("total")}) as double precision) as revenue
 *              from ${this.table} group by 1 order by 2 desc;`);
 *
 *         return result.rows;
 *     }
 * }
 *
 * // in the migration - the same object
 * await new ReadModelTableCreator(db, logger).createReadModelTable(PgOrderSummaryRepository.schema);
 * ```
 *
 * @class ReadModelBaseRepository
 */
export declare abstract class ReadModelBaseRepository<T extends AnyReadModel> extends BaseRepository implements ReadModelRepository<T> {
    private readonly _schema;
    private readonly _mapper;
    /**
     * The declaration this repository was built over, and the typed predicates over it.
     */
    protected get schema(): ReadModelSchema<T>;
    /**
     * `id, <column>, ...` - what {@link query} selects, for a subclass writing a join or a CTE
     * through {@link queryStatement}.
     */
    protected get selectList(): string;
    /**
     * @param {DomainContext} domainContext - The domain context for the current operation. Not consulted here - a read model is cross-organization - but every repository in this library takes one, so the injection shape is the same.
     * @param {Db} db - The database.
     * @param {UnitOfWork} unitOfWork - The default unit of work for the owned writes.
     * @param {Logger} logger - Where errors and shape advisories go.
     * @param {IntactReadModelSchema<T>} schema - The repository's declaration, normally its `schema` static. Typed through the intact brand, so a schema widened to `ReadModelSchema<any>` is refused. A generic layer of your own that forwards a schema here must take it as `IntactReadModelSchema<T>` too - `ReadModelSchema<T>` under an unresolved `T` is refused with the same diagnostic.
     */
    protected constructor(domainContext: DomainContext, db: Db, unitOfWork: UnitOfWork, logger: Logger, schema: IntactReadModelSchema<T>);
    /**
     * The read model with this id.
     *
     * @throws {ReadModelNotFoundException} If no row carries the id.
     */
    get(id: string): Promise<T>;
    /**
     * The read models with these ids, in whatever order the table returns them.
     *
     * Ids that are blank once trimmed are dropped, and if that leaves none the result is empty
     * without a statement being run. To load only the ids that also satisfy a condition, a subclass
     * builds its own method over {@link queryByIds}.
     */
    getByIds(ids: ReadonlyArray<string>): Promise<Array<T>>;
    /**
     * Every row in the table. Unbounded, and takes no arguments so that it can only be called on
     * purpose; for anything narrower, or for ordering and paging, build a method over {@link query}.
     */
    getAll(): Promise<Array<T>>;
    /**
     * Writes the read model - an insert, or a replacement of the row carrying its id - in a
     * transaction this repository owns, and commits it, or rolls it back and rethrows.
     *
     * Every column's value is checked against its declared type and range first, and a value the
     * column cannot hold throws before anything is queued (pg would otherwise coerce it silently, or
     * fail after the unit of work is rolled back). The first save per schema per process also logs the
     * shape advisories - a decorated getter left out of `TDataKeys`, a declared key whose getter is
     * undecorated, a `@serialize` rename - once, read from the class's metadata.
     *
     * @throws {ArgumentException} If the model is not an instance of the schema's class, or a value does not fit its column.
     */
    save(model: T): Promise<void>;
    /**
     * Writes the read model into a transaction the caller owns, and **does not commit**. Checked
     * exactly as {@link save} is.
     *
     * @throws {ArgumentException} If the model is not an instance of the schema's class, or a value does not fit its column.
     */
    saveWithin(model: T, unitOfWork: UnitOfWork): Promise<void>;
    /**
     * Writes a batch of read models in a transaction this repository owns, and commits it, or rolls
     * it back and rethrows.
     *
     * One multi-row upsert per chunk of up to 500 rows (fewer for a very wide table, since Postgres
     * binds at most 65535 parameters per statement), so a re-projection of thousands of rows costs a
     * few round trips rather than one per row. Every model is checked - its class, every value
     * against its column - before anything is queued, so a bad row anywhere rejects the batch whole,
     * named by its position and id; and a batch may not carry the same id twice, because Postgres
     * refuses to upsert one row twice in a statement. An empty batch writes nothing and leaves the
     * unit of work untouched.
     *
     * The rows go out **sorted by id**, whatever order they arrived in: a multi-row upsert locks each
     * row as it reaches it, so two concurrent batches over overlapping ids in different orders could
     * deadlock. One order for every batch removes that between batches; a batch can still deadlock
     * against some other transaction that locks the same rows in another order, which is the usual
     * Postgres rule and not something a repository can prevent.
     *
     * @throws {ArgumentException} If a model is not an instance of the schema's class, a value does not fit its column, or an id repeats within the batch.
     */
    saveAll(models: ReadonlyArray<T>): Promise<void>;
    /**
     * Writes a batch into a transaction the caller owns, and **does not commit**. Checked and chunked
     * exactly as {@link saveAll} is.
     *
     * @throws {ArgumentException} If a model is not an instance of the schema's class, a value does not fit its column, or an id repeats within the batch.
     */
    saveAllWithin(models: ReadonlyArray<T>, unitOfWork: UnitOfWork): Promise<void>;
    /**
     * Removes the row with this id in a transaction this repository owns, and commits it. A no-op
     * when no row carries the id - a delete is not row-count checked.
     */
    delete(id: string): Promise<void>;
    /**
     * Removes the row with this id into a transaction the caller owns, and **does not commit**.
     */
    deleteWithin(id: string, unitOfWork: UnitOfWork): Promise<void>;
    /**
     * Runs a query and hydrates each row into a read model.
     *
     * This owns the statement: `select <columns> from <this.table> where (<your predicate>)`, so
     * what you supply is the predicate, built by {@link schema}, which carries its own values. Pass a
     * {@link ReadModelQuery} instead of a bare predicate to add `order by`, `limit` or `offset`, or to
     * run with no predicate at all (`{}`).
     *
     * @throws {ArgumentException} If the predicate or an order-by term was built by another schema; or if the predicate is malformed, orderBy is empty or contains a ';', or limit or offset is not a non-negative integer.
     */
    protected query(whereOrQuery: ReadModelPredicate | ReadModelQuery): Promise<Array<T>>;
    /**
     * The read model with this id, if it also satisfies `predicate`. **Returns null rather than
     * throwing**, for a missing id and an excluded one alike.
     */
    protected queryById(id: string, predicate?: ReadModelPredicate): Promise<T | null>;
    /**
     * The read models with these ids that also satisfy `predicate`. Blank ids are dropped; none
     * left means no statement runs.
     */
    protected queryByIds(ids: ReadonlyArray<string>, predicate?: ReadModelPredicate): Promise<Array<T>>;
    /**
     * Whether anything matches - without hydrating it. `excludeId` is what makes "is this value
     * taken by someone *else*" work on an update; it goes into the statement so the read stops at
     * the first match.
     */
    protected exists(predicate?: ReadModelPredicate, excludeId?: string): Promise<boolean>;
    /**
     * How many rows match - without hydrating them. For a count broken down by something, use
     * {@link queryRaw}.
     */
    protected count(predicate?: ReadModelPredicate): Promise<number>;
    /**
     * Runs a raw SQL query and returns the unprocessed {@link QueryResult} - the analytical door.
     *
     * Name columns through {@link schema}'s `columnFor` rather than by hand. Note what pg hands back
     * with no type parsers installed: `bigint` and `numeric` arrive as strings (cast in the statement,
     * as `cast(count(*) as int)` does), and `timestamptz` as a `Date`.
     *
     * @template TRow - The expected shape of each returned row.
     */
    protected queryRaw<TRow>(sql: string, ...params: ReadonlyArray<any>): Promise<QueryResult<TRow>>;
    /**
     * Runs a whole statement and hydrates each row into a read model - the escape hatch from
     * {@link query} for a join, a union, a CTE.
     *
     * The contract: every row must carry `id` and every declared column under its column name
     * ({@link selectList} is that list; `select *` satisfies it). A missing column throws, naming
     * it; an extra one is ignored.
     */
    protected queryStatement(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>;
    private _save;
    private _saveAll;
    private _delete;
    /**
     * The envelope every write shares: run the statements, commit when this repository owns the
     * unit of work; on failure log, roll back when owned, and rethrow. A shared unit of work is left
     * to its owner either way.
     */
    private _write;
    private _materialize;
    /**
     * The runtime half of the table brand: a predicate built by another schema is refused here,
     * before it reaches a statement - a `timestamptz` conversion applied under the wrong schema would
     * be a silent wrong answer.
     */
    private _ensureOwnPredicate;
    private _ensureOwnQuery;
}
//# sourceMappingURL=read-model-base-repository.d.ts.map