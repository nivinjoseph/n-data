import { AggregateRoot, AggregateState, DomainEvent } from "@nivinjoseph/n-domain";
import { ClassDefinition } from "@nivinjoseph/n-util";
export declare class DataHelper {
    /**
     * @static
     */
    private constructor();
    static createEventStreamTableName<T extends AggregateRoot<TState, TDomainEvent>, TState extends AggregateState, TDomainEvent extends DomainEvent<TState>>(aggregateType: ClassDefinition<T>): string;
    static createSnapshotTableName<T extends AggregateRoot<TState, TDomainEvent>, TState extends AggregateState, TDomainEvent extends DomainEvent<TState>>(aggregateType: ClassDefinition<T>): string;
    static createReadModelTableName<T extends AggregateRoot<TState, TDomainEvent>, TState extends AggregateState, TDomainEvent extends DomainEvent<TState>>(aggregateType: ClassDefinition<T>, prefix?: string): string;
}
//# sourceMappingURL=data-helper.d.ts.map