import { given } from "@nivinjoseph/n-defensive";
/**
 * Runs a statement and hands back the rows untouched - the body behind every repository's raw-query
 * door.
 *
 * **A free function rather than a method on `BaseRepository`, and that is the whole point.** Each
 * concrete repository exposes this under a name that says what it does *there*: `queryRaw` on the
 * plain variants, where there is nothing to scope, and `queryRawAcrossOrganizations` on the
 * organization-scoped ones, where the statement gets no tenant filter and the name has to say so. A
 * name cannot be changed by overriding, so the two have to be declared per class.
 *
 * It lived on the base for one release, protected, so the four declarations could share a body. That
 * defeated the exercise: a protected member is inherited, so an org repository ended up with the
 * correctly-named door *and* a neutrally-named one beside it - two ways out of the tenant boundary
 * where the point had been to leave one. Out here it is reachable only by the classes that import it,
 * and each of those has already chosen its name.
 *
 * Deliberately absent from the barrel, for the same reason `RepositoryQueryBuilder` is: it is how the
 * doors are implemented, not a door itself.
 *
 * What this does **not** do is make the raw statement unreachable by other means - `this.db` is right
 * there, and has to be. The naming is guidance for whoever writes the subclass, about which door
 * reads as the obvious one; it was never a boundary the type system could enforce.
 *
 * @template TRow - The expected shape of each returned row.
 * @param {Db} db - The database to run against.
 * @param {string} sql - The statement to run.
 * @param {ReadonlyArray<any>} params - Values bound to the statement's `?` placeholders. An array rather than a rest parameter, since every caller already holds one from its own rest - so there is no spread and re-spread.
 * @returns {Promise<QueryResult<TRow>>} The raw query result.
 * @throws {ArgumentNullException} If db, sql or params is null or undefined.
 * @throws {ArgumentException} If sql is not a string, or params is not an array.
 */
export function executeRawQuery(db, sql, params) {
    given(db, "db").ensureHasValue().ensureIsObject();
    given(sql, "sql").ensureHasValue().ensureIsString();
    sql = sql.trim();
    given(params, "params").ensureHasValue().ensureIsArray();
    return db.executeQuery(sql, ...params);
}
//# sourceMappingURL=raw-query.js.map