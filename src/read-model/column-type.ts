import { given } from "@nivinjoseph/n-defensive";

/**
 * The Postgres column types a read model property can be stored as.
 *
 * The values are the DDL spellings, exactly as `JsonValueType` spells its casts, so a column
 * definition is `<column> <type>` with nothing in between - and so drift verification can compare
 * the catalog's `format_type` against them directly, with one documented exception
 * ({@link catalogTypeOf}).
 *
 * Which members fit which property type is decided at compile time by the schema declaration: a
 * `string` takes {@link text}; a `number` takes any numeric kind or {@link timestamptz}; a `boolean`
 * takes {@link boolean}; an array of one of those takes the matching array kind. There is
 * deliberately no `varchar` (a length that buys nothing over `text`), no `uuid` (an n-domain id is a
 * prefixed ULID, not a UUID), and no `timestamptz[]`.
 *
 * {@link timestamptz} is the one kind whose stored form differs from the property: the property is
 * epoch milliseconds, written as `to_timestamp(? / 1000.0)` and read back through `Date.valueOf()`,
 * so a row carries a real timestamp that `date_trunc`, ranges and time-bucket analytics can use.
 */
export enum ColumnType
{
    text = "text",
    boolean = "boolean",
    smallint = "smallint",
    integer = "integer",
    bigint = "bigint",
    numeric = "numeric",
    real = "real",
    doublePrecision = "double precision",
    timestamptz = "timestamptz",
    textArray = "text[]",
    booleanArray = "boolean[]",
    integerArray = "integer[]",
    bigintArray = "bigint[]",
    numericArray = "numeric[]",
    doublePrecisionArray = "double precision[]"
}

/**
 * The {@link ColumnType} members a `number` property may be stored as, {@link ColumnType.timestamptz}
 * aside.
 */
export type ReadModelNumericType =
    | ColumnType.smallint | ColumnType.integer | ColumnType.bigint
    | ColumnType.numeric | ColumnType.real | ColumnType.doublePrecision;

const columnTypeValues: ReadonlySet<string> = new Set(Object.values(ColumnType));

/**
 * Postgres keywords that cannot be a bare column name: the fully reserved ones, and the ones that
 * are reserved except as a function or type name (`left`, `is`, `like`, ...). Every identifier this
 * library emits is unquoted, so a property deriving one of these is rejected at declaration with
 * "rename the property" rather than quoted into every statement.
 *
 * Non-reserved keywords (`name`, `type`, `role`, `status`, `value`, `key`, `data`) are legitimate
 * column names and are not listed.
 */
const reservedWords: ReadonlySet<string> = new Set([
    "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "authorization",
    "binary", "both", "case", "cast", "check", "collate", "collation", "column", "concurrently",
    "constraint", "create", "cross", "current_catalog", "current_date", "current_role",
    "current_schema", "current_time", "current_timestamp", "current_user", "default", "deferrable",
    "desc", "distinct", "do", "else", "end", "except", "false", "fetch", "for", "foreign", "freeze",
    "from", "full", "grant", "group", "having", "ilike", "in", "initially", "inner", "intersect",
    "into", "is", "isnull", "join", "lateral", "leading", "left", "like", "limit", "localtime",
    "localtimestamp", "natural", "not", "notnull", "null", "offset", "on", "only", "or", "order",
    "outer", "overlaps", "placing", "primary", "references", "returning", "right", "select",
    "session_user", "similar", "some", "symmetric", "table", "tablesample", "then", "to", "trailing",
    "true", "union", "unique", "user", "using", "variadic", "verbose", "when", "where", "window",
    "with"
]);

/**
 * Whether a value is a {@link ColumnType} member - the guard for a JavaScript caller, or an `any`,
 * handing the schema a stray string.
 */
export function isColumnType(value: unknown): value is ColumnType
{
    return typeof value === "string" && columnTypeValues.has(value);
}

/**
 * Whether the type is one of the array kinds, which take a GIN index and the containment predicates.
 */
export function isArrayColumnType(type: ColumnType): boolean
{
    given(type, "type").ensureHasValue().ensure(t => isColumnType(t), "type must be a ColumnType");

    return type.endsWith("[]");
}

/**
 * The element kind of an array column type.
 *
 * @throws {ArgumentException} If the type is not an array kind.
 */
export function elementTypeOf(type: ColumnType): ColumnType
{
    given(type, "type").ensureHasValue()
        .ensure(t => isColumnType(t), "type must be a ColumnType")
        .ensure(t => t.endsWith("[]"), `type '${type}' is not an array column type`);

    const element = type.slice(0, -2);

    given(element, "type").ensure(t => isColumnType(t), `type '${type}' has no element column type`);

    return <ColumnType>element;
}

/**
 * The spelling `format_type` prints for a column of this type - what drift verification compares
 * the catalog against. Identical to the DDL spelling for every kind but {@link ColumnType.timestamptz},
 * which Postgres prints in full.
 */
export function catalogTypeOf(type: ColumnType): string
{
    given(type, "type").ensureHasValue().ensure(t => isColumnType(t), "type must be a ColumnType");

    return type === ColumnType.timestamptz ? "timestamp with time zone" : type;
}

/**
 * Whether an identifier is a Postgres keyword that cannot be a bare column name.
 */
export function isReservedWord(identifier: string): boolean
{
    given(identifier, "identifier").ensureHasValue().ensureIsString();

    return reservedWords.has(identifier.trim().toLowerCase());
}

/**
 * The placeholder a value for a column of this type binds through. A `timestamptz` column converts
 * the epoch milliseconds on the parameter side, so the column itself stays bare and its btree
 * usable; everything else binds as it is.
 */
export function bindingTermOf(type: ColumnType): string
{
    given(type, "type").ensureHasValue().ensure(t => isColumnType(t), "type must be a ColumnType");

    return type === ColumnType.timestamptz ? "to_timestamp(? / 1000.0)" : "?";
}
