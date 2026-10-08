import { given } from "@nivinjoseph/n-defensive";
import { ArgumentException } from "@nivinjoseph/n-exception";
import { BaseRepository } from "../repository/base-repository.js";
import { executeRawQuery } from "../repository/raw-query.js";
import { RepositoryQueryBuilder } from "../repository/repository-query.js";
import { ReadModelNotFoundException } from "./read-model-not-found-exception.js";
import { ReadModelRowMapper } from "./read-model-row-mapper.js";
import { ReadModelSchema } from "./read-model-schema.js";
import { ReadModelShapeGuard } from "./read-model-shape-guard.js";
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
export class ReadModelBaseRepository extends BaseRepository {
    _schema;
    _mapper;
    /**
     * The declaration this repository was built over, and the typed predicates over it.
     */
    get schema() { return this._schema; }
    /**
     * `id, <column>, ...` - what {@link query} selects, for a subclass writing a join or a CTE
     * through {@link queryStatement}.
     */
    get selectList() { return this._mapper.selectList; }
    /**
     * @param {DomainContext} domainContext - The domain context for the current operation. Not consulted here - a read model is cross-organization - but every repository in this library takes one, so the injection shape is the same.
     * @param {Db} db - The database.
     * @param {UnitOfWork} unitOfWork - The default unit of work for the owned writes.
     * @param {Logger} logger - Where errors and shape advisories go.
     * @param {IntactReadModelSchema<T>} schema - The repository's declaration, normally its `schema` static. Typed through the intact brand, so a schema widened to `ReadModelSchema<any>` is refused. A generic layer of your own that forwards a schema here must take it as `IntactReadModelSchema<T>` too - `ReadModelSchema<T>` under an unresolved `T` is refused with the same diagnostic.
     */
    constructor(domainContext, db, unitOfWork, logger, schema) {
        // viewed as `object` for the ensurer: its instanceof check is typed over the branded intersection
        given(schema, "schema").ensureHasValue().ensureIsObject().ensureIsInstanceOf(ReadModelSchema);
        super(domainContext, db, unitOfWork, logger, schema.table);
        this._schema = schema;
        this._mapper = new ReadModelRowMapper(schema.table, schema.typeName, schema.columns);
    }
    /**
     * The read model with this id.
     *
     * @throws {ReadModelNotFoundException} If no row carries the id.
     */
    async get(id) {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();
        const result = await this.queryById(id);
        if (result == null)
            throw new ReadModelNotFoundException(this._schema.modelType, id);
        return result;
    }
    /**
     * The read models with these ids, in whatever order the table returns them.
     *
     * Ids that are blank once trimmed are dropped, and if that leaves none the result is empty
     * without a statement being run. To load only the ids that also satisfy a condition, a subclass
     * builds its own method over {@link queryByIds}.
     */
    getByIds(ids) {
        return this.queryByIds(ids);
    }
    /**
     * Every row in the table. Unbounded, and takes no arguments so that it can only be called on
     * purpose; for anything narrower, or for ordering and paging, build a method over {@link query}.
     */
    getAll() {
        return this.query({});
    }
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
    save(model) {
        return this._save(model, this.unitOfWork, true);
    }
    /**
     * Writes the read model into a transaction the caller owns, and **does not commit**. Checked
     * exactly as {@link save} is.
     *
     * @throws {ArgumentException} If the model is not an instance of the schema's class, or a value does not fit its column.
     */
    saveWithin(model, unitOfWork) {
        given(unitOfWork, "unitOfWork").ensureHasValue().ensureIsObject();
        return this._save(model, unitOfWork, false);
    }
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
    saveAll(models) {
        return this._saveAll(models, this.unitOfWork, true);
    }
    /**
     * Writes a batch into a transaction the caller owns, and **does not commit**. Checked and chunked
     * exactly as {@link saveAll} is.
     *
     * @throws {ArgumentException} If a model is not an instance of the schema's class, a value does not fit its column, or an id repeats within the batch.
     */
    saveAllWithin(models, unitOfWork) {
        given(unitOfWork, "unitOfWork").ensureHasValue().ensureIsObject();
        return this._saveAll(models, unitOfWork, false);
    }
    /**
     * Removes the row with this id in a transaction this repository owns, and commits it. A no-op
     * when no row carries the id - a delete is not row-count checked.
     */
    delete(id) {
        return this._delete(id, this.unitOfWork, true);
    }
    /**
     * Removes the row with this id into a transaction the caller owns, and **does not commit**.
     */
    deleteWithin(id, unitOfWork) {
        given(unitOfWork, "unitOfWork").ensureHasValue().ensureIsObject();
        return this._delete(id, unitOfWork, false);
    }
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
    async query(whereOrQuery) {
        this._ensureOwnQuery(whereOrQuery);
        const built = RepositoryQueryBuilder.buildSelect(this._mapper.selectList, this.table, whereOrQuery, []);
        return this._materialize(await this.queryRaw(built.sql, ...built.params));
    }
    /**
     * The read model with this id, if it also satisfies `predicate`. **Returns null rather than
     * throwing**, for a missing id and an excluded one alike.
     */
    async queryById(id, predicate) {
        given(id, "id").ensureHasValue().ensureIsString();
        const result = await this.queryByIds([id], predicate);
        // at most one, because id is the primary key
        return result.isEmpty ? null : result[0];
    }
    /**
     * The read models with these ids that also satisfy `predicate`. Blank ids are dropped; none
     * left means no statement runs.
     */
    async queryByIds(ids, predicate) {
        given(ids, "ids").ensureHasValue().ensureIsArray();
        this._ensureOwnPredicate(predicate, "predicate");
        const trimmed = ids.map(t => t.trim()).where(t => t.isNotEmptyOrWhiteSpace());
        if (trimmed.isEmpty)
            return [];
        // the id predicate is assembled by the shared builder for this table, so this repository is
        // the one that brands it - the predicate it conjoins was checked above
        const byId = RepositoryQueryBuilder.idPredicate("id", trimmed, predicate);
        const built = RepositoryQueryBuilder.buildSelect(this._mapper.selectList, this.table, { sql: byId.sql, params: byId.params, table: this.table }, []);
        return this._materialize(await this.queryRaw(built.sql, ...built.params));
    }
    /**
     * Whether anything matches - without hydrating it. `excludeId` is what makes "is this value
     * taken by someone *else*" work on an update; it goes into the statement so the read stops at
     * the first match.
     */
    async exists(predicate, excludeId) {
        this._ensureOwnPredicate(predicate, "predicate");
        const built = RepositoryQueryBuilder.buildExists(this.table, predicate, excludeId);
        return !(await this.queryRaw(built.sql, ...built.params)).isEmpty;
    }
    /**
     * How many rows match - without hydrating them. For a count broken down by something, use
     * {@link queryRaw}.
     */
    async count(predicate) {
        this._ensureOwnPredicate(predicate, "predicate");
        const built = RepositoryQueryBuilder.buildCount(this.table, predicate);
        const result = await this.queryRaw(built.sql, ...built.params);
        return result.rows[0].count;
    }
    /**
     * Runs a raw SQL query and returns the unprocessed {@link QueryResult} - the analytical door.
     *
     * Name columns through {@link schema}'s `columnFor` rather than by hand. Note what pg hands back
     * with no type parsers installed: `bigint` and `numeric` arrive as strings (cast in the statement,
     * as `cast(count(*) as int)` does), and `timestamptz` as a `Date`.
     *
     * @template TRow - The expected shape of each returned row.
     */
    queryRaw(sql, ...params) {
        return executeRawQuery(this.db, sql, params);
    }
    /**
     * Runs a whole statement and hydrates each row into a read model - the escape hatch from
     * {@link query} for a join, a union, a CTE.
     *
     * The contract: every row must carry `id` and every declared column under its column name
     * ({@link selectList} is that list; `select *` satisfies it). A missing column throws, naming
     * it; an extra one is ignored.
     */
    async queryStatement(sql, ...params) {
        return this._materialize(await this.queryRaw(sql, ...params));
    }
    // async, like every writer here: a guard failure must surface as a rejection, never as a
    // synchronous throw from a method whose signature promises a Promise
    async _save(model, unitOfWork, owned) {
        given(model, "model").ensureHasValue().ensureIsObject().ensureIsType(this._schema.modelType);
        // checked before anything is queued, so a value of the wrong kind rejects the save whole
        const fatals = this._schema.verifyValues(model);
        if (fatals.length > 0)
            throw new ArgumentException("model", `cannot be stored in '${this.table}': ${fatals.map(t => t.message).join(" | ")}`);
        await this._write(unitOfWork, owned, async () => {
            await ReadModelShapeGuard.adviseOnce(this._schema, model, this.logger);
            await this.db.executeCommandWithinUnitOfWork(unitOfWork, this._mapper.upsertSql, ...this._mapper.toParams(model));
        });
    }
    async _saveAll(models, unitOfWork, owned) {
        given(models, "models").ensureHasValue().ensureIsArray();
        if (models.isEmpty)
            return;
        // every row checked before anything is queued, named by its position in the batch as handed
        // over and by its id, so a bad row anywhere rejects the batch whole without a bisection
        models.forEach((model, i) => {
            // read through a nullable view: a JavaScript caller can hand over anything, and the
            // position has to be named even when the slot is empty
            const id = model?.id;
            const label = `models[${i}]${typeof id === "string" ? ` (id '${id}')` : ""}`;
            given(model, label).ensureHasValue().ensureIsObject().ensureIsType(this._schema.modelType);
            const fatals = this._schema.verifyValues(model);
            if (fatals.length > 0)
                throw new ArgumentException("models", `${label} cannot be stored in '${this.table}': ${fatals.map(t => t.message).join(" | ")}`);
        });
        // Postgres refuses to upsert one row twice in a statement ("cannot affect row a second
        // time"), so a repeated id is refused here by name rather than there by position
        const seen = new Set();
        const repeated = new Set();
        for (const model of models)
            (seen.has(model.id) ? repeated : seen).add(model.id);
        given([...repeated], "models").ensure(t => t.isEmpty, `a batch cannot carry the same id twice: ${[...repeated].join(", ")}`);
        // sorted by id: a multi-row upsert locks each row as it reaches it in VALUES order, so two
        // concurrent batches over overlapping ids in different orders could deadlock - one order for
        // every batch removes that. Row order is not part of the contract
        const sorted = [...models].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        await this._write(unitOfWork, owned, async () => {
            await ReadModelShapeGuard.adviseOnce(this._schema, sorted[0], this.logger);
            const size = this._mapper.chunkSize;
            for (let start = 0; start < sorted.length; start += size) {
                const chunk = sorted.slice(start, start + size);
                const params = chunk.flatMap(t => this._mapper.toParams(t));
                await this.db.executeCommandWithinUnitOfWork(unitOfWork, this._mapper.upsertSqlFor(chunk.length), ...params);
            }
        });
    }
    async _delete(id, unitOfWork, owned) {
        given(id, "id").ensureHasValue().ensureIsString();
        id = id.trim();
        await this._write(unitOfWork, owned, () => this.db.executeCommandWithinUnitOfWork(unitOfWork, this._mapper.deleteSql, id));
    }
    /**
     * The envelope every write shares: run the statements, commit when this repository owns the
     * unit of work; on failure log, roll back when owned, and rethrow. A shared unit of work is left
     * to its owner either way.
     */
    async _write(unitOfWork, owned, work) {
        try {
            await work();
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
    _materialize(result) {
        if (result.isEmpty)
            return [];
        // built from the schema's keys only, never a row spread: a column the declaration does not
        // know would trip the class's constructor key check
        return result.rows.map(t => new this._schema.modelType(this._mapper.toData(t)));
    }
    /**
     * The runtime half of the table brand: a predicate built by another schema is refused here,
     * before it reaches a statement - a `timestamptz` conversion applied under the wrong schema would
     * be a silent wrong answer.
     */
    _ensureOwnPredicate(predicate, argName) {
        if (predicate == null)
            return;
        given(predicate, argName).ensureIsObject()
            .ensure(t => t.table === this.table, `the ${argName} was built by the schema for table '${predicate.table}'; this repository reads '${this.table}' - build it through this repository's own schema`);
    }
    _ensureOwnQuery(whereOrQuery) {
        given(whereOrQuery, "whereOrQuery").ensureHasValue().ensureIsObject();
        if (typeof whereOrQuery.sql === "string") {
            this._ensureOwnPredicate(whereOrQuery, "predicate");
            return;
        }
        const query = whereOrQuery;
        this._ensureOwnPredicate(query.where, "where");
        if (query.orderBy == null || typeof query.orderBy === "string")
            return;
        const terms = Array.isArray(query.orderBy) ? query.orderBy : [query.orderBy];
        for (const term of terms) {
            if (term.table === this.table)
                continue;
            throw new ArgumentException("orderBy", `the term was built by the schema for table '${term.table}'; this repository reads '${this.table}' - build it through this repository's own schema`);
        }
    }
}
//# sourceMappingURL=read-model-base-repository.js.map