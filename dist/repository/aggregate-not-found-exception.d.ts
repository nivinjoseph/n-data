import { AggregateRoot } from "@nivinjoseph/n-domain";
import { ApplicationException } from "@nivinjoseph/n-exception";
import { ClassHierarchy } from "@nivinjoseph/n-util";
export declare class AggregateNotFoundException extends ApplicationException {
    constructor(aggregateType: ClassHierarchy<AggregateRoot<any, any>>, queryValue: string, queryKey?: string);
}
//# sourceMappingURL=aggregate-not-found-exception.d.ts.map