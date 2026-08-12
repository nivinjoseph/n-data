import { AggregateRoot, AggregateState, DomainEvent } from "@nivinjoseph/n-domain";
import { EventStreamBaseRepository } from "./event-stream-base-repository.js";
import { Repository } from "./repository.js";
import { BaseRepository } from "./base-repository.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { RepositoryQuery } from "./repository-query.js";
import { QueryResult } from "../db/query-result.js";
import { SnapshotPredicate, SnapshotQuerySet } from "../migration/snapshot-query-set.js";
/**
 * Reads aggregates from the snapshot table - the materialized current state - and writes
 * both the snapshot and the underlying event stream on save.
 *
 * The snapshot table holds one row per aggregate: `id` (the primary key) and `data` (the
 * serialized state as jsonb). {@link get} and {@link getByIds} cover lookup by id, which the
 * primary key already indexes, and {@link getAll} takes the whole table. Any other read -
 * filtering or sorting on a field *inside* `data` - needs a method on the concrete subclass
 * built over {@link query}.
 *
 * {@link query} owns the statement it runs - `select data from <table> where (<your predicate>)` - so
 * a subclass supplies the predicate and nothing else, with `order by`, `limit` and `offset` available
 * through the `RepositoryQuery` object form. {@link queryStatement} is the escape hatch for a read
 * that shape cannot express.
 *
 * **Declare what is queryable with a `SnapshotQuerySet`, handed to `super` and exposed by overriding
 * {@link querySet}.** That one object is both what the migration creates the table's indexes from and
 * what the predicates are built by, so an index that is queried is necessarily one that was created.
 * `DbTableCreator` builds a btree expression index per path; nothing is added to the table, since the
 * index is built directly over the extraction expression.
 *
 * That single source is what the type checking rests on. `this.querySet.eq("status", value)` accepts
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
 * expressible in the set - read `info.createdIndexes` from the create call for each index's column order.
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
 *     protected override get querySet(): typeof OrderRepository.indexes { return OrderRepository.indexes; }
 *
 *     public constructor(eventStreamRepository: OrderEventStreamRepository)
 *     {
 *         super(eventStreamRepository);
 *     }
 *
 *     public getByStatus(status: string): Promise<Array<Order>>
 *     {
 *         return this.query(this.querySet.eq("status", status));
 *     }
 *
 *     public getOverTotal(total: number): Promise<Array<Order>>
 *     {
 *         // a number, because `total` declared a numeric cast - without one this would not compile
 *         return this.query(this.querySet.gt("total", total));
 *     }
 *
 *     public getByTag(tag: string): Promise<Array<Order>>
 *     {
 *         return this.query(this.querySet.contains("tags", tag));
 *     }
 *
 *     public getLargestOrders(count: number): Promise<Array<Order>>
 *     {
 *         // ordering and paging go on the object form; there is no predicate here
 *         return this.query({ orderBy: this.querySet.orderBy("total", "desc"), limit: count });
 *     }
 * }
 *
 * // in the migration - the same object, so a queried index is necessarily a created one
 * await tableCreator.createSnapshotTableForAggregate(Order, OrderRepository.indexes);
 * ```
 *
 * @class SnapshotBaseRepository
 */
export declare abstract class SnapshotBaseRepository<T extends AggregateRoot<TState, TDomainEvent>, TState extends AggregateState, TDomainEvent extends DomainEvent<TState>> extends BaseRepository implements Repository<T> {
    private readonly _eventStreamRepository;
    /**
     * The indexes this repository declares, and the typed predicates over them.
     *
     * **Abstract on purpose.** The declared return type is widened - the base cannot know which paths a
     * subclass chooses - so implement it by returning the `SnapshotQuerySet` static, typed with `typeof`:
     *
     * ```typescript
     * public static readonly indexes = SnapshotQuerySet.for<OrderState>().withPath("status");
     *
     * protected override get querySet(): typeof OrderRepository.indexes { return OrderRepository.indexes; }
     * ```
     *
     * The two names in that line are deliberate, not an oversight to be tidied up. One object wears the
     * name of the job each side does with it: the migration reads the static to create the table's
     * *indexes*, and this getter is what the *queries* below are built from.
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
    protected abstract get querySet(): SnapshotQuerySet<TState, any, any>;
    get eventStreamRepository(): EventStreamBaseRepository<T, TState, TDomainEvent>;
    /**
     * @param {EventStreamBaseRepository} eventStreamRepository - The event stream this snapshot is materialized from; the source of the db, unit of work, logger and domain context.
     */
    protected constructor(eventStreamRepository: EventStreamBaseRepository<T, TState, TDomainEvent>);
    /**
     * The aggregates with these ids, in whatever order the table returns them.
     *
     * Ids that are blank once trimmed are dropped, and if that leaves none the result is empty -
     * asking for zero ids returns zero aggregates, which is unremarkable because the caller passed an
     * array. It was not always: as `getAll(...ids)` this shared a signature with {@link getAll}, so
     * the empty case had to stand for either everything or nothing and could not be read off the call.
     *
     * @param {ReadonlyArray<string>} ids - The aggregate ids to load.
     * @returns {Promise<Array<T>>} The aggregates found; empty when none of the ids matched, or when no usable id was given.
     */
    getByIds(ids: ReadonlyArray<string>): Promise<Array<T>>;
    /**
     * Every row in the snapshot table.
     *
     * **Unbounded, and takes no arguments so that it can only be called on purpose.** It is
     * {@link query} with no predicate; for anything narrower, or for ordering and paging, build a
     * method on the subclass over `query` instead.
     *
     * @returns {Promise<Array<T>>} Every aggregate, deserialized.
     */
    getAll(): Promise<Array<T>>;
    get(id: string): Promise<T>;
    /**
     * Saves the snapshot and the underlying event stream in a transaction this repository owns, and
     * commits it - or rolls it back and rethrows if anything fails.
     *
     * The transaction is this repository's own {@link BaseRepository.unitOfWork}. If anything else
     * was queued on that same instance, **this commits that too**, because a unit of work commits as
     * a whole. Use {@link saveWithin} when several writes have to land together.
     *
     * @param {T} value - The aggregate to save. A no-op when it is neither new nor changed.
     */
    save(value: T): Promise<void>;
    /**
     * Saves the snapshot and the underlying event stream into a transaction the caller owns, and
     * **does not commit**.
     *
     * @param {T} value - The aggregate to save. A no-op when it is neither new nor changed.
     * @param {UnitOfWork} unitOfWork - The caller's transaction. Required; committing it is theirs to do.
     */
    saveWithin(value: T, unitOfWork: UnitOfWork): Promise<void>;
    /**
     * Runs a query and deserializes each row into an aggregate.
     *
     * This owns the statement: `select data from <this.table> where (<your predicate>)`. So what you
     * supply is the predicate, without the `where` keyword.
     *
     * **A predicate always carries its own values.** Every one comes from {@link querySet} - a typed
     * `eq`/`gt`/`in`/`contains`, a combinator, or `raw` for a hand-written fragment - and each binds
     * its own `?` placeholders. There is nothing to pass positionally and no way to mis-order the
     * binding, which is why this takes no parameters beyond the predicate itself.
     *
     * Pass a {@link RepositoryQuery} instead of a bare predicate to add `order by`, `limit` or
     * `offset`, or to run with no predicate at all (`{}`). For a read the built statement cannot
     * express - a join, a union, a CTE - use {@link queryStatement}. For reads whose shape does not
     * map onto the aggregate - counts, group-bys, projections - use {@link queryRaw}, which performs
     * no deserialization.
     *
     * @param {SnapshotPredicate | RepositoryQuery} whereOrQuery - A predicate from {@link querySet}, or the predicate and the clauses that follow it.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'; if orderBy is empty or contains a ';'; or if limit or offset is not a non-negative integer.
     */
    protected query(whereOrQuery: SnapshotPredicate | RepositoryQuery): Promise<Array<T>>;
    /**
     * Whether anything matches - without deserializing it.
     *
     * The question a natural-key rule asks: *is this value already taken, by
     * someone other than me*. `excludeId` is what makes the "other than me" half work on an update, and it is
     * a parameter rather than something a caller filters out afterwards because it goes into the statement,
     * which is what lets the read stop at the first match instead of materializing every one.
     *
     * Unlike {@link queryRaw}, this applies the same filtering {@link query} does.
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
    protected exists(predicate?: SnapshotPredicate, excludeId?: string): Promise<boolean>;
    /**
     * How many rows match - without deserializing them.
     *
     * The counterpart to {@link exists}, and scoped the same way. For a count broken down by something -
     * a group-by - use {@link queryRaw}: that shape is a projection rather than a single
     * number, and this cannot express it.
     *
     * @param {SnapshotPredicate} [predicate] - What to count; omitted counts every row.
     * @returns {Promise<number>} The number of matching rows.
     */
    protected count(predicate?: SnapshotPredicate): Promise<number>;
    /**
     * Runs a raw SQL query and returns the unprocessed {@link QueryResult}.
     *
     * For reads whose shape does not map onto the aggregate - counts, group-bys, projections - so no
     * deserialization is attempted. Build any expression over `data` from {@link querySet}'s
     * `expressionFor`, so a grouping or filtering expression still matches the index it was created
     * from.
     *
     * @template TRow - The expected shape of each returned row.
     * @param {string} sql - The statement to run.
     * @param {...ReadonlyArray<any>} params - Values bound to the statement's `?` placeholders.
     * @returns {Promise<QueryResult<TRow>>} The raw query result.
     */
    protected queryRaw<TRow>(sql: string, ...params: ReadonlyArray<any>): Promise<QueryResult<TRow>>;
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
    protected queryStatement(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>;
    /**
     * The body both save doors share; `owned` is the whole of what separates them.
     */
    private _save;
    private _deserialize;
}
//# sourceMappingURL=snapshot-base-repository.d.ts.map