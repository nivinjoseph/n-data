import type { AggregateRoot, AggregateState, DomainEvent, SerializedValue } from "@nivinjoseph/n-domain";

/**
 * What `AggregateRoot.snapshot()` actually returns - the shape the snapshot repositories store in
 * the `data` jsonb column - stated as a type.
 *
 * `AggregateStateHelper.serializeStateIntoSnapshot` copies the state with `Object.assign`, so the
 * document's keys are the state's own keys and there is **no top-level `$typename`**. Each value is
 * then what `_serializeForSnapshot` emits, which is exactly n-domain's {@link SerializedValue}: a
 * `DomainObject` member becomes its serialized record (`$typename` included), a `Date` an ISO
 * string, arrays element-wise, plain objects JSON-cloned, and a `Map`/`Set`/`Promise` member
 * `never` - such a member stores as `{}`/nothing useful, and the path machinery fails closed on it
 * everywhere, so the document type is truthfully unbuildable rather than quietly wrong.
 *
 * One runtime door this type cannot see: `snapshot(...cloneKeys)` JSON-clones the named keys
 * instead of serializing them. The repositories never pass `cloneKeys`, and this type assumes none.
 */
export type SnapshotDocumentOf<TState> = {
    [K in keyof TState]: SerializedValue<TState[K]>;
};

/**
 * The write-side boundary, centralized: `snapshot()` is typed `TState | object` upstream, and this
 * is the one place that union is asserted into the document shape. Also the test-side door -
 * `querySet.verifyDocument(toSnapshotDocument(aggregate))` needs no cast at all.
 *
 * @param {AggregateRoot} aggregate - The aggregate to snapshot.
 * @returns {SnapshotDocumentOf} The snapshot document, typed as what is actually stored.
 */
export function toSnapshotDocument<TState extends AggregateState, TDomainEvent extends DomainEvent<TState>>(
    aggregate: AggregateRoot<TState, TDomainEvent>): SnapshotDocumentOf<TState>
{
    return aggregate.snapshot() as SnapshotDocumentOf<TState>;
}

/**
 * The read-side boundary, centralized and deliberate: `deserializeFromSnapshot` declares its
 * `stateSnapshot` parameter as the LIVE state type even though at runtime it takes the serialized
 * document (it revives through `stateFactory.deserializeSnapshot`). Until upstream types that
 * parameter as the document, this is where the two shapes meet - documented once, used by the two
 * snapshot repositories, nowhere else. Deliberately absent from the barrel.
 *
 * @param {SnapshotDocumentOf} document - The stored snapshot document.
 * @returns {TState} The same object, asserted to the shape `deserializeFromSnapshot` declares.
 */
export function snapshotDocumentToState<TState>(document: SnapshotDocumentOf<TState>): TState
{
    return document as unknown as TState;
}
