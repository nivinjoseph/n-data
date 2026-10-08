import { ArgumentException } from "@nivinjoseph/n-exception";
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
export class ReadModelShapeGuard {
    static _advised = new WeakSet();
    /**
     * Static class.
     */
    constructor() { }
    /**
     * @throws {ArgumentException} If the model is not an instance of the schema's class, or any column cannot hold its value.
     */
    static async verify(schema, model, logger) {
        const fatals = schema.verifyValues(model);
        if (fatals.length > 0)
            throw new ArgumentException("model", `cannot be stored in '${schema.table}': ${fatals.map(t => t.message).join(" | ")}`);
        if (ReadModelShapeGuard._advised.has(schema))
            return;
        // marked before the shape pass, so a schema is looked at exactly once however it goes
        ReadModelShapeGuard._advised.add(schema);
        const advisories = schema.verifyShape(model);
        if (advisories.length > 0)
            await logger.logWarning(`Read model shape advisories for table '${schema.table}': ${advisories.map(t => t.message).join(" | ")}`);
    }
}
//# sourceMappingURL=read-model-shape-guard.js.map