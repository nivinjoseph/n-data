import { given } from "@nivinjoseph/n-defensive";
/**
 * The two facts n-util's `@serialize` records about a class, read the way n-domain reads them: off
 * `Symbol.metadata` on the constructor, under the registry keys n-util publishes. Internal.
 *
 * - The registered type name (`"Prefix.ClassName"` or `"ClassName"`) is what `serialize()` stamps as
 *   `$typename` and what a hydration stamps back, so the class's constructor treats the row as the
 *   stored artifact it is.
 * - The decorated fields are what `serialize()` walks; comparing them with a schema's declared keys is
 *   how the shape advisories are found without serializing anything.
 */
// n-util polyfills Symbol.metadata at module load; read it through `unknown` so the lookup is typed
const symbolMetadata = Symbol.metadata;
const fieldsKey = Symbol.for("@nivinjoseph/n-util/serializable/fields");
function metadataOf(type) {
    const metadata = type[symbolMetadata];
    return typeof metadata === "object" && metadata !== null ? metadata : null;
}
/**
 * The type name `@serialize` registered for the class, or null when the class carries no class-level
 * decorator - in which case `serialize()` would fail on it too.
 */
export function registeredTypeNameOf(type) {
    given(type, "type").ensureHasValue().ensureIsFunction();
    const info = metadataOf(type)?.[Symbol.for(`@nivinjoseph/n-util/serializable/${type.name}/info`)];
    const typeName = typeof info === "object" && info !== null ? info.typeName : undefined;
    return typeof typeName === "string" ? typeName : null;
}
/**
 * The getters `@serialize` recorded for the class, inherited ones included - the same list
 * n-domain's constructor checks fresh data against.
 */
export function decoratedFieldsOf(type) {
    given(type, "type").ensureHasValue().ensureIsFunction();
    const fields = metadataOf(type)?.[fieldsKey];
    if (!Array.isArray(fields))
        return [];
    return fields
        .filter((t) => typeof t === "object" && t !== null && typeof t.name === "string")
        .map(t => typeof t.key === "string" ? { name: t.name, key: t.key } : { name: t.name });
}
//# sourceMappingURL=serializable-metadata.js.map