import { AggregateRoot, AggregateState, DomainEvent, OrgAggregateRoot, OrgAggregateState, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { ClassDefinition } from "@nivinjoseph/n-util";
import { ReadModelClass } from "../read-model/read-model.js";
export type AggregateRootClass = ClassDefinition<AggregateRoot<AggregateState, DomainEvent<AggregateState>>>;
export type OrgAggregateRootClass = ClassDefinition<OrgAggregateRoot<OrgAggregateState, OrgDomainEvent<OrgAggregateState>>>;
/**
 * An aggregate class with its state shape left open, so callers can have it inferred and have
 * anything typed against that state - such as snapshot index paths - checked against the real shape.
 */
export type AggregateRootClassOf<TState extends AggregateState> = ClassDefinition<AggregateRoot<TState, any>>;
/**
 * The organization-scoped counterpart to {@link AggregateRootClassOf}.
 */
export type OrgAggregateRootClassOf<TState extends OrgAggregateState> = ClassDefinition<OrgAggregateRoot<TState, any>>;
export declare class DataHelper {
    /**
     * @static
     */
    private constructor();
    static createEventStreamTableName(aggregateType: AggregateRootClass): string;
    static createSnapshotTableName(aggregateType: AggregateRootClass): string;
    /**
     * The table a read model class is stored in: the class name in snake_case and the `_read_model`
     * suffix - `OrderSummary` is `order_summary_read_model`. The suffix keeps the name clear of the
     * `_events`/`_snaps` tables and of every reserved word. One class, one table: there is no prefix,
     * because `ReadModelSchema` derives the table from the class alone.
     *
     * @param {ReadModelClass} modelType - The read model class.
     * @returns {string} The table name.
     * @throws {ArgumentNullException} If modelType is null or undefined.
     * @throws {ArgumentException} If modelType is not a function.
     */
    static createReadModelTableName(modelType: ReadModelClass): string;
}
//# sourceMappingURL=data-helper.d.ts.map