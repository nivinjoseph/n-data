import { given } from "@nivinjoseph/n-defensive";
import { ApplicationException } from "@nivinjoseph/n-exception";
export class AggregateNotFoundException extends ApplicationException {
    constructor(aggregateType, queryValue, queryKey = "id") {
        given(aggregateType, "aggregateType").ensureHasValue().ensureIsFunction();
        given(queryValue, "queryValue").ensureHasValue().ensureIsString();
        given(queryKey, "queryKey").ensureHasValue().ensureIsString();
        super(`${aggregateType.getTypeName()} with ${queryKey} '${queryValue}' was not found.`);
    }
}
//# sourceMappingURL=aggregate-not-found-exception.js.map