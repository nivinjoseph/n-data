import { Delay, DisposableWrapper, Duration } from "@nivinjoseph/n-util";
import assert from "node:assert";
import test, { after, before, describe } from "node:test";
import { createClient } from "redis";
import { RedisCacheService } from "../src/index.js";


await describe("cache tests", async () =>
{
    let cacheService: RedisCacheService;
    let cacheRedisClientDisposable: DisposableWrapper;

    before(async () =>
    {
        const cacheRedisClient = await createClient({}).connect();
        cacheRedisClientDisposable = new DisposableWrapper(async () =>
        {
            await Delay.seconds(5);
            await cacheRedisClient.close();
        });

        cacheService = new RedisCacheService(cacheRedisClient);
    });

    after(async () =>
    {
        await cacheService.dispose();
        await cacheRedisClientDisposable.dispose();
    });


    await describe("store", async () =>
    {
        await test("store number", async () =>
        {
            const key = "testing_store_number";
            await cacheService.store(key, 0);

            let retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, 0);

            let exists = await cacheService.exists(key);
            assert.strictEqual(exists, true);

            await cacheService.remove(key);

            retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            assert.strictEqual(exists, false);

            await cacheService.remove(key);
            assert.ok(true);
        });

        await test("store number with exp", async () =>
        {
            const key = "testing_store_number_exp";
            await cacheService.store(key, 0, Duration.fromSeconds(2));

            let retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, 0);

            let exists = await cacheService.exists(key);
            assert.strictEqual(exists, true);

            await Delay.seconds(3);

            retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            assert.strictEqual(exists, false);

            await cacheService.remove(key);
            assert.ok(true);
        });

        await test("store string", async () =>
        {
            const key = "testing_store_string";
            await cacheService.store(key, "foo");

            let retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, "foo");

            let exists = await cacheService.exists(key);
            assert.strictEqual(exists, true);

            await cacheService.remove(key);

            retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            assert.strictEqual(exists, false);

            await cacheService.remove(key);
            assert.ok(true);
        });

        await test("store string with exp", async () =>
        {
            const key = "testing_store_string_exp";
            await cacheService.store(key, "foo", Duration.fromSeconds(2));

            let retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, "foo");

            let exists = await cacheService.exists(key);
            assert.strictEqual(exists, true);

            await Delay.seconds(3);

            retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            assert.strictEqual(exists, false);

            await cacheService.remove(key);
            assert.ok(true);
        });

        await test("store boolean", async () =>
        {
            const key = "testing_store_boolean";
            await cacheService.store(key, false);

            let retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, false);

            let exists = await cacheService.exists(key);
            assert.strictEqual(exists, true);

            await cacheService.remove(key);

            retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            assert.strictEqual(exists, false);

            await cacheService.remove(key);
            assert.ok(true);
        });

        await test("store boolean with exp", async () =>
        {
            const key = "testing_store_boolean_exp";
            await cacheService.store(key, false, Duration.fromSeconds(2));

            let retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, false);

            let exists = await cacheService.exists(key);
            assert.strictEqual(exists, true);

            await Delay.seconds(3);

            retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            assert.strictEqual(exists, false);

            await cacheService.remove(key);
            assert.ok(true);
        });


        await test("store object", async () =>
        {
            const key = "testing_store_object";
            await cacheService.store(key, { foo: { bar: null } });

            let retrieved = await cacheService.retrieve(key);
            assert.strictEqual(JSON.stringify(retrieved), JSON.stringify({ foo: { bar: null } }));

            let exists = await cacheService.exists(key);
            assert.strictEqual(exists, true);

            await cacheService.remove(key);

            retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            assert.strictEqual(exists, false);

            await cacheService.remove(key);
            assert.ok(true);
        });

        await test("store object with exp", async () =>
        {
            const key = "testing_store_object_exp";
            await cacheService.store(key, { foo: { bar: null } }, Duration.fromSeconds(2));

            let retrieved = await cacheService.retrieve(key);
            assert.strictEqual(JSON.stringify(retrieved), JSON.stringify({ foo: { bar: null } }));

            let exists = await cacheService.exists(key);
            assert.strictEqual(exists, true);

            await Delay.seconds(3);

            retrieved = await cacheService.retrieve(key);
            assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            assert.strictEqual(exists, false);

            await cacheService.remove(key);
            assert.ok(true);
        });
    });

    // await describe("retrieve", () =>
    // {
    //    await test("retrieve number");
    //    await test("retrieve string");
    //    await test("retrieve boolean");
    //    await test("retrieve object");
    // });

    // await describe("exists", () =>
    // {
    //    await test("check exists");
    //    await test("check exists after expiry");
    //    await test("check exists after remove");
    // });

    // await describe("remove", () =>
    // {
    //    await test("check remove");
    // });
});