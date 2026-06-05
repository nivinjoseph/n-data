import { given } from "@nivinjoseph/n-defensive";
import { AggregateRoot, AggregateState, DomainEvent, DomainHelper, OrgAggregateRoot, OrgAggregateState, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { ClassDefinition } from "@nivinjoseph/n-util";

export type AggregateRootClass = ClassDefinition<AggregateRoot<AggregateState, DomainEvent<AggregateState>>>;
export type OrgAggregateRootClass = ClassDefinition<OrgAggregateRoot<OrgAggregateState, OrgDomainEvent<OrgAggregateState>>>;

export class DataHelper
{
    /**
     * @static
     */
    private constructor() { }


    public static createEventStreamTableName(aggregateType: AggregateRootClass): string
    {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();

        const tableName = DomainHelper.aggregateTypeToSnakeCase(aggregateType) + "_events";

        return tableName;
    }

    public static createSnapshotTableName(aggregateType: AggregateRootClass): string
    {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();

        const tableName = DomainHelper.aggregateTypeToSnakeCase(aggregateType) + "_snaps";

        return tableName;
    }

    public static createReadModelTableName(aggregateType: AggregateRootClass, prefix?: string): string
    {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        given(prefix, "prefix").ensureIsString();
        prefix = prefix?.trim().toLowerCase();

        const tableName = DomainHelper.aggregateTypeToSnakeCase(aggregateType)
            + `${prefix ? "_" + prefix : ""}` + "_read_model";

        return tableName;
    }
}