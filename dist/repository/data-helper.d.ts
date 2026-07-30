import { AggregateRoot, AggregateState, DomainEvent, OrgAggregateRoot, OrgAggregateState, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { ClassDefinition } from "@nivinjoseph/n-util";
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
    static createReadModelTableName(aggregateType: AggregateRootClass, prefix?: string): string;
}
//# sourceMappingURL=data-helper.d.ts.map