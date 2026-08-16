/**
 * The write-side boundary, centralized: `snapshot()` is typed `TState | object` upstream, and this
 * is the one place that union is asserted into the document shape. Also the test-side door -
 * `querySet.verifyDocument(toSnapshotDocument(aggregate))` needs no cast at all.
 *
 * @param {AggregateRoot} aggregate - The aggregate to snapshot.
 * @returns {SnapshotDocumentOf} The snapshot document, typed as what is actually stored.
 */
export function toSnapshotDocument(aggregate) {
    return aggregate.snapshot();
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
export function snapshotDocumentToState(document) {
    return document;
}
//# sourceMappingURL=snapshot-document.js.map