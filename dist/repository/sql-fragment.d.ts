/**
 * The rules every hand-written boolean fragment obeys, wherever it enters the library.
 *
 * Four places call this: `SnapshotQuerySet.raw`, `ReadModelSchema.raw`, the predicate a
 * `RepositoryQuery` carries (`RepositoryQueryBuilder._resolveWhere`), and
 * `RepositoryQueryBuilder.idPredicate`. The first and third
 * enforced different rules until this existed, and the gap was not merely untidy: `raw` parenthesizes
 * what it is given, and both regexes here are anchored, so a fragment that went through `raw` arrived
 * downstream as `"(select 1 from t)"` and passed guards that would have rejected
 * `"select 1 from t"`.
 *
 * So the rule is: validate here, and **before** the fragment is given any prefix. Three callers have
 * one to give - both `raw` doors wrap in parentheses, `idPredicate` splices behind `id in (?) and (` -
 * and all of them call this first for that reason.
 *
 * @param {string} sql - The fragment to check.
 * @param {string} name - The argument name to report failures against.
 * @returns {string} The trimmed fragment.
 * @throws {ArgumentNullException} If sql is null or undefined.
 * @throws {ArgumentException} If sql is not a string, is empty or whitespace, is a whole statement, keeps the `where` keyword, or contains a ';'.
 */
export declare function validateBooleanFragment(sql: string, name: string): string;
//# sourceMappingURL=sql-fragment.d.ts.map