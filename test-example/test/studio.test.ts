import { AggregateStateHelper, ConfigurableDomainContext, DomainContext } from "@nivinjoseph/n-domain";
import { ArgumentException, InvalidOperationException } from "@nivinjoseph/n-exception";
import assert from "node:assert";
import test, { describe } from "node:test";
import { DefaultStudioFactory } from "../studio/factories/default-studio-factory.js";
import { StudioSlugUnavailableException } from "../studio/exceptions/studio-slug-unavailable-exception.js";
import { StudioStateFactory } from "../studio/studio-state.js";
import { StudioPlan } from "../studio/value-objects/studio-plan.js";
import { InMemoryStudioRepository } from "./in-memory-studio-repository.js";

const domainContext: DomainContext = new ConfigurableDomainContext("tester");

async function createStudio(repository: InMemoryStudioRepository, name = "Bright Forge"): Promise<string>
{
    return new DefaultStudioFactory(domainContext, repository).create(name, "studio", 10);
}

await describe("Studio", async () =>
{
    await describe("Creation, through the factory", async () =>
    {
        await test("mints a prefixed id, derives the slug, and saves", async () =>
        {
            const repository = new InMemoryStudioRepository();

            const id = await createStudio(repository, "  Bright Forge  ");
            const studio = await repository.get(id);

            assert.ok(id.startsWith("std"), id);
            assert.strictEqual(studio.name, "Bright Forge");
            assert.strictEqual(studio.slug, "bright-forge");
            assert.strictEqual(studio.plan.tier, "studio");
            assert.strictEqual(studio.plan.seatLimit, 10);
            assert.strictEqual(studio.creatorCount, 0);
            assert.strictEqual(studio.isArchived, false);

            // the factory saved, so the aggregate is no longer new and has nothing pending
            assert.strictEqual(studio.version, 1);
            assert.strictEqual(studio.hasChanges, false);
        });

        await test("rejects a name whose slug would be empty", async () =>
        {
            const repository = new InMemoryStudioRepository();

            await assert.rejects(() => createStudio(repository, "!!!"), ArgumentException);
        });

        await test("rejects a duplicate slug with a domain exception", async () =>
        {
            const repository = new InMemoryStudioRepository();

            await createStudio(repository, "Bright Forge");

            // a different name that normalizes to the same slug is still a collision - which is why the
            // probe runs on the normalized value
            await assert.rejects(
                () => createStudio(repository, "bright   forge"),
                StudioSlugUnavailableException);
        });

        await test("rejects an unknown plan tier", async () =>
        {
            const repository = new InMemoryStudioRepository();

            await assert.rejects(
                () => new DefaultStudioFactory(domainContext, repository).create("X Studio", "platinum", 1),
                ArgumentException);
        });
    });

    await describe("Behavior", async () =>
    {
        await test("renaming re-derives the slug and advances the version", async () =>
        {
            const repository = new InMemoryStudioRepository();
            const studio = await repository.get(await createStudio(repository));

            await studio.rename("Forge Works", repository);

            assert.strictEqual(studio.name, "Forge Works");
            assert.strictEqual(studio.slug, "forge-works");
            assert.strictEqual(studio.version, 2);
            assert.strictEqual(studio.hasChanges, true);
        });

        await test("renaming to the same name applies no event", async () =>
        {
            const repository = new InMemoryStudioRepository();
            const studio = await repository.get(await createStudio(repository, "Bright Forge"));

            // differs only in surrounding whitespace, so it normalizes to what is already stored
            await studio.rename("  Bright Forge  ", repository);

            assert.strictEqual(studio.version, 1);
            assert.strictEqual(studio.hasChanges, false);
        });

        await test("renaming onto another studio's slug is rejected", async () =>
        {
            const repository = new InMemoryStudioRepository();
            await createStudio(repository, "Taken Name");
            const studio = await repository.get(await createStudio(repository, "Bright Forge"));

            await assert.rejects(() => studio.rename("Taken Name", repository), StudioSlugUnavailableException);
        });

        await test("a studio may keep its own slug on rename", async () =>
        {
            const repository = new InMemoryStudioRepository();
            const studio = await repository.get(await createStudio(repository, "Bright Forge"));

            // the excludeId argument is what makes this not a self-collision
            await studio.rename("Bright Forge!", repository);

            assert.strictEqual(studio.slug, "bright-forge");
            assert.strictEqual(studio.name, "Bright Forge!");
        });

        await test("tags are normalized and deduplicated", async () =>
        {
            const repository = new InMemoryStudioRepository();
            const studio = await repository.get(await createStudio(repository));

            studio.addTag("  Animation ");
            studio.addTag("animation");
            studio.addTag("vfx");

            assert.deepStrictEqual([...studio.tags], ["animation", "vfx"]);
            assert.strictEqual(studio.version, 3);
        });

        await test("changing to an equal plan applies no event", async () =>
        {
            const repository = new InMemoryStudioRepository();
            const studio = await repository.get(await createStudio(repository));

            // a different instance, equal by value - DomainObject compares its serialized form,
            // arrays included, so `features` has to match too
            studio.changePlan(new StudioPlan({ tier: "studio", seatLimit: 10, features: [] }));

            assert.strictEqual(studio.version, 1);
        });

        await test("seat availability reads the cached count against the plan", async () =>
        {
            const repository = new InMemoryStudioRepository();
            const studio = await repository.get(await createStudio(repository));

            assert.strictEqual(studio.hasSeatAvailable(), true);

            studio.setCreatorCount(10);
            assert.strictEqual(studio.hasSeatAvailable(), false);

            studio.changePlan(new StudioPlan({ tier: "enterprise", seatLimit: 0, features: [] }));
            assert.strictEqual(studio.hasSeatAvailable(), true);
        });

        await test("an archived studio refuses further changes", async () =>
        {
            const repository = new InMemoryStudioRepository();
            const studio = await repository.get(await createStudio(repository));

            studio.archive();

            assert.strictEqual(studio.isArchived, true);

            // InvalidOperationException, not ArgumentException: n-defensive special-cases the argument
            // name "this", which is what the `given(this, "this")` precondition idiom uses. So a state
            // precondition and a bad argument land on different branches of the exception hierarchy.
            assert.throws(() => studio.addTag("late"), InvalidOperationException);
            assert.throws(() => studio.archive(), InvalidOperationException);
            await assert.rejects(() => studio.rename("Late", repository), InvalidOperationException);
        });
    });

    // The default state is frozen into every created event, so changing it silently rewrites what replay
    // produces for fields no event writes. Pinning the fingerprint makes that change deliberate: this test
    // fails, and whoever changed the default decides whether history needs migrating.
    await test("the default state fingerprint has not drifted", async () =>
    {
        const fingerprint = AggregateStateHelper.fingerprintState(new StudioStateFactory().create());

        assert.strictEqual(
            fingerprint,
            // re-pinned when StudioPlan gained `features`: the default plan now serializes an empty
            // array, so the frozen default state changed shape. No history to migrate - the example's
            // tables are dropped and recreated per run.
            "52CDEE3F36E0C76EE965122086019352FA0E197445DDD7954D9D72E9FAB6CBF94DBE0519131981BE0063CF7BFED6E752CCA1D21F977AEE65BFAB18E19FD2A428");
    });
});
