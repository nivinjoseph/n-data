import { Logger } from "@nivinjoseph/n-log";
import { AnyReadModel } from "./read-model.js";
import { ReadModelSchema } from "./read-model-schema.js";
/**
 * The once-per-schema half of a save's checks: `ReadModelSchema.verifyShape`, run against the first
 * model a process saves through a schema and logged as advisories, never again for that schema.
 *
 * The per-value half (`verifyValues`) is not here: it varies per instance, is synchronous, and the
 * repositories run it on every row before anything is queued. The shape is a fact about the class,
 * read from its metadata without serializing anything, so once per schema (the schema object IS the
 * declaration, normally a static) is enough - tracked in a `WeakSet` that also gives tests natural
 * isolation.
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
     * Logs the schema's shape advisories once per process, reading them off `model`.
     */
    static adviseOnce<T extends AnyReadModel>(schema: ReadModelSchema<T>, model: T, logger: Logger): Promise<void>;
}
//# sourceMappingURL=read-model-shape-guard.d.ts.map