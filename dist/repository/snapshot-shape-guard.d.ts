import { Logger } from "@nivinjoseph/n-log";
import { DeclaredSnapshotQuerySet } from "../migration/snapshot-query-set.js";
/**
 * The save-time half of `SnapshotQuerySet.verifyDocument`: runs the walk once per process per query
 * set, against the first document a repository saves, and acts on the severity split - a fatal
 * issue throws, advisories log one combined warning.
 *
 * Throwing on a fatal is the correct outcome, not an inconvenience: every fatal is a true positive
 * (see `SnapshotShapeIssue`), and the row being saved would be invisible to every declared query
 * and unconstrained by every unique index - so it surfaces on the first integration-test save
 * rather than as a production query that silently returns nothing.
 *
 * Once per process is enough because the verification is shape-level, not data-level: the query set
 * object IS the shape declaration (normally a static shared by every instance of a repository), so
 * the `WeakSet` costs a single `has` per save in the steady state - and gives natural test
 * isolation, since a fresh set starts unverified. The flag is set only on a fatal-free pass, so a
 * fatal shape bug re-throws on every save instead of letting the second one through; the same
 * once-flag is what makes advisories log once rather than on every save.
 *
 * Internal on purpose - not in the barrel. The consumer-facing door is `verifyDocument` itself,
 * called in a test against `aggregate.snapshot()`, which also covers the one case this guard can
 * meet late: a rename inside an optional object that is null in every document a process saves.
 */
export declare class SnapshotShapeGuard {
    private static readonly _verified;
    /**
     * Static class.
     */
    private constructor();
    /**
     * Verifies `document` against `querySet`'s declared paths, once per query set per process.
     *
     * @param {string} table - The snapshot table, named in the warning and the exception.
     * @param {DeclaredSnapshotQuerySet<any>} querySet - The repository's declaration.
     * @param {object} document - The snapshot document about to be written.
     * @param {Logger} logger - Where advisories go, once.
     * @throws {ApplicationException} If any declared path has a fatal shape issue against this document.
     */
    static verify(table: string, querySet: DeclaredSnapshotQuerySet<any>, document: object, logger: Logger): Promise<void>;
}
//# sourceMappingURL=snapshot-shape-guard.d.ts.map