import { given } from "@nivinjoseph/n-defensive";
import { ApplicationException } from "@nivinjoseph/n-exception";
/**
 * What `ReadModelBaseRepository.get` raises on a miss - its own type, since a read model is not an
 * aggregate and `AggregateNotFoundException` is typed over one.
 */
export class ReadModelNotFoundException extends ApplicationException {
    constructor(modelType, id) {
        given(modelType, "modelType").ensureHasValue().ensureIsFunction();
        given(id, "id").ensureHasValue().ensureIsString();
        super(`${modelType.getTypeName()} with id '${id}' was not found.`);
    }
}
//# sourceMappingURL=read-model-not-found-exception.js.map