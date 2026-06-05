import { AggregateRoot, AggregateState, DomainEvent, OrgAggregateRoot, OrgAggregateState, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { ClassDefinition } from "@nivinjoseph/n-util";
export type AggregateRootClass = ClassDefinition<AggregateRoot<AggregateState, DomainEvent<AggregateState>>>;
export type OrgAggregateRootClass = ClassDefinition<OrgAggregateRoot<OrgAggregateState, OrgDomainEvent<OrgAggregateState>>>;
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