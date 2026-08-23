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
import { executeRawQuery } from "./raw-query.js";
import type { DeclaredSnapshotQuerySet, SnapshotPredicate } from "../migration/snapshot-query-set.js";
import { SnapshotShapeGuard } from "./snapshot-shape-guard.js";
import { snapshotDocumentToState, toSnapshotDocument, type SnapshotDocumentOf } from "../migration/snapshot-document.js";

/**
 * Reads aggregates from the snapshot table - the materialized current state - and writes
 * both the snapshot and the underlying event stream on save.
 *
 * The snapshot table holds one row per aggregate: `id` (the primary key) and `data` (the
 * serialized state as jsonb). Publicly, {@link get} and {@link getByIds} cover lookup by id, which
 * the primary key already indexes, and {@link getAll} takes the whole table. Any other read is a
 * method the concrete subclass names for itself, built over one of the `protected` doors below.
 *
 * Which door depends on what the read is shaped like:
 *
 * - **Filtering or sorting on a field *inside* `data`** - {@link query}. It owns the statement it
 *   runs - `select data from <table> where (<your predicate>)` - so a subclass supplies the predicate
 *   and nothing else, with `order by`, `limit` and `offset` available through the `RepositoryQuery`
 *   object form.
 * - **By id, *and* on a field inside `data`** - {@link queryById} or {@link queryByIds}. This one
 *   cannot be built over `query`: `id` is a column beside `data`, so a `SnapshotQuerySet` cannot
 *   reach it, and `query` takes nothing but a predicate from one. The pair is where the two halves
 *   meet, and it returns null rather than throwing.
 * - **A shape none of those can express** - a join, a union, a CTE - {@link queryStatement}, where
 *   everything `query` guarantees becomes the caller's to get right.
 * - **A read that does not map onto the aggregate at all** - a count, a group-by, a projection -
 *   {@link queryRaw}, which performs no deserialization. {@link exists} and {@link count} answer the
 *   two commonest of those without a statement to write.
 *
 * **Declare what is queryable with a `SnapshotQuerySet`, exposed by overriding {@link querySet}.**
 * That one object is both what the migration creates the table's indexes from and
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
 *     // required by the base, which declares it abstract at the declaration-only
 *     // DeclaredSnapshotQuerySet type; the `typeof` is what carries the narrow, queryable one
 *     // to the call sites
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
 *
 *     public getOpen(id: string): Promise<Order | null>
 *     {
 *         // by id AND on a declared path - `query` cannot express this, because `id` is a column
 *         // beside `data` and no query set predicate can reach it. Returns null rather than
 *         // throwing, for a missing id and an excluded one alike
 *         return this.queryById(id, this.querySet.eq("status", "open"));
 *     }
 * }
 *
 * // in the migration - the same object, so a queried index is necessarily a created one
 * await tableCreator.createSnapshotTableForAggregate(Order, OrderRepository.indexes);
 *
 * // and in an integration test - the same object again, so a declaration changed after the
 * // migration ran (which `if not exists` silently ignores) has a detector
 * assert.deepStrictEqual(await tableCreator.verifySnapshotTableForAggregate(Order, OrderRepository.indexes), []);
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
     * **Abstract on purpose.** The declared return type is `DeclaredSnapshotQuerySet` - the
     * declarations only, with not one query method on it - because the base cannot know which paths a
     * subclass chooses. Implement it by returning the `SnapshotQuerySet` static, typed with `typeof`:
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
     * The `typeof` is what carries the narrow type to the call sites, and the trap it guards against is
     * closed twice over: an override that copies THIS declared type gets an object that cannot build a
     * single predicate (no `eq`, no `contains` - the mistake announces itself at the first query), and
     * the old widened spelling `SnapshotQuerySet<TState, any, any>` - which used to compile and silently
     * give up path and cast checking - is now itself a compile error whose message names the fix.
     *
     * `_save` reads this getter, to verify the declared paths against the first snapshot it stores.
     * Nothing should read it from a constructor: a subclass may back it with an instance field rather
     * than a static, and a subclass field initializer runs *after* `super()` - so a constructor-time
     * read would see `undefined`.
     */
    protected abstract get querySet(): DeclaredSnapshotQuerySet<TState>;

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


    /**
     * The aggregates with these ids, in whatever order the table returns them.
     *
     * Ids that are blank once trimmed are dropped, and if that leaves none the result is empty -
     * asking for zero ids returns zero aggregates, which is unremarkable because the caller passed an
     * array. It was not always: as `getAll(...ids)` this shared a signature with {@link getAll}, so
     * the empty case had to stand for either everything or nothing and could not be read off the call.
     *
     * To load only the ids that also satisfy a condition, a subclass builds its own method over
     * {@link queryByIds} - the predicate belongs inside the class, not on this signature.
     *
     * @param {ReadonlyArray<string>} ids - The aggregate ids to load.
     * @returns {Promise<Array<T>>} The aggregates found; empty when none of the ids matched, or when no usable id was given.
     */
    public getByIds(ids: ReadonlyArray<string>): Promise<Array<T>>
    {
        return this.queryByIds(ids);
    }

    /**
     * Every row in the snapshot table.
     *
     * **Unbounded, and takes no arguments so that it can only be called on purpose.** It is
     * {@link query} with no predicate; for anything narrower, or for ordering and paging, build a
     * method on the subclass over `query` - or over {@link queryByIds}, when the narrowing is by id
     * as well.
     *
     * @returns {Promise<Array<T>>} Every aggregate, deserialized.
     */
    public getAll(): Promise<Array<T>>
    {
        return this.query({});
    }

    /**
     * The aggregate with this id.
     *
     * To load it only if it also satisfies a condition, a subclass builds its own method over
     * {@link queryById} - the predicate belongs inside the class, not on this signature.
     *
     * @param {string} id - The aggregate id to load.
     * @returns {Promise<T>} The aggregate.
     * @throws {AggregateNotFoundException} If no row carries the id.
     */
    public async get(id: string): Promise<T>
    {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();

        const result = await this.queryById(id);

        if (result == null)
            throw new AggregateNotFoundException(this._eventStreamRepository.aggregateType, id);

        return result;
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
     * **`force` re-writes the row for an aggregate that has not changed**, which is what a data
     * migration needs when the stored *shape* moved rather than the state: a newly `@serialize`d
     * computed field on a value object, declared on {@link querySet} and indexed by a migration, is
     * absent from every row written before it existed. Load each aggregate and save it back with
     * `force`, and `data` is re-serialized from the current code.
     *
     * It bypasses this repository's change check and nothing else. The event stream keeps its own, so
     * an unchanged aggregate appends no events and fires no `onSave` - a re-save does not republish
     * history - and the write is the same `on conflict (id) do update` upsert an ordinary update
     * takes. Prefer {@link saveWithin} with `force` across a migration, so a batch lands as one
     * transaction rather than one per aggregate.
     *
     * `force` lives here and not on {@link Repository}, whose `save` the event stream repositories
     * also implement and could not honor - an unchanged aggregate has no events to append. So it is
     * reachable through a snapshot repository's own type; a caller holding the `Repository<T>`
     * interface, or a domain interface extending it, does not see it.
     *
     * @param {T} value - The aggregate to save. A no-op when it is neither new nor changed, unless `force`.
     * @param {boolean} [force=false] - Writes the snapshot row even when the aggregate is neither new nor changed. For a data migration that re-serializes stored state; see above.
     * @throws {ApplicationException} If a declared index path has a fatal shape issue against the document being saved.
     */
    public save(value: T, force = false): Promise<void>
    {
        return this._save(value, this.unitOfWork, true, force);
    }

    /**
     * Saves the snapshot and the underlying event stream into a transaction the caller owns, and
     * **does not commit**.
     *
     * Shape-verified exactly as {@link save} is - a fatal issue throws before anything is queued on
     * the caller's transaction.
     *
     * This is the door a data migration wants: `force` here re-writes each unchanged row into the
     * caller's transaction, so a batch commits once rather than once per aggregate. See {@link save}
     * for what forcing does and does not touch.
     *
     * @param {T} value - The aggregate to save. A no-op when it is neither new nor changed, unless `force`.
     * @param {UnitOfWork} unitOfWork - The caller's transaction. Required; committing it is theirs to do.
     * @param {boolean} [force=false] - Writes the snapshot row even when the aggregate is neither new nor changed.
     * @throws {ApplicationException} If a declared index path has a fatal shape issue against the document being saved.
     */
    public saveWithin(value: T, unitOfWork: UnitOfWork, force = false): Promise<void>
    {
        given(unitOfWork, "unitOfWork").ensureHasValue().ensureIsObject();

        return this._save(value, unitOfWork, false, force);
    }


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
     * `offset`, or to run with no predicate at all (`{}`). To constrain the id as well as the
     * predicate, use {@link queryById} or {@link queryByIds} - `id` is a column beside `data`, so no
     * predicate this takes can reach it. For a read the built statement cannot express - a join, a
     * union, a CTE - use {@link queryStatement}. For reads whose shape does not map onto the
     * aggregate - counts, group-bys, projections - use {@link queryRaw}, which performs no
     * deserialization.
     *
     * @param {SnapshotPredicate | RepositoryQuery} whereOrQuery - A predicate from {@link querySet}, or the predicate and the clauses that follow it.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'; if orderBy is empty or contains a ';'; or if limit or offset is not a non-negative integer.
     */
    protected async query(whereOrQuery: SnapshotPredicate | RepositoryQuery): Promise<Array<T>>
    {
        const built = RepositoryQueryBuilder.build(this.table, whereOrQuery, []);

        return this._deserialize(await this.queryRaw<any>(built.sql, ...built.params));
    }

    /**
     * The aggregate with this id, if it also satisfies `predicate`.
     *
     * The id column is the one thing a {@link querySet} cannot reach - its paths read inside `data`,
     * and the primary key is a column beside it - so an id lookup and a declared-path condition come
     * from different places and cannot be composed by the caller. This is where they meet: the
     * statement is `where (id in (?) and (<your predicate>))`, with the predicate parenthesized
     * inside the whole so a top-level `or` in it cannot escape the id filter.
     *
     * **Returns null rather than throwing**, unlike {@link get}, and does so for both misses alike -
     * no such id, and an id whose row the predicate excluded. The two are not distinguished here on
     * purpose: only the subclass knows what its predicate meant, so only the subclass can say whether
     * an excluded row is exceptional. Throwing, if that is the answer, is three lines at the call
     * site; unthrowing is not.
     *
     * @param {string} id - The aggregate id to load.
     * @param {SnapshotPredicate} [predicate] - A further condition the row must satisfy; omitted loads by id alone.
     * @returns {Promise<T | null>} The aggregate, or null when nothing matched.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'.
     */
    protected async queryById(id: string, predicate?: SnapshotPredicate): Promise<T | null>
    {
        given(id, "id").ensureHasValue().ensureIsString();

        const result = await this.queryByIds([id], predicate);

        // at most one, because id is the primary key
        return result.isEmpty ? null : result[0];
    }

    /**
     * The aggregates with these ids that also satisfy `predicate`, in whatever order the table
     * returns them.
     *
     * The set-shaped counterpart to {@link queryById}, and the read {@link getByIds} is built from -
     * so the id hygiene is the same one: ids that are blank once trimmed are dropped, and if that
     * leaves none the result is empty without a statement being run at all.
     *
     * @param {ReadonlyArray<string>} ids - The aggregate ids to load.
     * @param {SnapshotPredicate} [predicate] - A further condition each row must satisfy; omitted loads by id alone.
     * @returns {Promise<Array<T>>} The aggregates found; empty when nothing matched, or when no usable id was given.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'.
     */
    protected queryByIds(ids: ReadonlyArray<string>, predicate?: SnapshotPredicate): Promise<Array<T>>
    {
        given(ids, "ids").ensureHasValue().ensureIsArray();

        const trimmed = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());
        if (trimmed.isEmpty)
            return Promise.resolve([]);

        return this.query(RepositoryQueryBuilder.idPredicate("id", trimmed, predicate));
    }

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
    protected async exists(predicate?: SnapshotPredicate, excludeId?: string): Promise<boolean>
    {
        const built = RepositoryQueryBuilder.buildExists(this.table, predicate, excludeId);

        return !(await this.queryRaw<unknown>(built.sql, ...built.params)).isEmpty;
    }

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
    protected async count(predicate?: SnapshotPredicate): Promise<number>
    {
        const built = RepositoryQueryBuilder.buildCount(this.table, predicate);
        const result = await this.queryRaw<{ count: number; }>(built.sql, ...built.params);

        return result.rows[0].count;
    }

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
    protected queryRaw<TRow>(sql: string, ...params: ReadonlyArray<any>): Promise<QueryResult<TRow>>
    {
        return executeRawQuery<TRow>(this.db, sql, params);
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

    /**
     * The body both save doors share; `owned` is who commits and `force` is whether the change check
     * applies, and between them they are the whole of what separates one call from another.
     */
    private async _save(value: T, unitOfWork: UnitOfWork, owned: boolean, force: boolean): Promise<void>
    {
        given(value, "value").ensureHasValue().ensureIsObject().ensureIsType(this._eventStreamRepository.aggregateType);
        given(force, "force").ensureHasValue().ensureIsBoolean();

        if (!force && !value.isNew && !value.hasChanges)
            return;

        try
        {
            // shape-checked against the declared paths before anything is queued on the unit of
            // work, so a fatal issue (a @serialize rename, raw-path drift) rejects the save whole -
            // once per process per query set, one WeakSet lookup per save after that
            const snapshot = toSnapshotDocument(value);
            await SnapshotShapeGuard.verify(this.table, this.querySet, snapshot, this.logger);

            // always the non-committing door: this repository decides whether the transaction gets
            // committed, and the event stream write has to land or not land with the snapshot write.
            // It keeps its own change check, and `force` deliberately does not reach it: a forced
            // re-save of an unchanged aggregate appends no events and registers no onSave, which is
            // both what a migration wants and what keeps an empty `values ;` list - a syntax error -
            // out of the statement it would otherwise build
            await this._eventStreamRepository.saveWithin(value, unitOfWork);

            // both branches write the same row from the same values; the conflict clause is the only
            // difference, and it is what makes a second save of a known aggregate an update rather
            // than a primary key violation
            const sql = value.isNew
                ? `insert into ${this.table}
                            (id, data)
                            values(?, ?);`
                : `insert into ${this.table}
                            (id, data)
                            values(?, ?)
                            on conflict (id) do update
                            set data = excluded.data;`;

            await this.db.executeCommandWithinUnitOfWork(unitOfWork, sql, value.id, snapshot);

            if (owned)
                await unitOfWork.commit();
        }
        catch (error)
        {
            await this.logger.logError(error as any);

            if (owned)
                await unitOfWork.rollback();

            throw error;
        }
    }

    private _deserialize(queryResult: QueryResult<any>): Array<T>
    {
        if (queryResult.isEmpty)
            return [];

        return queryResult.rows.map(t => t.data as SnapshotDocumentOf<TState>)
            .map(t => AggregateRoot.deserializeFromSnapshot(this.domainContext, this._eventStreamRepository.aggregateType, this._eventStreamRepository.aggregateStateFactory, snapshotDocumentToState(t)));
    }
}