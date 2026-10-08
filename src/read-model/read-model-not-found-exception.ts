import { given } from "@nivinjoseph/n-defensive";
import { ApplicationException } from "@nivinjoseph/n-exception";
import { ReadModelClass } from "./read-model.js";

/**
 * What `ReadModelBaseRepository.get` raises on a miss - its own type, since a read model is not an
 * aggregate and `AggregateNotFoundException` is typed over one.
 */
export class ReadModelNotFoundException extends ApplicationException
{
    public constructor(modelType: ReadModelClass, id: string)
    {
        given(modelType, "modelType").ensureHasValue().ensureIsFunction();
        given(id, "id").ensureHasValue().ensureIsString();

        super(`${modelType.getTypeName()} with id '${id}' was not found.`);
    }
}
