import { given } from "@nivinjoseph/n-defensive";
import { AggregateRoot, AggregateState, DomainEvent, DomainHelper } from "@nivinjoseph/n-domain";
import { ClassDefinition } from "@nivinjoseph/n-util";

export class DataHelper
{
    /**
     * @static
     */
    private constructor() { }


    public static createEventStreamTableName<T extends AggregateRoot<TState, TDomainEvent>, TState extends AggregateState, TDomainEvent extends DomainEvent<TState>>(
        aggregateType: ClassDefinition<T>): string
    {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();

        const tableName = DomainHelper.aggregateTypeToSnakeCase(aggregateType) + "_events";

        return tableName;
    }

    public static createSnapshotTableName<T extends AggregateRoot<TState, TDomainEvent>, TState extends AggregateState, TDomainEvent extends DomainEvent<TState>>(
        aggregateType: ClassDefinition<T>): string
    {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();

        const tableName = DomainHelper.aggregateTypeToSnakeCase(aggregateType) + "_snaps";

        return tableName;
    }

    public static createReadModelTableName<T extends AggregateRoot<TState, TDomainEvent>, TState extends AggregateState, TDomainEvent extends DomainEvent<TState>>(
        aggregateType: ClassDefinition<T>, prefix?: string): string
    {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        given(prefix, "prefix").ensureIsString();
        prefix = prefix?.trim().toLowerCase();

        const tableName = DomainHelper.aggregateTypeToSnakeCase(aggregateType)
            + `${prefix ? "_" + prefix : ""}` + "_read_model";

        return tableName;
    }
}