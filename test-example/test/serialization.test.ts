import { AggregateRoot, ConfigurableDomainContext, DomainContext, OrgConfigurableDomainContext } from "@nivinjoseph/n-domain";
import { Deserializer } from "@nivinjoseph/n-util";
import assert from "node:assert";
import test, { describe } from "node:test";
import { ArgumentNullException } from "@nivinjoseph/n-exception";
import { toSnapshotDocument } from "../../src/index.js";
import { CreatorActivity } from "../creator/read-models/creator-activity.js";
import { Creator } from "../creator/creator.js";
import { CreatorStateFactory } from "../creator/creator-state.js";
import { SnapshotCreatorRepository } from "../creator/repositories/snapshot-creator-repository.js";
import { DefaultCreatorFactory } from "../creator/factories/default-creator-factory.js";
import { DefaultStudioFactory } from "../studio/factories/default-studio-factory.js";
import { SnapshotStudioRepository } from "../studio/repositories/snapshot-studio-repository.js";
import { Studio } from "../studio/studio.js";
import { StudioStateFactory } from "../studio/studio-state.js";
import { StudioPlan } from "../studio/value-objects/studio-plan.js";
import { InMemoryCreatorRepository } from "./in-memory-creator-repository.js";
import { InMemoryStudioRepository } from "./in-memory-studio-repository.js";

const studioId = "std_260810abcdefghijklmnopqrstuv";

/**
 * Every `@serialize`-decorated class has to survive a round trip through storage, and the failure mode is
 * unforgiving: `Deserializer` reconstructs by calling `new Type(serializedJson)`, with no mapping step, so a
 * serialized key that does not match a constructor parameter name silently arrives as `undefined` and trips a
 * `given` guard - at *read* time, long after the write that caused it.
 *
 * These tests exercise the two paths n-data's repositories actually use: `serialize()` then
 * `deserializeFromEvents` for the event stream, and `snapshot()` then `deserializeFromSnapshot` for the
 * snapshot table.
 *
 * The assertions read the reconstructed **getters** rather than comparing serialized forms, because that is
 * what proves the constructor bound each field rather than merely that the JSON matched.
 */
await describe("Serialization", async () =>
{
    const domainContext: DomainContext = new ConfigurableDomainContext("tester");
    const orgDomainContext = new OrgConfigurableDomainContext("tester", studioId);

    async function createStudio(): Promise<Studio>
    {
        const repository = new InMemoryStudioRepository();
        const id = await new DefaultStudioFactory(domainContext, repository)
            .create("Bright Forge", "studio", 12);
        const studio = await repository.get(id);

        studio.addTag("animation");
        studio.setCreatorCount(4);
        // a populated array inside the value object, so the snapshot round trip below carries one
        studio.changePlan(new StudioPlan({ tier: "enterprise", seatLimit: 0, features: ["4k-export", "priority-support"] }));

        return studio;
    }

    async function createCreator(): Promise<Creator>
    {
        const repository = new InMemoryCreatorRepository(orgDomainContext);
        const id = await new DefaultCreatorFactory(orgDomainContext, repository)
            .invite("ada@example.com", "Ada Lovelace", "lead");
        const creator = await repository.get(id);

        creator.addSkill("rigging");
        creator.updateProfile("Ada L");

        return creator;
    }

    await test("every event class is registered with the deserializer", async () =>
    {
        // registration is a side effect of the class-level @serialize decorator, so it only happens once the
        // module has been evaluated - importing the aggregate pulls its events in transitively
        const expected = [
            "StudioCreated", "StudioRenamed", "StudioPlanChanged", "StudioTagged",
            "StudioCreatorCountChanged", "StudioArchived", "StudioPlan",
            "CreatorInvited", "CreatorProfileUpdated", "CreatorRoleChanged",
            "CreatorSkillAdded", "CreatorDeactivated"
        ];

        for (const typeName of expected)
            assert.ok(Deserializer.hasType(typeName), `${typeName} is not registered`);
    });

    await test("a studio round-trips through its event stream", async () =>
    {
        const studio = await createStudio();
        const serialized = studio.serialize();

        const replayed = AggregateRoot.deserializeFromEvents<Studio, any, any>(
            domainContext, Studio, new StudioStateFactory(), serialized.$events);

        assert.strictEqual(replayed.id, studio.id);
        assert.strictEqual(replayed.version, studio.version);
        assert.strictEqual(replayed.name, studio.name);
        assert.strictEqual(replayed.slug, studio.slug);
        assert.strictEqual(replayed.creatorCount, studio.creatorCount);
        assert.deepStrictEqual([...replayed.tags], [...studio.tags]);

        // the value object came back as a StudioPlan, not a bare object - Deserializer revives anything
        // carrying a $typename, recursively
        assert.ok(replayed.plan instanceof StudioPlan);
        assert.strictEqual(replayed.plan.tier, "enterprise");
        assert.strictEqual(replayed.plan.isUnlimited, true);
    });

    await test("a studio round-trips through its snapshot", async () =>
    {
        const studio = await createStudio();
        const snapshot = studio.snapshot();

        // what the snapshot table stores is JSON, so the round trip goes through it
        const stored = JSON.parse(JSON.stringify(snapshot));

        const restored = AggregateRoot.deserializeFromSnapshot<Studio, any, any>(
            domainContext, Studio, new StudioStateFactory(), stored);

        assert.strictEqual(restored.id, studio.id);
        assert.strictEqual(restored.version, studio.version);
        assert.strictEqual(restored.name, studio.name);
        assert.ok(restored.plan instanceof StudioPlan);
        assert.strictEqual(restored.plan.seatLimit, studio.plan.seatLimit);

        // the materialized derived value is stored, so it is in the document as its own key rather
        // than only on the reconstructed object - which is what makes it indexable at all
        assert.strictEqual(stored.plan.featureCount, 2);
        assert.strictEqual(restored.plan.featureCount, 2);

        // reconstructed from state, so there are no events to replay and nothing pending
        assert.strictEqual(restored.hasChanges, false);
    });

    // the test-time half of the shape guard the repositories run on first save: every path the
    // repository declares resolves inside a real snapshot document. This is what catches a
    // '@serialize("customKey")' rename hiding inside an OPTIONAL member that production might not
    // store for a while - the compile-time check cannot see renames at all.
    // toSnapshotDocument is the cast-free door: it types snapshot()'s output as what is stored.
    await test("every declared index path resolves in a real snapshot", async () =>
    {
        const studio = await createStudio();

        assert.deepStrictEqual(SnapshotStudioRepository.indexes.verifyDocument(toSnapshotDocument(studio)), []);
    });

    // the same assertion for the org-scoped side, against the creator repository's declaration
    await test("every declared creator index path resolves in a real snapshot", async () =>
    {
        const creator = await createCreator();

        assert.deepStrictEqual(SnapshotCreatorRepository.indexes.verifyDocument(toSnapshotDocument(creator)), []);
    });

    await test("replay and snapshot agree", async () =>
    {
        const studio = await createStudio();

        const replayed = AggregateRoot.deserializeFromEvents<Studio, any, any>(
            domainContext, Studio, new StudioStateFactory(), studio.serialize().$events);
        const restored = AggregateRoot.deserializeFromSnapshot<Studio, any, any>(
            domainContext, Studio, new StudioStateFactory(),
            JSON.parse(JSON.stringify(studio.snapshot())));

        // the two storage paths are independent, so this is the claim that matters: whichever one a
        // repository reads from, the aggregate is the same
        assert.deepStrictEqual(replayed.snapshot(), restored.snapshot());
    });

    await test("a creator round-trips through its event stream, keeping its studio", async () =>
    {
        const creator = await createCreator();

        const replayed = AggregateRoot.deserializeFromEvents<Creator, any, any>(
            orgDomainContext, Creator, new CreatorStateFactory(orgDomainContext),
            creator.serialize().$events);

        assert.strictEqual(replayed.id, creator.id);
        assert.strictEqual(replayed.email, creator.email);
        assert.strictEqual(replayed.displayName, "Ada L");
        assert.strictEqual(replayed.role, "lead");
        assert.deepStrictEqual([...replayed.skills], ["rigging"]);
        assert.strictEqual(replayed.organizationId, studioId);
    });

    await test("a creator round-trips through its snapshot", async () =>
    {
        const creator = await createCreator();
        const stored = JSON.parse(JSON.stringify(creator.snapshot()));

        const restored = AggregateRoot.deserializeFromSnapshot<Creator, any, any>(
            orgDomainContext, Creator, new CreatorStateFactory(orgDomainContext), stored);

        assert.strictEqual(restored.id, creator.id);
        assert.strictEqual(restored.organizationId, studioId);
        assert.deepStrictEqual([...restored.skills], [...creator.skills]);
    });

    // the guard that stops a stream being replayed into the wrong tenant
    await test("a creator's events refuse to replay under a different studio", async () =>
    {
        const creator = await createCreator();
        const otherContext = new OrgConfigurableDomainContext("tester", "std_260810zyxwvutsrqponmlkjihg");

        assert.throws(() => AggregateRoot.deserializeFromEvents<Creator, any, any>(
            otherContext, Creator, new CreatorStateFactory(otherContext),
            creator.serialize().$events));
    });

    await test("a value object round-trips on its own", async () =>
    {
        const plan = new StudioPlan({ tier: "studio", seatLimit: 25, features: ["beta"] });

        const restored = Deserializer.deserialize<StudioPlan>(plan.serialize());

        assert.ok(restored instanceof StudioPlan);
        assert.strictEqual(restored.tier, "studio");
        assert.strictEqual(restored.seatLimit, 25);
        // an array data key survives the round trip as an array, not as a stringified one
        assert.deepStrictEqual([...restored.features], ["beta"]);
        // the materialized count comes back too - and `equals` compares serialized state, so it is
        // part of what equality means now rather than an incidental extra key
        assert.strictEqual(restored.featureCount, 1);
        assert.ok(restored.equals(plan));
    });

    /**
     * The boundary of materializing a derived value, and the reason this is worth a test of its own.
     *
     * `plan.featureCount` is stored so it can be indexed, which means a row is a record of what the
     * derivation produced *when it was written*. The object is not: the constructor recomputes from
     * `features` every time, so a row whose count disagrees - written before the getter existed, or
     * under an older rule - yields a correct object anyway.
     *
     * The consequence is the honest cost. Until that aggregate is saved again, the index and the
     * object disagree: `gt("plan.featureCount", 50)` would match the tampered row below while the
     * studio it deserializes to reports 2. A recomputed-only value like `isUnlimited` cannot drift
     * this way, because there is nothing stored to drift from - and cannot be queried either.
     */
    await test("a materialized derived value is recomputed, not read back", async () =>
    {
        const studio = await createStudio();
        const stored = JSON.parse(JSON.stringify(studio.snapshot()));

        // stand in for a row written under an older rule: the array and its count disagree
        assert.strictEqual(stored.plan.featureCount, 2);
        stored.plan.featureCount = 99;

        const restored = AggregateRoot.deserializeFromSnapshot<Studio, any, any>(
            domainContext, Studio, new StudioStateFactory(), stored);

        // derived from `features` at construction, so the stale number never reaches the object
        assert.strictEqual(restored.plan.featureCount, 2);
        assert.deepStrictEqual([...restored.plan.features], ["4k-export", "priority-support"]);

        // and re-saving is what closes the gap - the next document carries the recomputed value
        assert.strictEqual(toSnapshotDocument(restored).plan.featureCount, 2);
    });
});

/**
 * The projection hydrates through its own constructor, so what the README promises for a stale row - a
 * named guard failure, not a TypeError - is pinned here, with no database.
 */
await describe("CreatorActivity hydration", async () =>
{
    const data = {
        id: "crt_260810abcdefghijklmnopqrstuv", studioId, email: "ada@example.com", displayName: "Ada Lovelace",
        role: "lead", joinedAt: 1700000000000, isDeactivated: false, skills: ["typescript", "postgres"]
    };

    await test("the materialized skill count is recomputed from the stored skills, never trusted", async () =>
    {
        const stored = { ...new CreatorActivity(data).serialize(), skillCount: 99 };

        assert.strictEqual(new CreatorActivity(<any>stored).skillCount, 2);
    });

    await test("a NULL skills column - a row older than the property - fails by name, not with a TypeError", async () =>
    {
        assert.throws(() => new CreatorActivity(<any>{ ...data, skills: null }), (e: Error) => e instanceof ArgumentNullException && e.message.contains("skills"));
    });
});
