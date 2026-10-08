import { given } from "@nivinjoseph/n-defensive";

/**
 * A predicate that is really a whole statement. `with` is included because a caller reaching for a CTE
 * is reaching past what the repositories build, same as one writing `select`.
 */
const statementRegex = /^\s*(?:select|with)\b/i;

/**
 * A predicate that has kept the keyword the builder emits.
 */
const whereKeywordRegex = /^\s*where\b/i;

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
export function validateBooleanFragment(sql: string, name: string): string
{
    given(name, "name").ensureHasValue().ensureIsString();

    given(sql, name).ensureHasValue().ensureIsString()
        .ensure(
            t => t.isNotEmptyOrWhiteSpace(),
            `${name} is empty`
        )
        .ensure(
            t => !statementRegex.test(t),
            `${name} is a predicate, not a whole statement - drop the 'select ... from ...' and pass only what follows 'where'`
        )
        .ensure(
            t => !whereKeywordRegex.test(t),
            `${name} must not include the 'where' keyword, which is emitted for you`
        )
        .ensure(
            t => !t.contains(";"),
            `${name} must not contain a ';'`
        );

    return sql.trim();
}
