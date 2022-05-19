import { CacheService } from "./cache-service";
import { Disposable, Duration } from "@nivinjoseph/n-util";
import { given } from "@nivinjoseph/n-defensive";
import { ObjectDisposedException } from "@nivinjoseph/n-exception";
import { clearInterval, setInterval } from "timers";


export class InMemoryCacheService implements CacheService, Disposable
{
    private readonly _store: Map<string, string>;
    private readonly _evictionTracking: Map<string, number>;
    private readonly _timer: NodeJS.Timer;
    private _isDisposed: boolean;
    
    
    public constructor()
    {
        this._store = new Map<string, string>();
        this._evictionTracking = new Map<string, number>();
        this._isDisposed = false;
        
        this._timer = setInterval(() => this._evict(), Duration.fromMinutes(5).toMilliSeconds());
    }
    
    
    public async store<T>(key: string, value: T, expiryDuration?: Duration): Promise<void>
    {
        given(key, "key").ensureHasValue().ensureIsString();
        given(value, "value").ensureHasValue();
        given(expiryDuration as Duration, "expiryDuration").ensureIsInstanceOf(Duration);
        
        if (this._isDisposed)
            throw new ObjectDisposedException(this);
        
        key = key.trim();
        
        this._store.set(key, JSON.stringify(value));
        
        if (expiryDuration == null)
        {
            if (this._evictionTracking.has(key))
                this._evictionTracking.delete(key);
        }
        else
        {
            this._evictionTracking.set(key, Date.now() + expiryDuration.toMilliSeconds());
        }
    }
    
    public async retrieve<T>(key: string): Promise<T | null>
    {
        given(key, "key").ensureHasValue().ensureIsString();
        
        if (this._isDisposed)
            throw new ObjectDisposedException(this);
        
        key = key.trim();
        
        return this._store.has(key) ? JSON.parse(this._store.get(key)!) as T : null; 
    }
    
    public async exists(key: string): Promise<boolean>
    {
        given(key, "key").ensureHasValue().ensureIsString();
        
        if (this._isDisposed)
            throw new ObjectDisposedException(this);
        
        return this._store.has(key.trim());
    }
    
    public async remove(key: string): Promise<void>
    {
        given(key, "key").ensureHasValue().ensureIsString();
        
        if (this._isDisposed)
            throw new ObjectDisposedException(this);
        
        key = key.trim();
        
        if (this._store.has(key))
            this._store.delete(key);
        
        if (this._evictionTracking.has(key))
            this._evictionTracking.delete(key);
    }
    
    public dispose(): Promise<void>
    {
        if (this._isDisposed)
            return Promise.resolve();
        
        this._isDisposed = true;
        
        clearInterval(this._timer);
        
        return Promise.resolve();
    }    
    
    private _evict(): void
    {
        if (this._isDisposed)
            return;
        
        for (const entry of this._store.entries())
        {
            const key = entry[0];
            
            if (this._evictionTracking.has(key))
            {
                const expiry = this._evictionTracking.get(key) ?? 0;
                if (expiry <= Date.now())
                {
                    this._store.delete(key);
                    this._evictionTracking.delete(key);
                }
            }
        }
    }
}