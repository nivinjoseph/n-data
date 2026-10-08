import { ApplicationException } from "@nivinjoseph/n-exception";
import { ReadModelClass } from "./read-model.js";
/**
 * What `ReadModelBaseRepository.get` raises on a miss - its own type, since a read model is not an
 * aggregate and `AggregateNotFoundException` is typed over one.
 */
export declare class ReadModelNotFoundException extends ApplicationException {
    constructor(modelType: ReadModelClass, id: string);
}
//# sourceMappingURL=read-model-not-found-exception.d.ts.map