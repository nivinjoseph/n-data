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
export class ReadModelShapeGuard {
    static _advised = new WeakSet();
    /**
     * Static class.
     */
    constructor() { }
    /**
     * Logs the schema's shape advisories once per process, reading them off `model`.
     */
    static async adviseOnce(schema, model, logger) {
        if (ReadModelShapeGuard._advised.has(schema))
            return;
        // marked before the pass, so a schema is looked at exactly once however it goes
        ReadModelShapeGuard._advised.add(schema);
        const advisories = schema.verifyShape(model);
        if (advisories.length > 0)
            await logger.logWarning(`Read model shape advisories for table '${schema.table}': ${advisories.map(t => t.message).join(" | ")}`);
    }
}
//# sourceMappingURL=read-model-shape-guard.js.map