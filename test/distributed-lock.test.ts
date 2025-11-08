import { given } from "@nivinjoseph/n-defensive";
import { Delay, Disposable, DisposableWrapper, Duration } from "@nivinjoseph/n-util";
import { test, after, before, describe } from "node:test";
import { createClient } from "redis";
import { DistributedLockService, RedisDistributedLockService } from "../src/index.js";
import assert from "node:assert";
import { UnableToAcquireDistributedLockException } from "../src/distributed-lock/redis-distributed-lock-service.js";


class Synchronized
{
    private readonly _lockService: DistributedLockService;
    private readonly _values = new Array<number>();

    private readonly _events = new Array<string>();

    public get values(): ReadonlyArray<number> { return this._values; }
    public get events(): ReadonlyArray<string> { return this._events; }


    public constructor(lockService: DistributedLockService)
    {
        given(lockService, "lockService").ensureHasValue().ensureIsObject();
        this._lockService = lockService;
    }


    public async execute(ms: number): Promise<void>
    {
        const lock = await this._lockService.lock("testing");

        try
        {
            // if (ms === 3000)
            //     throw new Error("boom");

            this._events.push(`Started ${ms}`);
            console.log(ms);
            await Delay.milliseconds(ms);
            this._values.push(ms);
            this._events.push(`Finished ${ms}`);
        }
        finally
        {
            await lock.release();
        }
    }
}

await describe("DistributedLock tests", async () =>
{
    let service: RedisDistributedLockService;
    let connectionDisposable: Disposable;


    before(async () =>
    {
        const redisClient = await createClient<any, any, any, any, any>().connect();
        service = new RedisDistributedLockService(redisClient);
        connectionDisposable = new DisposableWrapper(async () =>
        {
            await service.dispose();
            await redisClient.close();
        });
    });

    after(async () =>
    {
        await service.dispose();
        await connectionDisposable.dispose();
    });


    await test("Basics", async () =>
    {
        const synchronized = new Synchronized(service);

        const promises = new Array<Promise<void>>();

        for (let i = 3; i > 0; i--)
        {
            console.log("exec", i);
            promises.push(synchronized.execute(i * 1000));
            await Delay.milliseconds(200);
        }

        await Promise.all(promises);

        assert.strictEqual(synchronized.values[0], 3000);
        assert.strictEqual(synchronized.values[1], 2000);
        assert.strictEqual(synchronized.values[2], 1000);
    });

    await test("Long ttl", async () =>
    {
        const synchronized = new Synchronized(service);

        const promises = new Array<Promise<void>>();

        const opDuration = Duration.fromSeconds(1).toMilliSeconds();
        for (let i = 3; i > 0; i--)
        {
            // console.log("exec", 0);

            await Delay.seconds(1);
            promises.push(synchronized.execute(opDuration + i));
        }

        await Promise.all(promises);

        assert.strictEqual(synchronized.values[0], 1003);
        assert.strictEqual(synchronized.values[1], 1002);
        assert.strictEqual(synchronized.values[2], 1001);
    });


    await test(`
            Given a lock
            When acquired by 3 simultaneous operations that record the events 'Started 'opsNumber'' and 'Finished 'opsNumber''
            Then the events should be correct and in order
            `, async () =>
    {
        const synchronized = new Synchronized(service);

        const promises = new Array<Promise<void>>();

        const opDuration = Duration.fromSeconds(1).toMilliSeconds();
        for (let i = 3; i > 0; i--)
        {
            // console.log("exec", 0);

            await Delay.seconds(1);
            promises.push(synchronized.execute(opDuration + i));
        }

        await Promise.all(promises);

        assert.strictEqual(synchronized.events.length, 6);
        for (let i = 0; i < synchronized.events.length; i = i + 2)
        {
            const firstEvent = synchronized.events[i];
            const secondEvent = synchronized.events[i + 1];

            assert.ok(firstEvent.startsWith("Started"), "should be the Started event");
            assert.ok(secondEvent.startsWith("Finished"), "should be the Finished event");

            const firstEventValue = firstEvent.split(" ").takeLast();
            const secondEventValue = secondEvent.split(" ").takeLast();

            assert.ok(firstEventValue === secondEventValue, "value for Started and Finished event should be the same");
        }
    });

    await test(`
        Given a lock that is already released
        When attempting to release the lock again
        Then no error should be thrown
    `, async () =>
    {
        const lock = await service.lock("test-lock");
        await lock.release();

        assert.doesNotThrow(() => lock.release());
    });

    await test(`
        Given a lock that is already expired
        When attempting to release the lock
        Then no error should be thrown
    `, async () =>
    {
        const lock = await service.lock("test-lock", Duration.fromMilliSeconds(500));
        await Delay.milliseconds(600);
        assert.doesNotThrow(() => lock.release());
    });

    await test(`
        Given a lock that is already expired
        When attempting to acquire the lock again
        Then the lock should be acquired immediately
    `, async () =>
    {
        await service.lock("test-lock", Duration.fromMilliSeconds(200));
        await Delay.milliseconds(300);

        const acquireAttempt = Date.now();

        const lock2 = await service.lock("test-lock", Duration.fromMilliSeconds(100));

        const acquiredTime = Date.now();
        const acquiringDuration = acquiredTime - acquireAttempt;
        assert.ok(acquiringDuration < 5, "acquiring time should be less than 5ms");

        await lock2.release();
    });

    await test(`
        Given a lock that was acquired with a very long ttl 
        When attempting to acquire the lock again with default delay and retries
        Then UnableToAcquireDistributedLockException should be thrown
    `, async () =>
    {
        const lock1 = await service.lock("test-lock", Duration.fromSeconds(200));


        let errorThrow = false;

        try
        {
            await service.lock("test-lock", Duration.fromMilliSeconds(100));
        }
        catch (e)
        {
            if (e instanceof UnableToAcquireDistributedLockException)
                errorThrow = true;
            else
                throw e;
        }

        assert.ok(errorThrow);

        await lock1.release();
    });
});