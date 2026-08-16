import { AggregateState, DomainObject, DomainObjectData } from "@nivinjoseph/n-domain";
import { Exception } from "@nivinjoseph/n-exception";
import { Logger } from "@nivinjoseph/n-log";
import { serialize } from "@nivinjoseph/n-util";
import assert from "node:assert";
import test, { describe } from "node:test";
import { DeclaredSnapshotQuerySet, JsonValueType, SnapshotDocumentOf, SnapshotQuerySet, SnapshotShapeIssue } from "../src/index.js";
import { SnapshotShapeGuard } from "../src/repository/snapshot-shape-guard.js";


// The state as TypeScript sees it. The DOCUMENTS below are what storage actually holds, and the two
// disagreeing is exactly what verifyDocument exists to catch - so unlike every other suite, most
// documents here are deliberately wrong.

@serialize
class Plan extends DomainObject<Plan, "tier" | "seatLimit" | "badges">
{
    private readonly _tier: string;
    private readonly _seatLimit: number;
    private readonly _badges: Array<string>;

    @serialize public get tier(): string { return this._tier; }
    @serialize public get seatLimit(): number { return this._seatLimit; }
    // an array data key, writable only as of n-domain 4.0.3 - so `plan.badges` is the first array
    // path this suite can verify that lives INSIDE a serialized record rather than beside one
    @serialize public get badges(): Array<string> { return this._badges; }

    public constructor(data: DomainObjectData<Plan>)
    {
        super(data);
        this._tier = data.tier;
        this._seatLimit = data.seatLimit;
        this._badges = data.badges;
    }
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
 * `$typename` nobody wrote. `SnapshotDocumentOf` is the assertion: the literal is checked against
 * the real stored shape, nested DomainObject as its serialized record and the null-valued optional
 * included.
 */
function cleanDocument(): SnapshotDocumentOf<StudioState>
{
    return {
        id: "studio_1", version: 3, createdAt: 1, updatedAt: 2,
        isRebased: false, rebasedFromVersion: 0, typeVersion: 1,
        name: "n",
        plan: { tier: "free", seatLimit: 3, badges: ["beta"], $typename: "Test.StudioPlan" },
        tags: ["a", "b"],
        note: null
    };
}

/**
 * A clean document mutated into a deliberately wrong shape - which is most of this suite. The
 * mutation runs over an untyped view, because the wrongness would not compile otherwise; the result
 * keeps the document type, because a drifted store hands back exactly this at the same boundary.
 */
function mutatedDocument(mutate: (document: Record<string, any>) => void): SnapshotDocumentOf<StudioState>
{
    const document = cleanDocument();
    mutate(document);
    return document;
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
        const document = mutatedDocument(t => { t.plan = null; t.tags = null; });

        assert.deepStrictEqual(querySet.verifyDocument(document), []);
    });

    // THE case this method exists for: serialize() emits every decorated key, so a declared segment
    // absent under a $typename parent is definitively a @serialize("customKey") rename
    await test("a key absent under a $typename parent is a fatal rename", () =>
    {
        // seatLimit renamed away
        const document = mutatedDocument(t => t.plan = { tier: "free", $typename: "Test.StudioPlan" });

        const issues = querySet.verifyDocument(document);

        assert.deepStrictEqual(kinds(issues), ["unresolvable-key:plan.seatLimit"]);
        assert.strictEqual(issues[0].severity, "fatal");
        assert.ok(issues[0].message.contains("rename"));
        assert.ok(issues[0].message.contains("tier"));                   // lists the stored keys
    });

    // absence under a PLAIN parent is ambiguous - it may be an omitted optional - so it warns
    await test("a key absent at the top level is an advisory", () =>
    {
        const document = mutatedDocument(t => delete t.note);

        const issues = querySet.verifyDocument(document);

        assert.deepStrictEqual(kinds(issues), ["absent-key:note"]);
        assert.strictEqual(issues[0].severity, "advisory");
    });

    await test("an absent key under an empty plain parent hints at Map/Set", () =>
    {
        const document = mutatedDocument(t => t.plan = {});              // what a Map serializes to

        const issues = querySet.verifyDocument(document);

        assert.deepStrictEqual(kinds(issues), ["absent-key:plan.seatLimit", "absent-key:plan.tier"]);
        assert.ok(issues.every(t => t.severity === "advisory"));
        assert.ok(issues[0].message.contains("Map or Set"));
    });

    // a value of the wrong KIND is never what an optional produces, so it is always fatal
    await test("a scalar or array intermediate is fatal", () =>
    {
        const withScalar = mutatedDocument(t => t.plan = "free");

        const scalarIssues = querySet.verifyDocument(withScalar);
        assert.deepStrictEqual(kinds(scalarIssues), ["non-object-intermediate:plan.seatLimit", "non-object-intermediate:plan.tier"]);
        assert.ok(scalarIssues.every(t => t.severity === "fatal"));

        const withArray = mutatedDocument(t => t.plan = ["free"]);

        const arrayIssues = querySet.verifyDocument(withArray);
        assert.deepStrictEqual(kinds(arrayIssues), ["non-object-intermediate:plan.seatLimit", "non-object-intermediate:plan.tier"]);
    });

    await test("an array path resolving to a non-array is fatal", () =>
    {
        const document = mutatedDocument(t => t.tags = {});              // a Set serializes to {}

        const issues = querySet.verifyDocument(document);

        assert.deepStrictEqual(kinds(issues), ["non-array-leaf:tags"]);
        assert.strictEqual(issues[0].severity, "fatal");
        assert.ok(issues[0].message.contains("Map or Set"));
    });

    await test("an absent array path is an advisory, like any absent key", () =>
    {
        const document = mutatedDocument(t => delete t.tags);

        assert.deepStrictEqual(kinds(querySet.verifyDocument(document)), ["absent-key:tags"]);
    });

    // `plan.badges` is an array path whose leaf sits INSIDE a serialized record - a shape that could
    // not be written before n-domain 4.0.3, so the runtime walk has never been exercised on it. The
    // rules must be the ones a top-level array path already gets, one level deeper.
    await test("an array path inside a serialized record is verified like any other", () =>
    {
        const nestedArraySet = SnapshotQuerySet.for<StudioState>().withArrayPath("plan.badges");

        assert.deepStrictEqual(nestedArraySet.verifyDocument(cleanDocument()), []);

        // an empty array is clean: a containment index over [] is legal, it just never matches
        assert.deepStrictEqual(nestedArraySet.verifyDocument(mutatedDocument(t => t.plan.badges = [])), []);

        // THE case verifyDocument exists for, now reachable through a nested array: serialize()
        // emits every decorated key, so an absent one under a $typename parent is a rename
        const renamed = mutatedDocument(t => t.plan = { tier: "free", seatLimit: 3, $typename: "Test.StudioPlan" });
        const renamedIssues = nestedArraySet.verifyDocument(renamed);

        assert.deepStrictEqual(kinds(renamedIssues), ["unresolvable-key:plan.badges"]);
        assert.strictEqual(renamedIssues[0].severity, "fatal");

        // the Map/Set gap on a nested array leaf, same as `tags` gets at the top level
        const notAnArray = mutatedDocument(t => t.plan.badges = {});
        const notAnArrayIssues = nestedArraySet.verifyDocument(notAnArray);

        assert.deepStrictEqual(kinds(notAnArrayIssues), ["non-array-leaf:plan.badges"]);
        assert.strictEqual(notAnArrayIssues[0].severity, "fatal");

        // and a null intermediate stays clean, because that is what an optional stores
        assert.deepStrictEqual(nestedArraySet.verifyDocument(mutatedDocument(t => t.plan = null)), []);
    });

    // a scalar path landing on an empty object is the Map/Set gap on the leaf itself
    await test("a scalar path resolving to an empty object is an advisory", () =>
    {
        const document = mutatedDocument(t => t.note = {});

        const issues = querySet.verifyDocument(document);

        assert.deepStrictEqual(kinds(issues), ["empty-object-leaf:note"]);
        assert.strictEqual(issues[0].severity, "advisory");
    });

    // a NON-empty object leaf stays silent: indexing a whole subtree is a documented raw-door use
    await test("a scalar path resolving to a non-empty object is silent", () =>
    {
        const document = mutatedDocument(t => t.note = { a: 1 });

        assert.deepStrictEqual(querySet.verifyDocument(document), []);
    });

    await test("several issues are reported together, one per declared path", () =>
    {
        const document = mutatedDocument(t =>
        {
            t.plan = { tier: "free", $typename: "Test.StudioPlan" };
            t.tags = {};
            delete t.note;
        });

        assert.deepStrictEqual(kinds(querySet.verifyDocument(document)),
            ["absent-key:note", "non-array-leaf:tags", "unresolvable-key:plan.seatLimit"]);
    });

    await test("a nullish or non-object document is rejected", () =>
    {
        assert.throws(() => querySet.verifyDocument(<any>null));
        assert.throws(() => querySet.verifyDocument(<any>undefined));
        assert.throws(() => querySet.verifyDocument(<any>"{}"));
    });

    // the type-level half of the round trip: a document literal is checked against the REAL stored
    // shape - nested DomainObjects as their serialized records ($typename included), wrong leaves
    // rejected at compile time
    await test("a document typed as SnapshotDocumentOf is accepted, and a wrong leaf is a compile error", () =>
    {
        const document: SnapshotDocumentOf<StudioState> = {
            id: "studio_1", version: 3, createdAt: 1, updatedAt: 2,
            isRebased: false, rebasedFromVersion: 0, typeVersion: 1,
            name: "n",
            plan: { tier: "free", seatLimit: 3, badges: ["beta"], $typename: "Test.Plan" },
            tags: ["a", "b"],
            note: null                          // what an undefined optional stores - and how the type states it
        };

        assert.deepStrictEqual(querySet.verifyDocument(document), []);

        const wrongLeaf: SnapshotDocumentOf<StudioState> = {
            ...document,
            // @ts-expect-error - seatLimit stores a number; a string literal is a compile error
            plan: { tier: "free", seatLimit: "3", badges: ["beta"], $typename: "Test.Plan" }
        };
        assert.ok(wrongLeaf);
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
            verifyDocument: (document: SnapshotDocumentOf<StudioState>) =>
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
        // seatLimit renamed away
        const renamed = mutatedDocument(t => t.plan = { tier: "free", $typename: "Test.StudioPlan" });

        // the flag is set only on a fatal-free pass, so both saves reject - never the second one through
        await assert.rejects(() => SnapshotShapeGuard.verify("studio_snaps", set, renamed, logger),
            (error: Error) => error.message.contains("plan.seatLimit"));
        await assert.rejects(() => SnapshotShapeGuard.verify("studio_snaps", set, renamed, logger));
    });

    // the rename that hides inside a nested array declaration - the shape n-domain 4.0.3 made
    // writable. It must reach the save-time guard exactly as a nested scalar rename does.
    await test("a rename under a nested array path rejects the save too", async () =>
    {
        const set = SnapshotQuerySet.for<StudioState>().withArrayPath("plan.badges");
        const logger = new CapturingLogger();
        const renamed = mutatedDocument(t => t.plan = { tier: "free", seatLimit: 3, $typename: "Test.StudioPlan" });

        await assert.rejects(() => SnapshotShapeGuard.verify("studio_snaps", set, renamed, logger),
            (error: Error) => error.message.contains("plan.badges"));
        assert.deepStrictEqual(logger.warnings, []);
    });

    await test("advisories warn once and let the save proceed", async () =>
    {
        const set = freshSet();
        const logger = new CapturingLogger();
        const document = mutatedDocument(t => delete t.note);

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
        const broken = mutatedDocument(t => t.tags = {});

        await assert.rejects(() => SnapshotShapeGuard.verify("studio_snaps", set, broken, logger));

        // the shape is fixed (a fresh deploy, say) - the same set now passes and stays verified
        await SnapshotShapeGuard.verify("studio_snaps", set, cleanDocument(), logger);
        await SnapshotShapeGuard.verify("studio_snaps", set, broken, logger);   // flag set: no re-walk

        assert.deepStrictEqual(logger.warnings, []);
    });
});
