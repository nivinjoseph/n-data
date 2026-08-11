import { given } from "@nivinjoseph/n-defensive";
import { ExampleException } from "../../common/example-exception.js";

/**
 * The email is already used by another creator **in this studio**.
 *
 * The message deliberately does not name the studio: whether the address exists elsewhere is not this
 * tenant's business, and saying so would leak across the boundary.
 *
 * @class CreatorEmailUnavailableException
 */
export class CreatorEmailUnavailableException extends ExampleException
{
    public constructor(email: string)
    {
        given(email, "email").ensureHasValue().ensureIsString();

        super("creatorEmailUnavailable", `Creator with email '${email}' already exists in this studio.`);
    }
}
