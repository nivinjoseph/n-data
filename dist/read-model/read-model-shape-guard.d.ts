import { Logger } from "@nivinjoseph/n-log";
import { AnyReadModel } from "./read-model.js";
import { ReadModelSchema } from "./read-model-schema.js";
/**
 * The save-time half of `ReadModelSchema.verifyModel`, in its two halves: `verifyValues` on every
 * save, throwing on a fatal issue, and `verifyShape` once per schema per process, logging its
 * advisories.
 *
 * Values every save, unlike `SnapshotShapeGuard`: a fatal here is a *value* of the wrong kind or
 * range, which varies per instance, and it is the only data check before the database's own type
 * errors - which a `text` column never raises, since pg coerces into it silently. The shape is a
 * fact about the class, read from its metadata without serializing anything, so once per schema
 * (the schema object IS the declaration, normally a static) is enough - tracked in a `WeakSet` that
 * also gives tests natural isolation.
 *
 * Internal: not in the barrel. The consumer-facing door is `verifyModel` itself.
 */
export declare class ReadModelShapeGuard {
    private static readonly _advised;
    /**
     * Static class.
     */
    private constructor();
    /**
     * @throws {ArgumentException} If the model is not an instance of the schema's class, or any column cannot hold its value.
     */
    static verify<T extends AnyReadModel>(schema: ReadModelSchema<T>, model: T, logger: Logger): Promise<void>;
}
//# sourceMappingURL=read-model-shape-guard.d.ts.map