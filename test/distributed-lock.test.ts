import * as Assert from "assert";
import { DistributedLockService, RedisDistributedLockService } from "../src";
import * as Redis from "redis";
import { Delay, Disposable, DisposableWrapper } from "@nivinjoseph/n-util";
import { given } from "@nivinjoseph/n-defensive";


class Synchronized
{
    private readonly _lockService: DistributedLockService;
    private readonly _values = new Array<number>();

    public get values(): ReadonlyArray<number> { return this._values; }

    
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

            console.log(ms);
            await Delay.milliseconds(ms);
            this._values.push(ms);
        }
        finally
        {
            await lock.release();
        }
    }
}

suite("DistributedLock tests", () =>
{
    let service: DistributedLockService;
    let connectionDisposable: Disposable;
    
    
    suiteSetup(() =>
    {
        const redisClient: Redis.RedisClient = Redis.createClient();
        connectionDisposable = new DisposableWrapper(() => new Promise((resolve, _) => redisClient.quit(() => resolve())));
        service = new RedisDistributedLockService(redisClient); 
    });
    
    suiteTeardown(async () =>
    {
        await connectionDisposable.dispose();   
    });
    
    
    test("Basics", async () =>
    {
        const synchronized = new Synchronized(service);

        const promises = new Array<Promise<void>>();

        for (let i = 3; i > 0; i--)
        {
            promises.push(synchronized.execute(i * 1000));
        }

        await Promise.all(promises);

        Assert.deepStrictEqual(synchronized.values[0], 3000);
    });
});