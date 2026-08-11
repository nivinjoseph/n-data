import { given } from "@nivinjoseph/n-defensive";
import { serialize } from "@nivinjoseph/n-util";
import { StudioState } from "../studio-state.js";
import { StudioEvent, StudioEventData } from "./studio-event.js";

/**
 * The studio's display name and slug changed.
 *
 * Both travel in one event because they change together: the slug is derived from the name at the point
 * of renaming, and splitting them would allow a stream where a studio briefly carries a slug that does
 * not correspond to its name.
 *
 * @class StudioRenamed
 */
@serialize
export class StudioRenamed extends StudioEvent
{
    private readonly _studioName: string;
    private readonly _slug: string;

    @serialize
    public get studioName(): string { return this._studioName; }

    @serialize
    public get slug(): string { return this._slug; }

    public constructor(data: StudioEventData & Pick<StudioRenamed, "studioName" | "slug">)
    {
        super(data);

        const { studioName, slug } = data;

        given(studioName, "studioName").ensureHasValue().ensureIsString();
        this._studioName = studioName;

        given(slug, "slug").ensureHasValue().ensureIsString();
        this._slug = slug;
    }

    protected override applyEvent(state: StudioState): void
    {
        given(state, "state").ensureHasValue().ensureIsObject();

        state.name = this._studioName;
        state.slug = this._slug;
    }
}
