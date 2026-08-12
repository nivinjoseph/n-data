import { given } from "@nivinjoseph/n-defensive";
import { ExampleException } from "../../common/example-exception.js";

/**
 * The slug is already taken by another studio.
 *
 * @class StudioSlugUnavailableException
 */
export class StudioSlugUnavailableException extends ExampleException
{
    public constructor(slug: string)
    {
        given(slug, "slug").ensureHasValue().ensureIsString();

        super("studioSlugUnavailable", `Studio with slug '${slug}' already exists.`);
    }
}
