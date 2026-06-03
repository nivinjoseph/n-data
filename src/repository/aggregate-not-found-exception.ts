import { given } from "@nivinjoseph/n-defensive";
import { AggregateRoot } from "@nivinjoseph/n-domain";
import { ApplicationException } from "@nivinjoseph/n-exception";
import { ClassHierarchy } from "@nivinjoseph/n-util";

export class AggregateNotFoundException extends ApplicationException
{
    public constructor(aggregateType: ClassHierarchy<AggregateRoot<any, any>>, queryValue: string, queryKey = "id")
    {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        given(queryValue, "queryValue").ensureHasValue().ensureIsString();
        given(queryKey, "queryKey").ensureHasValue().ensureIsString();

        super(`${aggregateType.getTypeName()} with ${queryKey} '${queryValue}' was not found.`);
    }
}