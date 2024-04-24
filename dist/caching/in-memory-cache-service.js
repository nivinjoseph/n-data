import { Duration } from "@nivinjoseph/n-util";
import { given } from "@nivinjoseph/n-defensive";
import { ObjectDisposedException } from "@nivinjoseph/n-exception";
import { clearInterval, setInterval } from "node:timers";
export class InMemoryCacheService {
    constructor() {
        this._store = new Map();
        this._evictionTracking = new Map();
        this._isDisposed = false;
        this._timer = setInterval(() => this._evict(), Duration.fromMinutes(5).toMilliSeconds());
    }
    async store(key, value, expiryDuration) {
        given(key, "key").ensureHasValue().ensureIsString();
        given(value, "value").ensureHasValue();
        given(expiryDuration, "expiryDuration").ensureIsObject();
        if (this._isDisposed)
            throw new ObjectDisposedException(this);
        key = key.trim();
        this._store.set(key, JSON.stringify(value));
        if (expiryDuration == null) {
            if (this._evictionTracking.has(key))
                this._evictionTracking.delete(key);
        }
        else {
            this._evictionTracking.set(key, Date.now() + expiryDuration.toMilliSeconds());
        }
    }
    async retrieve(key) {
        given(key, "key").ensureHasValue().ensureIsString();
        if (this._isDisposed)
            throw new ObjectDisposedException(this);
        key = key.trim();
        return this._store.has(key) ? JSON.parse(this._store.get(key)) : null;
    }
    async exists(key) {
        given(key, "key").ensureHasValue().ensureIsString();
        if (this._isDisposed)
            throw new ObjectDisposedException(this);
        return this._store.has(key.trim());
    }
    async remove(key) {
        given(key, "key").ensureHasValue().ensureIsString();
        if (this._isDisposed)
            throw new ObjectDisposedException(this);
        key = key.trim();
        if (this._store.has(key))
            this._store.delete(key);
        if (this._evictionTracking.has(key))
            this._evictionTracking.delete(key);
    }
    dispose() {
        if (this._isDisposed)
            return Promise.resolve();
        this._isDisposed = true;
        clearInterval(this._timer);
        return Promise.resolve();
    }
    _evict() {
        var _a;
        if (this._isDisposed)
            return;
        for (const entry of this._store.entries()) {
            const key = entry[0];
            if (this._evictionTracking.has(key)) {
                const expiry = (_a = this._evictionTracking.get(key)) !== null && _a !== void 0 ? _a : 0;
                if (expiry <= Date.now()) {
                    this._store.delete(key);
                    this._evictionTracking.delete(key);
                }
            }
        }
    }
}
//# sourceMappingURL=in-memory-cache-service.js.map