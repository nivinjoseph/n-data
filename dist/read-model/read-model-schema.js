import { given } from "@nivinjoseph/n-defensive";
import { ArgumentException, ArgumentNullException } from "@nivinjoseph/n-exception";
import { createIndexName, identifierRegex, validateIdentifier, validateTableName } from "../migration/table-ddl.js";
import { DataHelper } from "../repository/data-helper.js";
import { validateBooleanFragment } from "../repository/sql-fragment.js";
import { bindingTermOf, ColumnType, elementTypeOf, isArrayColumnType, isColumnType, isReservedWord } from "./column-type.js";
import { decoratedFieldsOf, registeredTypeNameOf } from "./serializable-metadata.js";
/**
 * The declared columns and indexes of one read model table, and the typed predicates over them.
 *
 * This is the single declaration of a table's shape: `ReadModelTableCreator` creates the table and
 * its indexes from it, the repository writes and reads rows through it, and every predicate is
 * built by it. The declaration is an object literal keyed by every data key except `id` - a mapped
 * type, so a key left out and a key that is not a data key are both compile errors, and each
 * declared type is checked against its property's kind.
 *
 * **Every column is queryable; `index` and `unique` are performance declarations.** A real column
 * has no expression-matching hazard, and a sequential scan over an analytical table is a legitimate
 * plan - what the declaration guarantees is that an index declared here is one the migration
 * created.
 *
 * **Every column is nullable.** The DDL never emits `not null`, and there is no nullability
 * declaration: the TypeScript property type is the application's contract. A column added after
 * rows were written reads NULL for them until they are re-projected; a property typed non-null then
 * fails in the class's own constructor at hydration.
 *
 * `ReadModelSchema<T>` has one type parameter, and it is fully determined by the model - so a
 * repository holds its schema at the concrete type with no override to get wrong. A schema widened
 * to `ReadModelSchema<any>` is refused wherever one is consumed - the repository constructor and the
 * table creator take {@link IntactReadModelSchema} - rather than at the annotation itself, which
 * TypeScript's variance rule lets through; {@link _columnCheckingIntact} is what the consumers check.
 *
 * @example
 * ```typescript
 * @inject("DomainContext", "Db", "UnitOfWork", "Logger")
 * export class PgOrderSummaryRepository extends ReadModelBaseRepository<OrderSummary>
 * {
 *     public static readonly schema = ReadModelSchema.for(OrderSummary, {
 *         customerId: { type: ColumnType.text, index: true },
 *         total: { type: ColumnType.numeric },
 *         placedAt: { type: ColumnType.timestamptz, index: true },
 *         note: { type: ColumnType.text },
 *         tags: { type: ColumnType.textArray, index: true }       // GIN
 *     }).withIndex(["customerId", "placedAt"]);
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
 * }
 *
 * // in the migration - the same object
 * await tableCreator.createReadModelTable(PgOrderSummaryRepository.schema);
 * ```
 *
 * @class ReadModelSchema
 */
export class ReadModelSchema {
    /**
     * A camelCase property name: a lowercase letter, then letters and digits. The derived column is
     * then a clean identifier with no folding, and no two keys can derive the same column.
     */
    static _keyRegex = /^[a-z][A-Za-z0-9]*$/;
    _modelType;
    /**
     * The type name `@serialize` registered for the class - what a hydration stamps as `$typename`.
     */
    _typeName;
    _table;
    /**
     * In declaration order, which is the order the DDL emits the columns in.
     */
    _columns;
    _columnsByKey;
    /**
     * Per-column indexes first, in declaration order; composites appended by {@link withIndex}.
     */
    _indexes;
    /**
     * The read model class - what the repository hydrates rows into.
     */
    get modelType() { return this._modelType; }
    /**
     * The type name `@serialize` registered for the class (`"Prefix.ClassName"` or `"ClassName"`).
     * A hydration stamps it as `$typename`, exactly as the deserializer does, so the class's
     * constructor treats a row as the stored artifact it is.
     */
    get typeName() { return this._typeName; }
    /**
     * The table, derived from the class name: `OrderSummary` is `order_summary_read_model`.
     */
    get table() { return this._table; }
    /**
     * The declared columns, in declaration order.
     */
    get columns() { return [...this._columns]; }
    /**
     * The declared indexes: per-column ones in declaration order, then composites.
     */
    get indexes() { return [...this._indexes]; }
    /**
     * Use {@link for}.
     */
    constructor(modelType, typeName, table, columns, indexes) {
        this._modelType = modelType;
        this._typeName = typeName;
        this._table = table;
        this._columns = [...columns];
        this._columnsByKey = new Map(columns.map(t => [t.key, t]));
        this._indexes = [...indexes];
    }
    /**
     * Declares a read model's table: one column per data key.
     *
     * The class is an argument rather than a type parameter so that `T` is inferred from it, the
     * schema can hand the repository the class to hydrate with, and two constraints land as compile
     * errors here: the class must extend `ReadModel` (its brand), and its constructor must be public.
     *
     * @template T - The read model; inferred from the class.
     * @param {ReadModelClass<T>} modelType - The read model class.
     * @param {ReadModelColumns<T>} columns - One declaration per data key, checked against the property kinds.
     * @returns {ReadModelSchema<T>} The schema.
     * @throws {ArgumentException} If the class carries no class-level `@serialize`; if a key is not camelCase, derives `id`, a reserved word, an overlong or duplicate column; if a type is not a ColumnType; if `unique` is set on an array column; if `name` is malformed or set without an index; if two indexes derive one name; or if no column is declared.
     */
    static for(modelType, columns) {
        given(modelType, "modelType").ensureHasValue().ensureIsFunction()
            // serialize() and hydration both need the registered type name, and nothing else checks
            // for the class decorator before the first save
            .ensure(() => registeredTypeNameOf(modelType) != null, `class '${modelType.name}' must be decorated with @serialize`);
        const typeName = registeredTypeNameOf(modelType);
        // viewed as `object` for the ensurer: with T unresolved the mapped type gives it nothing to discriminate on
        given(columns, "columns").ensureHasValue().ensureIsObject();
        const table = validateTableName(DataHelper.createReadModelTableName(modelType));
        const infos = new Array();
        const indexes = new Array();
        const derived = new Set();
        // `Object.keys` preserves insertion order for string keys, so declaration order is DDL order
        for (const key of Object.keys(columns)) {
            const spec = columns[key];
            const argName = `columns.${key}`;
            given(key, "key").ensure(t => ReadModelSchema._keyRegex.test(t), `key '${key}' must be camelCase - a lowercase letter followed by letters and digits - so it derives a clean column name`);
            given(spec, argName).ensureHasValue().ensureIsObject();
            // the casts pick the ensurer; each guard then checks the real kind, since a JavaScript
            // caller can pass anything here
            const descriptor = spec;
            given(descriptor.type, `${argName}.type`).ensureHasValue().ensureIsString()
                .ensure(t => isColumnType(t), `'${String(descriptor.type)}' is not a ColumnType`);
            const columnType = descriptor.type;
            const isArray = isArrayColumnType(columnType);
            given(descriptor.index, `${argName}.index`).ensureIsBoolean();
            given(descriptor.unique, `${argName}.unique`).ensureIsBoolean()
                .ensure(t => !t || !isArray, `column '${key}' is an array; it is indexed with GIN, which cannot enforce uniqueness - remove 'unique'`);
            given(descriptor.name, `${argName}.name`).ensureIsString()
                .ensure(t => identifierRegex.test(t), `'name' must contain only lowercase letters, digits and underscores, and cannot start with a digit`)
                .ensure(() => descriptor.index === true || descriptor.unique === true, `'name' names an index, so column '${key}' needs 'index' or 'unique' as well`);
            const column = ReadModelSchema._toColumnName(key);
            given(column, argName)
                .ensure(t => t !== "id", `key '${key}' derives the column 'id', which is the primary key and is never declared`)
                .ensure(t => !isReservedWord(t), `key '${key}' derives the column '${column}', a Postgres reserved word that cannot be a bare column name - rename the property`)
                .ensure(t => !derived.has(t), `key '${key}' derives the column '${column}', which another key already derives`);
            validateIdentifier(column, argName);
            derived.add(column);
            const index = descriptor.index === true || descriptor.unique === true;
            const unique = descriptor.unique === true;
            infos.push({ key, column, type: columnType, index, unique });
            if (index) {
                // the markers are load-bearing, as on the snapshot side: `_uq` lets a lookup index and a
                // unique one coexist, and `_gin` keeps a GIN name from colliding with a btree one
                const suffix = `${(descriptor.name ?? column)}${unique ? "_uq" : ""}${isArray ? "_gin" : ""}`;
                indexes.push({ name: createIndexName(table, suffix), keys: [key], columns: [column], method: isArray ? "gin" : "btree", isUnique: unique });
            }
        }
        // an id-only table has no legal upsert (`do update set id = excluded.id`), and `do nothing`
        // trips the no-rows-affected check - so the shape is refused here, where it is declared
        given(infos, "columns").ensure(t => t.length > 0, "a read model needs at least one column besides id");
        given(indexes, "columns").ensure(t => t.distinct(u => u.name).length === t.length, "two columns derive the same index name - give one of them a different 'name'");
        return new ReadModelSchema(modelType, typeName, table, infos, indexes);
    }
    static _combine(operator, table, predicates) {
        given(predicates, "predicates").ensureHasValue().ensureIsArray().ensureIsNotEmpty()
            // read through `any` so a JavaScript caller passing something predicate-shaped is caught
            // here rather than emitting `undefined` into the SQL
            .ensure(t => t.every(u => typeof u?.sql === "string"), "every predicate must have sql")
            .ensure(t => t.every(u => u.table === table), `every predicate must be built by this schema (table '${table}'); got one for '${predicates.find(u => u.table !== table)?.table}'`);
        const params = new Array();
        for (const predicate of predicates)
            params.push(...predicate.params);
        // the parens are what make nesting safe: `a and (b or c)` only means that if the inner
        // fragment carries its own
        return { sql: `(${predicates.map(t => t.sql).join(` ${operator} `)})`, params, table };
    }
    /**
     * `placedAt` -> `placed_at`: each uppercase letter becomes an underscore and its lowercase. The
     * same naive rule `DomainHelper.aggregateTypeToSnakeCase` applies to table names.
     */
    static _toColumnName(key) {
        return key.replace(/[A-Z]/g, t => `_${t.toLowerCase()}`);
    }
    /**
     * Why `value` cannot be stored in a column of `type`, or null when it can. `null`/`undefined`
     * always can - every column is nullable.
     */
    static _kindError(type, value) {
        if (value == null)
            return null;
        if (isArrayColumnType(type)) {
            if (!Array.isArray(value))
                return `expects an array, got ${ReadModelSchema._describe(value)}`;
            const element = elementTypeOf(type);
            for (const item of value) {
                if (item == null)
                    return "expects an array without null elements";
                const error = ReadModelSchema._kindError(element, item);
                if (error != null)
                    return `expects every element to fit ${element}: one ${error}`;
            }
            return null;
        }
        switch (type) {
            case ColumnType.text:
                return typeof value === "string" ? null : `expects a string, got ${ReadModelSchema._describe(value)}`;
            case ColumnType.boolean:
                return typeof value === "boolean" ? null : `expects a boolean, got ${ReadModelSchema._describe(value)}`;
            case ColumnType.smallint:
                return ReadModelSchema._integerError(value, 32767);
            case ColumnType.integer:
                return ReadModelSchema._integerError(value, 2147483647);
            case ColumnType.bigint:
                return Number.isSafeInteger(value) ? null : `expects a safe integer, got ${ReadModelSchema._describe(value)}`;
            case ColumnType.numeric:
            case ColumnType.real:
            case ColumnType.doublePrecision:
            case ColumnType.timestamptz:
                return typeof value === "number" && Number.isFinite(value) ? null : `expects a finite number, got ${ReadModelSchema._describe(value)}`;
            default:
                return `has an unknown column type '${type}'`;
        }
    }
    /**
     * An integer within the column's Postgres range - checked here so an out-of-range value is refused
     * before the row is queued, rather than failing at the database after the unit of work is rolled back.
     */
    static _integerError(value, limit) {
        if (!Number.isSafeInteger(value))
            return `expects an integer, got ${ReadModelSchema._describe(value)}`;
        const integer = value;
        return integer >= -limit - 1 && integer <= limit ? null : `expects an integer between ${-limit - 1} and ${limit}, got ${integer}`;
    }
    static _describe(value) {
        if (value === null)
            return "null";
        // JSON.stringify throws on a BigInt primitive, and this must describe anything a JavaScript caller passes
        if (typeof value === "bigint")
            return `bigint ${String(value)}n`;
        if (Array.isArray(value))
            return "an array";
        if (typeof value === "object")
            return "an object";
        return `${typeof value} ${JSON.stringify(value)}`;
    }
    /**
     * Declares one composite btree index over several scalar columns.
     *
     * Order matters: btree serves only a leading prefix of an index's columns, so the second key of
     * a composite is not independently searchable. A single key is declared with `index: true` on
     * the column, not here.
     *
     * @param {ReadonlyArray<ReadModelScalarKey<T>>} keys - Two or more distinct scalar keys, in index order.
     * @param {object} [options] - `unique` to enforce the tuple as a natural key; `name` to override the derived index name suffix.
     * @returns {ReadModelSchema<T>} A schema that also carries this index - the receiver is left unchanged.
     * @throws {ArgumentException} If fewer than two keys are given, a key is repeated, undeclared or an array column, the name is malformed, or the derived name is already declared.
     */
    withIndex(keys, options) {
        given(keys, "keys").ensureHasValue().ensureIsArray()
            .ensure(t => t.length >= 2, "a composite index needs at least two keys; declare a single key with 'index: true' on the column")
            .ensure(t => t.distinct().length === t.length, "keys must be distinct");
        given(options, "options").ensureIsObject();
        given(options?.unique, "options.unique").ensureIsBoolean();
        given(options?.name, "options.name").ensureIsString()
            .ensure(t => identifierRegex.test(t), "'name' must contain only lowercase letters, digits and underscores, and cannot start with a digit");
        const infos = keys.map(t => this._columnInfo(t));
        for (const info of infos)
            given(info, "keys").ensure(t => !isArrayColumnType(t.type), `key '${info.key}' is an array column, which a btree composite cannot include`);
        const unique = options?.unique === true;
        const name = createIndexName(this._table, `${options?.name ?? infos.map(t => t.column).join("_")}${unique ? "_uq" : ""}`);
        given(name, "name").ensure(t => !this._indexes.some(u => u.name === t), `index '${name}' is already declared by this schema`);
        const next = this._clone();
        next._indexes.push({ name, keys: [...keys], columns: infos.map(t => t.column), method: "btree", isUnique: unique });
        return next;
    }
    /**
     * The column identifier behind a key, for composing a statement by hand through {@link raw} or
     * a repository's raw door.
     *
     * @param {ReadModelKey<T>} key - A declared key.
     * @returns {string} The bare column identifier, e.g. `placed_at`.
     */
    columnFor(key) {
        return this._columnInfo(key).column;
    }
    /**
     * Matches rows where `key` equals `value`.
     */
    eq(key, value) {
        return this._comparison(key, "=", value);
    }
    /**
     * Matches rows where `key` does not equal `value`. A NULL column compares as neither, so those
     * rows do not come back here - pair with {@link isNull} if they should.
     */
    ne(key, value) {
        return this._comparison(key, "<>", value);
    }
    /**
     * Matches rows where `key` is greater than `value`.
     */
    gt(key, value) {
        return this._comparison(key, ">", value);
    }
    /**
     * Matches rows where `key` is greater than or equal to `value`.
     */
    gte(key, value) {
        return this._comparison(key, ">=", value);
    }
    /**
     * Matches rows where `key` is less than `value`.
     */
    lt(key, value) {
        return this._comparison(key, "<", value);
    }
    /**
     * Matches rows where `key` is less than or equal to `value`.
     */
    lte(key, value) {
        return this._comparison(key, "<=", value);
    }
    /**
     * Matches rows where `key` is any of `values`.
     *
     * @throws {ArgumentException} If values is empty - `in ()` is not valid SQL, and an empty list is a caller bug rather than a way to match nothing.
     */
    in(key, values) {
        given(values, "values").ensureHasValue().ensureIsArray().ensureIsNotEmpty();
        const column = this._columnInfo(key);
        for (const value of values)
            this._ensureKind(column, value, "values");
        return {
            sql: `(${column.column} in (${values.map(() => this._valueTerm(column)).join(",")}))`,
            params: [...values],
            table: this._table
        };
    }
    /**
     * Matches rows whose column at `key` is NULL - which any column can be: a column added after
     * rows were written reads NULL for them until they are re-projected.
     */
    isNull(key) {
        return { sql: `(${this._columnInfo(key).column} is null)`, params: [], table: this._table };
    }
    /**
     * Matches rows that carry a value at `key`.
     */
    isNotNull(key) {
        return { sql: `(${this._columnInfo(key).column} is not null)`, params: [], table: this._table };
    }
    /**
     * Matches rows where the text column at `key` matches `pattern` under `like`. A btree does not
     * serve a prefix pattern under a non-C collation; a hand-built `text_pattern_ops` index does.
     */
    like(key, pattern) {
        return this._comparison(key, "like", pattern);
    }
    /**
     * The case-insensitive counterpart of {@link like}.
     */
    ilike(key, pattern) {
        return this._comparison(key, "ilike", pattern);
    }
    /**
     * Matches rows whose array at `key` contains `element` - `@>`, which the GIN index serves.
     */
    contains(key, element) {
        return this._containment(key, "@>", [element]);
    }
    /**
     * Matches rows whose array at `key` contains **every** one of `elements`.
     *
     * @throws {ArgumentException} If elements is empty - `@> '{}'` is true for every row.
     */
    containsAll(key, elements) {
        return this._containment(key, "@>", elements);
    }
    /**
     * Matches rows whose array at `key` contains **any** of `elements` - `&&`, overlap, which the
     * GIN index serves. `= any(column)` is deliberately not offered: it is index-blind.
     *
     * @throws {ArgumentException} If elements is empty - `&& '{}'` is false for every row.
     */
    containsAny(key, elements) {
        return this._containment(key, "&&", elements);
    }
    /**
     * Every predicate must hold.
     *
     * @throws {ArgumentException} If no predicate is given, or one was built by another schema.
     */
    and(...predicates) {
        return ReadModelSchema._combine("and", this._table, predicates);
    }
    /**
     * At least one predicate must hold.
     *
     * @throws {ArgumentException} If no predicate is given, or one was built by another schema.
     */
    or(...predicates) {
        return ReadModelSchema._combine("or", this._table, predicates);
    }
    /**
     * Negates a predicate. `not NULL` is NULL, so negation does not bring NULL rows back; nor does
     * a negated predicate use an index.
     *
     * @throws {ArgumentException} If the predicate was built by another schema.
     */
    not(predicate) {
        given(predicate, "predicate").ensureHasValue().ensureIsObject()
            .ensure(t => t.table === this._table, `the predicate must be built by this schema (table '${this._table}'); got one for '${predicate.table}'`);
        return { sql: `(not ${predicate.sql})`, params: [...predicate.params], table: this._table };
    }
    /**
     * Wraps a hand-written fragment so it composes with the typed predicates.
     *
     * For what the operators above cannot say - a function of two columns, a range on an
     * expression. Name columns through {@link columnFor} rather than by hand.
     *
     * @param {string} sql - A boolean fragment. Parenthesized for you; bind values with `?`.
     * @param {...ReadonlyArray<any>} params - Values bound to the fragment's placeholders.
     * @throws {ArgumentException} If sql is empty, is a whole statement, keeps the `where` keyword, or contains a ';'.
     */
    raw(sql, ...params) {
        // validated before the parentheses go on: both regexes in the shared function are anchored
        const validated = validateBooleanFragment(sql, "sql");
        given(params, "params").ensureHasValue().ensureIsArray();
        return { sql: `(${validated})`, params: [...params], table: this._table };
    }
    /**
     * One `order by` term over a scalar column. A GIN array index cannot serve ordering, so an
     * array key is not offered.
     *
     * @param {K} key - A declared scalar key.
     * @param {"asc" | "desc"} [direction] - Defaults to `asc`, as Postgres does.
     */
    orderBy(key, direction) {
        given(direction, "direction").ensureIsString()
            .ensure(t => t === "asc" || t === "desc", "direction must be 'asc' or 'desc'");
        const column = this._columnInfo(key);
        given(column, "key").ensure(t => !isArrayColumnType(t.type), `key '${key}' is an array column, which cannot order`);
        return { sql: `${column.column}${direction != null ? ` ${direction}` : ""}`, table: this._table };
    }
    /**
     * Checks one model instance against this declaration: {@link verifyValues} and {@link verifyShape}
     * together. Pure: no logging, no throwing, no state.
     *
     * Call it in a test - `assert.deepStrictEqual(MyRepository.schema.verifyModel(model), [])` - to
     * catch the advisories as well as the fatal issues the repositories throw on.
     *
     * @param {T} model - An instance of the schema's model.
     * @returns {ReadonlyArray<ReadModelShapeIssue>} Every issue found; empty when the instance fits.
     * @throws {ArgumentException} If model is not an instance of the schema's class.
     */
    verifyModel(model) {
        return [...this.verifyValues(model), ...this.verifyShape(model)];
    }
    /**
     * The per-instance half of {@link verifyModel}: every column's value against its declared type
     * and range. A failure here is fatal - the row cannot be written faithfully, and pg would
     * otherwise coerce a number bound to a text column into `'42'` silently - so the repositories
     * run this on every save and throw.
     *
     * @throws {ArgumentException} If model is not an instance of the schema's class.
     */
    verifyValues(model) {
        given(model, "model").ensureHasValue().ensureIsObject().ensureIsType(this._modelType);
        const issues = new Array();
        const record = model;
        for (const column of this._columns) {
            const error = ReadModelSchema._kindError(column.type, record[column.key]);
            if (error != null)
                issues.push({
                    key: column.key, kind: "wrong-kind", severity: "fatal",
                    message: `column '${column.column}' (key '${column.key}', ${column.type}) ${error}`
                });
        }
        return issues;
    }
    /**
     * The per-class half of {@link verifyModel}: the declaration against the getters `@serialize`
     * recorded for the class, read from the class's metadata rather than by serializing the instance.
     * Every finding is an advisory - storage reads properties directly and a hydration is a
     * deserialization, so none of them moves a column - and the repositories log them once per
     * schema.
     *
     * @throws {ArgumentException} If model is not an instance of the schema's class.
     */
    verifyShape(model) {
        given(model, "model").ensureHasValue().ensureIsObject().ensureIsType(this._modelType);
        const issues = new Array();
        const fields = decoratedFieldsOf(this._modelType);
        const names = new Set(fields.map(t => t.name));
        const serializedKeys = new Set(fields.map(t => t.key ?? t.name));
        const declared = new Set(this._columns.map(t => t.key));
        for (const field of fields) {
            if (field.name === "id" || declared.has(field.name))
                continue;
            issues.push({
                key: field.name, kind: "undeclared-getter", severity: "advisory",
                message: `decorated getter '${field.name}' is not a column: its value is not stored and is absent on hydration - list it in TDataKeys and declare a column, or leave it undecorated and derive it`
            });
        }
        for (const column of this._columns) {
            if (!names.has(column.key) && !serializedKeys.has(column.key)) {
                issues.push({
                    key: column.key, kind: "undecorated-getter", severity: "advisory",
                    message: `declared key '${column.key}' has no @serialize on its getter: it is stored and hydrated, but absent from serialize() and equals(), and a fresh construction carrying it is refused by the class - decorate the getter`
                });
                continue;
            }
            if (!serializedKeys.has(column.key))
                issues.push({
                    key: column.key, kind: "renamed-getter", severity: "advisory",
                    message: `declared key '${column.key}' serializes under a @serialize("customKey") rename; storage reads the property directly so the column is unaffected, but serialize() and equals() name it differently`
                });
        }
        return issues;
    }
    /**
     * Copy-on-write, so {@link withIndex} hands back a new schema and the receiver stays usable.
     */
    _clone() {
        return new ReadModelSchema(this._modelType, this._typeName, this._table, this._columns, this._indexes);
    }
    _columnInfo(key) {
        given(key, "key").ensureHasValue().ensureIsString()
            .ensure(t => this._columnsByKey.has(t), `key '${key}' is not a column of this schema, which has: ${[...this._columnsByKey.keys()].join(", ")}`);
        return this._columnsByKey.get(key);
    }
    /**
     * The placeholder a value for `column` binds through - the same one the row mapper writes with.
     */
    _valueTerm(column) {
        return bindingTermOf(column.type);
    }
    /**
     * Thrown directly rather than through an ensurer: the value's static type is `unknown` here, and
     * the kind check IS the guard.
     */
    _ensureKind(column, value, argName) {
        if (value == null)
            throw new ArgumentNullException(argName);
        const error = ReadModelSchema._kindError(column.type, value);
        if (error != null)
            throw new ArgumentException(argName, `column '${column.column}' (key '${column.key}', ${column.type}) ${error}`);
    }
    _comparison(key, operator, value) {
        const column = this._columnInfo(key);
        given(column, "key").ensure(t => !isArrayColumnType(t.type), `key '${key}' is an array column; use contains, containsAll or containsAny`);
        this._ensureKind(column, value, "value");
        return { sql: `(${column.column} ${operator} ${this._valueTerm(column)})`, params: [value], table: this._table };
    }
    _containment(key, operator, elements) {
        const column = this._columnInfo(key);
        given(column, "key").ensure(t => isArrayColumnType(t.type), `key '${key}' is not an array column; use eq, in or the comparisons`);
        given(elements, "elements").ensureHasValue().ensureIsArray().ensureIsNotEmpty();
        this._ensureKind(column, elements, "elements");
        // one array binding: pg serializes a JS array as a Postgres array literal, and the cast
        // tells the parser the element type - the same `cast(? as ...)` form the snapshot
        // containment uses for jsonb
        return { sql: `(${column.column} ${operator} cast(? as ${column.type}))`, params: [[...elements]], table: this._table };
    }
}
//# sourceMappingURL=read-model-schema.js.map