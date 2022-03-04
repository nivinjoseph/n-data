import { RedisCacheService } from "../src";
import * as Redis from "redis";
import { Delay, DisposableWrapper, Duration } from "@nivinjoseph/n-util";
import * as Assert from "assert";


suite("cache tests", () =>
{
    let cacheService: RedisCacheService;
    let cacheRedisClientDisposable: DisposableWrapper;
    
    suiteSetup(async () =>
    {
        const cacheRedisClient = Redis.createClient({ return_buffers: true });
        cacheRedisClientDisposable = new DisposableWrapper(async () =>
        {
            await (Delay.seconds(5));
            await new Promise<void>((resolve, _) => cacheRedisClient.quit(() => resolve()));
        });
        
        cacheService = new RedisCacheService(cacheRedisClient);
    });

    suiteTeardown(async () =>
    {
        await cacheService.dispose();
        await cacheRedisClientDisposable.dispose();
    });
    
    
    suite("store", () =>
    {
        test("store number", async () =>
        {
            const key = "testing_store_number";
            await cacheService.store(key, 0);
            
            let retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, 0);
            
            let exists = await cacheService.exists(key);
            Assert.strictEqual(exists, true);
            
            await cacheService.remove(key);
            
            retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, null);
            
            exists = await cacheService.exists(key);
            Assert.strictEqual(exists, false);
            
            await cacheService.remove(key);
            Assert.ok(true);
        });
        
        test("store number with exp", async () =>
        {
            const key = "testing_store_number_exp";
            await cacheService.store(key, 0, Duration.fromSeconds(2));
            
            let retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, 0);
            
            let exists = await cacheService.exists(key);
            Assert.strictEqual(exists, true);
            
            await Delay.seconds(3);
            
            retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, null);
            
            exists = await cacheService.exists(key);
            Assert.strictEqual(exists, false);
            
            await cacheService.remove(key);
            Assert.ok(true);
        });
        
        test("store string", async () =>
        {
            const key = "testing_store_string";
            await cacheService.store(key, "foo");

            let retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, "foo");

            let exists = await cacheService.exists(key);
            Assert.strictEqual(exists, true);

            await cacheService.remove(key);

            retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            Assert.strictEqual(exists, false);

            await cacheService.remove(key);
            Assert.ok(true);
        });

        test("store string with exp", async () =>
        {
            const key = "testing_store_string_exp";
            await cacheService.store(key, "foo", Duration.fromSeconds(2));

            let retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, "foo");

            let exists = await cacheService.exists(key);
            Assert.strictEqual(exists, true);

            await Delay.seconds(3);

            retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            Assert.strictEqual(exists, false);

            await cacheService.remove(key);
            Assert.ok(true);
        });
        
        test("store boolean", async () =>
        {
            const key = "testing_store_boolean";
            await cacheService.store(key, false);

            let retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, false);

            let exists = await cacheService.exists(key);
            Assert.strictEqual(exists, true);

            await cacheService.remove(key);

            retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            Assert.strictEqual(exists, false);

            await cacheService.remove(key);
            Assert.ok(true);
        });

        test("store boolean with exp", async () =>
        {
            const key = "testing_store_boolean_exp";
            await cacheService.store(key, false, Duration.fromSeconds(2));

            let retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, false);

            let exists = await cacheService.exists(key);
            Assert.strictEqual(exists, true);

            await Delay.seconds(3);

            retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            Assert.strictEqual(exists, false);

            await cacheService.remove(key);
            Assert.ok(true);
        });
        
        
        test("store object", async () =>
        {
            const key = "testing_store_object";
            await cacheService.store(key, {foo: {bar: null}});

            let retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(JSON.stringify(retrieved), JSON.stringify({ foo: { bar: null } }));

            let exists = await cacheService.exists(key);
            Assert.strictEqual(exists, true);

            await cacheService.remove(key);

            retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            Assert.strictEqual(exists, false);

            await cacheService.remove(key);
            Assert.ok(true);
        });

        test("store object with exp", async () =>
        {
            const key = "testing_store_object_exp";
            await cacheService.store(key, { foo: { bar: null } }, Duration.fromSeconds(2));

            let retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(JSON.stringify(retrieved), JSON.stringify({ foo: { bar: null } }));

            let exists = await cacheService.exists(key);
            Assert.strictEqual(exists, true);

            await Delay.seconds(3);

            retrieved = await cacheService.retrieve(key);
            Assert.strictEqual(retrieved, null);

            exists = await cacheService.exists(key);
            Assert.strictEqual(exists, false);

            await cacheService.remove(key);
            Assert.ok(true);
        });
    });
    
    // suite("retrieve", () =>
    // {
    //     test("retrieve number");
    //     test("retrieve string");
    //     test("retrieve boolean");
    //     test("retrieve object");
    // });
    
    // suite("exists", () =>
    // {
    //     test("check exists");
    //     test("check exists after expiry");
    //     test("check exists after remove");
    // });
    
    // suite("remove", () =>
    // {
    //     test("check remove");
    // });
});