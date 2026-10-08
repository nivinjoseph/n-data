/**
 * Any class, abstract or not - what the metadata hangs off. Spelled as a construct signature because
 * the bare `Function` type is banned in this codebase.
 */
type ClassLike = abstract new (...args: Array<any>) => object;
/**
 * One `@serialize`d getter: its name, and the key it serializes under when renamed.
 */
export interface DecoratedField {
    readonly name: string;
    readonly key?: string;
}
/**
 * The type name `@serialize` registered for the class, or null when the class carries no class-level
 * decorator - in which case `serialize()` would fail on it too.
 */
export declare function registeredTypeNameOf(type: ClassLike): string | null;
/**
 * The getters `@serialize` recorded for the class, inherited ones included - the same list
 * n-domain's constructor checks fresh data against.
 */
export declare function decoratedFieldsOf(type: ClassLike): ReadonlyArray<DecoratedField>;
export {};
//# sourceMappingURL=serializable-metadata.d.ts.map