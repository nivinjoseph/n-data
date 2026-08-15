import { AggregateState } from "@nivinjoseph/n-domain";
import { Exception } from "@nivinjoseph/n-exception";
import { Logger } from "@nivinjoseph/n-log";
import assert from "node:assert";
import test, { describe } from "node:test";
import { DeclaredSnapshotQuerySet, JsonValueType, SnapshotQuerySet, SnapshotShapeIssue } from "../src/index.js";
import { SnapshotShapeGuard } from "../src/repository/snapshot-shape-guard.js";


// The state as TypeScript sees it. The DOCUMENTS below are what storage actually holds, and the two
// disagreeing is exactly what verifyDocument exists to catch - so unlike every other suite, most
// documents here are deliberately wrong.

interface Plan
{
    readonly tier: string;
    readonly seatLimit: number;
    serialize(): { tier: string; seatLimit: number; };
}

interface StudioState extends AggregateState
{
    name: string;
    plan: Plan;
    tags: Array<string>;
    note?: string;
}

const querySet = SnapshotQuerySet.for<StudioState>()
    .withPath("name")
    .withPath("plan.seatLimit", { type: JsonValueType.integer })
    .withPath("note")
    .withComposite(["plan.tier", "createdAt"])      // composite members are walked like any other
    .withArrayPath("tags");

/**
 * A document as `AggregateRoot.snapshot()` emits it: top-level state keys verbatim, the nested
 * Serializable through `serialize()` - every decorated key (null-valued ones included) plus a
 * `$typename` nobody wrote.
 */
function cleanDocument(): Record<string, any>
{
    return {
        id: "studio_1", version: 3, createdAt: 1, updatedAt: 2,
        isRebased: false, rebasedFromVersion: 0, typeVersion: 1,
        name: "n",
        plan: { tier: "free", seatLimit: 3, $typename: "Test.StudioPlan" },
        tags: ["a", "b"],
        note: null
    };
}

function kinds(issues: ReadonlyArray<SnapshotShapeIssue>): Array<string>
{
    return issues.map(t => `${t.kind}:${t.path}`).sort();
}


await describe("verifyDocument tests", async () =>
{
    await test("a document matching every declared path yields no issues", () =>
    {
        assert.deepStrictEqual(querySet.verifyDocument(cleanDocument()), []);
    });

    // null is what an optional stores, and extraction turns it into SQL NULL - never an issue
    await test("null intermediates and leaves are clean", () =>
    {
        const document = cleanDocument();
        document.plan = null;
        document.tags = null;

        assert.deepStrictEqual(querySet.verifyDocument(document), []);
    });

    // THE case this method exists for: serialize() emits every decorated key, so a declared segment
    // absent under a $typename parent is definitively a @serialize("customKey") rename
    await test("a key absent under a $typename parent is a fatal rename", () =>
    {
        const document = cleanDocument();
        document.plan = { tier: "free", $typename: "Test.StudioPlan" };  // seatLimit renamed away

        const issues = querySet.verifyDocument(document);

        assert.deepStrictEqual(kinds(issues), ["unresolvable-key:plan.seatLimit"]);
        assert.strictEqual(issues[0].severity, "fatal");
        assert.ok(issues[0].message.contains("rename"));
        assert.ok(issues[0].message.contains("tier"));                   // lists the stored keys
    });

    // absence under a PLAIN parent is ambiguous - it may be an omitted optional - so it warns
    await test("a key absent at the top level is an advisory", () =>
    {
        const document = cleanDocument();
        delete document.note;

        const issues = querySet.verifyDocument(document);

        assert.deepStrictEqual(kinds(issues), ["absent-key:note"]);
        assert.strictEqual(issues[0].severity, "advisory");
    });

    await test("an absent key under an empty plain parent hints at Map/Set", () =>
    {
        const document = cleanDocument();
        document.plan = {};                                              // what a Map serializes to

        const issues = querySet.verifyDocument(document);

        assert.deepStrictEqual(kinds(issues), ["absent-key:plan.seatLimit", "absent-key:plan.tier"]);
        assert.ok(issues.every(t => t.severity === "advisory"));
        assert.ok(issues[0].message.contains("Map or Set"));
    });

    // a value of the wrong KIND is never what an optional produces, so it is always fatal
    await test("a scalar or array intermediate is fatal", () =>
    {
        const withScalar = cleanDocument();
        withScalar.plan = "free";

        const scalarIssues = querySet.verifyDocument(withScalar);
        assert.deepStrictEqual(kinds(scalarIssues), ["non-object-intermediate:plan.seatLimit", "non-object-intermediate:plan.tier"]);
        assert.ok(scalarIssues.every(t => t.severity === "fatal"));

        const withArray = cleanDocument();
        withArray.plan = ["free"];

        const arrayIssues = querySet.verifyDocument(withArray);
        assert.deepStrictEqual(kinds(arrayIssues), ["non-object-intermediate:plan.seatLimit", "non-object-intermediate:plan.tier"]);
    });

    await test("an array path resolving to a non-array is fatal", () =>
    {
        const document = cleanDocument();
        document.tags = {};                                              // a Set serializes to {}

        const issues = querySet.verifyDocument(document);

        assert.deepStrictEqual(kinds(issues), ["non-array-leaf:tags"]);
        assert.strictEqual(issues[0].severity, "fatal");
        assert.ok(issues[0].message.contains("Map or Set"));
    });

    await test("an absent array path is an advisory, like any absent key", () =>
    {
        const document = cleanDocument();
        delete document.tags;

        assert.deepStrictEqual(kinds(querySet.verifyDocument(document)), ["absent-key:tags"]);
    });

    // a scalar path landing on an empty object is the Map/Set gap on the leaf itself
    await test("a scalar path resolving to an empty object is an advisory", () =>
    {
        const document = cleanDocument();
        document.note = {};

        const issues = querySet.verifyDocument(document);

        assert.deepStrictEqual(kinds(issues), ["empty-object-leaf:note"]);
        assert.strictEqual(issues[0].severity, "advisory");
    });

    // a NON-empty object leaf stays silent: indexing a whole subtree is a documented raw-door use
    await test("a scalar path resolving to a non-empty object is silent", () =>
    {
        const document = cleanDocument();
        document.note = { a: 1 };

        assert.deepStrictEqual(querySet.verifyDocument(document), []);
    });

    await test("several issues are reported together, one per declared path", () =>
    {
        const document = cleanDocument();
        document.plan = { tier: "free", $typename: "Test.StudioPlan" };
        document.tags = {};
        delete document.note;

        assert.deepStrictEqual(kinds(querySet.verifyDocument(document)),
            ["absent-key:note", "non-array-leaf:tags", "unresolvable-key:plan.seatLimit"]);
    });

    await test("a nullish or non-object document is rejected", () =>
    {
        assert.throws(() => querySet.verifyDocument(<any>null));
        assert.throws(() => querySet.verifyDocument(<any>undefined));
        assert.throws(() => querySet.verifyDocument(<any>"{}"));
    });
});


/**
 * Captures warnings, so "logged once" is assertable.
 */
class CapturingLogger implements Logger
{
    public readonly warnings = new Array<string>();

    public logDebug(_debug: string): Promise<void> { return Promise.resolve(); }
    public logInfo(_info: string): Promise<void> { return Promise.resolve(); }
    public logWarning(warning: string | Exception): Promise<void>
    {
        this.warnings.push(typeof warning === "string" ? warning : warning.message);
        return Promise.resolve();
    }
    public logError(_error: string | Exception): Promise<void> { return Promise.resolve(); }
}

// the save-time half: once per process per query set, fatal throws, advisory warns once. Sets are
// created fresh per test - the WeakSet keys on the set object, so a fresh set starts unverified.
await describe("SnapshotShapeGuard tests", async () =>
{
    function freshSet(): typeof querySet
    {
        return SnapshotQuerySet.for<StudioState>()
            .withPath("name")
            .withPath("plan.seatLimit", { type: JsonValueType.integer })
            .withPath("note")
            .withComposite(["plan.tier", "createdAt"])
            .withArrayPath("tags");
    }

    await test("a clean first save verifies once, then never re-walks", async () =>
    {
        let walks = 0;
        const set = freshSet();
        // a counting view over a real set: same declaration, observable walk count
        const counting: DeclaredSnapshotQuerySet<StudioState> = {
            indexes: set.indexes, arrayIndexes: set.arrayIndexes,
            paths: set.paths, arrayPaths: set.arrayPaths,
            _pathCheckingIntact: true,
            verifyDocument: (document: object) =>
            {
                walks++;
                return set.verifyDocument(document);
            }
        };
        const logger = new CapturingLogger();

        await SnapshotShapeGuard.verify("studio_snaps", counting, cleanDocument(), logger);
        await SnapshotShapeGuard.verify("studio_snaps", counting, cleanDocument(), logger);

        assert.strictEqual(walks, 1);
        assert.deepStrictEqual(logger.warnings, []);
    });

    await test("a fatal issue rejects the save, and rejects again on the next one", async () =>
    {
        const set = freshSet();
        const logger = new CapturingLogger();
        const renamed = cleanDocument();
        renamed.plan = { tier: "free", $typename: "Test.StudioPlan" };   // seatLimit renamed away

        // the flag is set only on a fatal-free pass, so both saves reject - never the second one through
        await assert.rejects(() => SnapshotShapeGuard.verify("studio_snaps", set, renamed, logger),
            (error: Error) => error.message.contains("plan.seatLimit"));
        await assert.rejects(() => SnapshotShapeGuard.verify("studio_snaps", set, renamed, logger));
    });

    await test("advisories warn once and let the save proceed", async () =>
    {
        const set = freshSet();
        const logger = new CapturingLogger();
        const document = cleanDocument();
        delete document.note;

        await SnapshotShapeGuard.verify("studio_snaps", set, document, logger);
        await SnapshotShapeGuard.verify("studio_snaps", set, document, logger);

        assert.strictEqual(logger.warnings.length, 1);
        assert.ok(logger.warnings[0].contains("note"));
        assert.ok(logger.warnings[0].contains("studio_snaps"));
    });

    await test("a fatal-free pass after a fatal one sets the flag", async () =>
    {
        const set = freshSet();
        const logger = new CapturingLogger();
        const broken = cleanDocument();
        broken.tags = {};

        await assert.rejects(() => SnapshotShapeGuard.verify("studio_snaps", set, broken, logger));

        // the shape is fixed (a fresh deploy, say) - the same set now passes and stays verified
        await SnapshotShapeGuard.verify("studio_snaps", set, cleanDocument(), logger);
        await SnapshotShapeGuard.verify("studio_snaps", set, broken, logger);   // flag set: no re-walk

        assert.deepStrictEqual(logger.warnings, []);
    });
});
