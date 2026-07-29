import { given } from "@nivinjoseph/n-defensive";
import { DomainHelper } from "@nivinjoseph/n-domain";
/**
 * The Postgres types a value extracted out of a jsonb column can be cast to.
 *
 * Deliberately narrow, on two counts. Extraction yields text, and an expression index
 * requires an immutable expression - so only types whose input function is immutable are
 * reachable. And the set is limited to types a JSON value actually carries: JSON has
 * strings, numbers and booleans, so those are what this covers.
 *
 * Every member is verified against Postgres 12 to work as an index expression; there is a
 * test that fails if one is added that does not.
 *
 * Notable absences:
 * - No date/time types. `date`, `time`, `timestamp`, `timestamptz` and `interval` all parse
 *   from text through stable functions (they depend on DateStyle/TimeZone), so Postgres
 *   rejects them in an index expression. Store a timestamp as epoch millis and use
 *   {@link bigint} - which is what domain timestamps already are - or store an ISO-8601
 *   string and use {@link text}, which sorts chronologically anyway.
 * - No `varchar(n)`. An explicit cast to it truncates silently past n rather than erroring,
 *   and it buys nothing over {@link text} in Postgres.
 * - No `jsonb`. Indexing a whole subtree with btree is rarely useful; reach a scalar inside
 *   it with a dotted path instead.
 */
export var JsonValueType;
(function (JsonValueType) {
    // JSON strings
    JsonValueType["text"] = "text";
    JsonValueType["uuid"] = "uuid";
    // JSON booleans
    JsonValueType["boolean"] = "boolean";
    // JSON numbers
    JsonValueType["smallint"] = "smallint";
    JsonValueType["integer"] = "integer";
    JsonValueType["bigint"] = "bigint";
    JsonValueType["numeric"] = "numeric";
    JsonValueType["real"] = "real";
    JsonValueType["doublePrecision"] = "double precision";
})(JsonValueType || (JsonValueType = {}));
export class DataHelper {
    /**
     * A bare JSON key. Constraining segments to this is what keeps the '...' string literal
     * and the '{...}' path array in a json path expression from being broken out of.
     */
    static _jsonPathSegmentRegex = /^[A-Za-z_][A-Za-z0-9_]*$/;
    /**
     * @static
     */
    constructor() { }
    static createEventStreamTableName(aggregateType) {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        const tableName = DomainHelper.aggregateTypeToSnakeCase(aggregateType) + "_events";
        return tableName;
    }
    static createSnapshotTableName(aggregateType) {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        const tableName = DomainHelper.aggregateTypeToSnakeCase(aggregateType) + "_snaps";
        return tableName;
    }
    static createReadModelTableName(aggregateType, prefix) {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        given(prefix, "prefix").ensureIsString();
        prefix = prefix?.trim().toLowerCase();
        const tableName = DomainHelper.aggregateTypeToSnakeCase(aggregateType)
            + `${prefix ? "_" + prefix : ""}` + "_read_model";
        return tableName;
    }
    /**
     * Builds the SQL expression that extracts a key out of a table's `data` jsonb column.
     *
     * This is the single source of truth for such expressions: DbTableCreator builds its
     * expression indexes from it, and callers must build their where clauses from it too.
     * Postgres only uses an expression index when the query expression matches the indexed
     * one, so any textual divergence silently costs a sequential scan.
     *
     * A `type` produces a cast, which matters for correctness and not merely for speed:
     * `->>` yields text, so an uncast comparison orders lexicographically and '9' > '100'.
     * See {@link JsonValueType} for which types are available and why the set is narrow.
     *
     * @param {string} path - The key within `data`; dot delimited to reach a nested key.
     * @param {JsonValueType} [type] - Optional type to cast the extracted text to; defaults to leaving it as text.
     * @returns {string} A parenthesized expression, e.g. `(data->>'status')` or `((data->>'total')::numeric)`.
     * @throws {ArgumentNullException} If path is null or undefined.
     * @throws {ArgumentException} If path is not a string, or is empty or whitespace, or type is not a JsonValueType.
     * @throws {InvalidArgumentException} If any path segment is not a bare JSON key.
     */
    static createJsonPathExpression(path, type) {
        given(path, "path").ensureHasValue().ensureIsString()
            .ensure(t => t.trim().split(".").every(u => DataHelper._jsonPathSegmentRegex.test(u)), `path '${path}' must be one or more '.' delimited bare JSON keys`);
        given(type, "type").ensureIsString().ensureIsEnum(JsonValueType);
        const segments = path.trim().split(".");
        // ->> extracts a top level key as text; #>> walks a path array to reach a nested one
        const extraction = segments.length === 1
            ? `data->>'${segments[0]}'`
            : `data#>>'{${segments.join(",")}}'`;
        return type != null ? `((${extraction})::${type})` : `(${extraction})`;
    }
}
//# sourceMappingURL=data-helper.js.map