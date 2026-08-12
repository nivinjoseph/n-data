/**
 * The rules every hand-written boolean fragment obeys, wherever it enters the library.
 *
 * There are two doors a raw fragment can come through - `SnapshotQuerySet.raw`, and the predicate a
 * `RepositoryQuery` carries - and they enforced different rules until this existed. The gap was not
 * merely untidy: `raw` parenthesizes what it is given, and both regexes here are anchored, so a
 * fragment that went through `raw` arrived downstream as `"(select 1 from t)"` and passed guards that
 * would have rejected `"select 1 from t"`. Validating here, and in `raw`'s case **before** the
 * parentheses go on, is what closes it.
 *
 * @param {string} sql - The fragment to check.
 * @param {string} name - The argument name to report failures against.
 * @returns {string} The trimmed fragment.
 * @throws {ArgumentNullException} If sql is null or undefined.
 * @throws {ArgumentException} If sql is not a string, is empty or whitespace, is a whole statement, keeps the `where` keyword, or contains a ';'.
 */
export declare function validateBooleanFragment(sql: string, name: string): string;
//# sourceMappingURL=sql-fragment.d.ts.map