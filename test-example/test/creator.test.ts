import { AggregateStateHelper, OrgConfigurableDomainContext } from "@nivinjoseph/n-domain";
import { ArgumentException, InvalidOperationException } from "@nivinjoseph/n-exception";
import assert from "node:assert";
import test, { describe } from "node:test";
import { CreatorStateFactory } from "../creator/creator-state.js";
import { DefaultCreatorFactory } from "../creator/factories/default-creator-factory.js";
import { CreatorEmailUnavailableException } from "../creator/exceptions/creator-email-unavailable-exception.js";
import { InMemoryCreatorRepository } from "./in-memory-creator-repository.js";

const studioA = "std_260810abcdefghijklmnopqrstuv";
const studioB = "std_260810zyxwvutsrqponmlkjihg";

function createContext(organizationId: string): OrgConfigurableDomainContext
{
    return new OrgConfigurableDomainContext("tester", organizationId);
}

await describe("Creator", async () =>
{
    await describe("Creation, through the factory", async () =>
    {
        await test("mints a prefixed id, normalizes the email, and stamps the studio", async () =>
        {
            const context = createContext(studioA);
            const repository = new InMemoryCreatorRepository(context);

            const id = await new DefaultCreatorFactory(context, repository)
                .invite("  Ada@Example.COM ", "  Ada Lovelace  ", "lead");
            const creator = await repository.get(id);

            assert.ok(id.startsWith("crt"), id);
            assert.strictEqual(creator.email, "ada@example.com");
            assert.strictEqual(creator.displayName, "Ada Lovelace");
            assert.strictEqual(creator.role, "lead");
            assert.ok(creator.joinedAt > 0);

            // the organization is never carried by an event - the state factory stamps it from the context
            assert.strictEqual(creator.organizationId, studioA);
        });

        await test("the default role needs no second event", async () =>
        {
            const context = createContext(studioA);
            const repository = new InMemoryCreatorRepository(context);

            const id = await new DefaultCreatorFactory(context, repository)
                .invite("member@example.com", "A Member", "member");
            const creator = await repository.get(id);

            // "member" is the state factory's default, so the factory skips the role event
            assert.strictEqual(creator.role, "member");
            assert.strictEqual(creator.version, 1);
        });

        await test("rejects an unknown role", async () =>
        {
            const context = createContext(studioA);
            const repository = new InMemoryCreatorRepository(context);

            await assert.rejects(
                () => new DefaultCreatorFactory(context, repository)
                    .invite("x@example.com", "X", "overlord"),
                ArgumentException);
        });

        await test("rejects a duplicate email within the studio", async () =>
        {
            const context = createContext(studioA);
            const repository = new InMemoryCreatorRepository(context);
            const factory = new DefaultCreatorFactory(context, repository);

            await factory.invite("ada@example.com", "Ada", "member");

            // differs only in case, and the normal form is lower-cased, so this is the same email
            await assert.rejects(
                () => factory.invite("ADA@example.com", "Ada Again", "member"),
                CreatorEmailUnavailableException);
        });

        // the behavior a tenant-scoped natural key should have, and the reason the unique index leading with
        // organization_id is not an implementation detail
        await test("the same email is free in a different studio", async () =>
        {
            const contextA = createContext(studioA);
            const contextB = createContext(studioB);

            // one store, two scopes - the way two requests share a database
            const repositoryA = new InMemoryCreatorRepository(contextA);
            const repositoryB = new InMemoryCreatorRepository(contextB);

            await new DefaultCreatorFactory(contextA, repositoryA).invite("ada@example.com", "Ada", "member");
            const idB = await new DefaultCreatorFactory(contextB, repositoryB)
                .invite("ada@example.com", "Ada", "admin");

            const creatorB = await repositoryB.get(idB);

            assert.strictEqual(creatorB.organizationId, studioB);
            assert.strictEqual(creatorB.role, "admin");
        });
    });

    await describe("Behavior", async () =>
    {
        async function invite(): Promise<{ context: OrgConfigurableDomainContext; repository: InMemoryCreatorRepository; id: string; }>
        {
            const context = createContext(studioA);
            const repository = new InMemoryCreatorRepository(context);
            const id = await new DefaultCreatorFactory(context, repository)
                .invite("ada@example.com", "Ada", "member");

            return { context, repository, id };
        }

        await test("skills are normalized and deduplicated", async () =>
        {
            const { repository, id } = await invite();
            const creator = await repository.get(id);

            creator.addSkill("  Rigging ");
            creator.addSkill("rigging");
            creator.addSkill("compositing");

            assert.deepStrictEqual([...creator.skills], ["rigging", "compositing"]);
        });

        await test("changing to the same role applies no event", async () =>
        {
            const { repository, id } = await invite();
            const creator = await repository.get(id);
            const versionBefore = creator.version;

            creator.changeRole("member");

            assert.strictEqual(creator.version, versionBefore);
        });

        await test("a deactivated creator refuses further changes", async () =>
        {
            const { repository, id } = await invite();
            const creator = await repository.get(id);

            creator.deactivate();

            assert.strictEqual(creator.isDeactivated, true);

            // InvalidOperationException rather than ArgumentException - see the studio suite for why
            assert.throws(() => creator.addSkill("late"), InvalidOperationException);
            assert.throws(() => creator.changeRole("admin"), InvalidOperationException);
            assert.throws(() => creator.updateProfile("Late"), InvalidOperationException);
        });

        await test("a creator from another studio is invisible", async () =>
        {
            const { id } = await invite();

            // the same store, read under a different organization
            const otherRepository = new InMemoryCreatorRepository(createContext(studioB));

            await assert.rejects(() => otherRepository.get(id));
        });
    });

    await test("the default state fingerprint has not drifted", async () =>
    {
        // the organization lands in default state, so it is part of the fingerprint - hence a fixed studio id
        const state = new CreatorStateFactory(createContext(studioA)).create();

        assert.strictEqual(
            AggregateStateHelper.fingerprintState(state),
            "AA3CCA92114456FEF6ED289ABE598F9B718EE0F141AC9B73750E5F16FFC888BC14EA59A86DE622A3397D0FD34B84AED1560A73DB94A344A36F23E9C7429B5523");
    });
});
