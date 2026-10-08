import { given } from "@nivinjoseph/n-defensive";
import { serialize } from "@nivinjoseph/n-util";
import { ReadModel, ReadModelData } from "../../../src/index.js";
import { IdPrefix } from "../../common/id-prefix.js";
import { Creator } from "../creator.js";

/**
 * A creator as the platform sees them: flat, one row per creator, **across every studio**.
 *
 * This is the read the org-scoped `CreatorRepository` cannot serve with an index. Its every btree
 * leads with `organization_id`, so a question that spans studios - who has this skill anywhere, how
 * many leads are there on the platform - either goes through the one flagged path or sequential-scans.
 * A read model is cross-organization by design: `studioId` is a column here like any other, indexed
 * like any other, and a per-studio question and a platform-wide one are the same kind of query.
 *
 * It is a projection, built by {@link fromCreator} from the aggregate, and the application decides
 * when to write it. Nothing here is a source of truth - the event stream is - which is why a stale
 * row is a re-projection away rather than a data migration.
 *
 * `skillCount` is the `StudioPlan.featureCount` lesson again: a GIN index over `skills` answers
 * membership and nothing about length, so the count is a column of its own - listed in `TDataKeys`
 * so it can be declared, and derived at the `super()` call so no caller passes a number it cannot
 * get wrong. On hydration the stored count is recomputed from the stored skills, not trusted.
 *
 * @class CreatorActivity
 */
@serialize
export class CreatorActivity extends ReadModel<CreatorActivity,
    "studioId" | "email" | "displayName" | "role" | "joinedAt" | "isDeactivated" | "skills" | "skillCount">
{
    private readonly _studioId: string;
    private readonly _email: string;
    private readonly _displayName: string;
    private readonly _role: string;
    private readonly _joinedAt: number;
    private readonly _isDeactivated: boolean;
    private readonly _skills: ReadonlyArray<string>;
    private readonly _skillCount: number;

    /**
     * The studio the creator belongs to - the `organizationId` of the aggregate, as a plain column.
     */
    @serialize public get studioId(): string { return this._studioId; }
    @serialize public get email(): string { return this._email; }
    @serialize public get displayName(): string { return this._displayName; }
    @serialize public get role(): string { return this._role; }
    /**
     * Epoch milliseconds on the object; a real `timestamptz` in the table.
     */
    @serialize public get joinedAt(): number { return this._joinedAt; }
    @serialize public get isDeactivated(): boolean { return this._isDeactivated; }
    @serialize public get skills(): ReadonlyArray<string> { return this._skills; }
    @serialize public get skillCount(): number { return this._skillCount; }

    public constructor(data: Omit<ReadModelData<CreatorActivity>, "skillCount">)
    {
        given(data, "data").ensureHasValue().ensureIsObject();
        // guarded before the derivation below reads it: a row older than the column hydrates with NULL
        // here, and the failure has to name the property rather than be a TypeError on `.length`
        given(data.skills, "skills").ensureHasValue().ensureIsArray();

        // derived here, never accepted: listing the key makes it required input, and a count the caller
        // supplies is a count the caller can get wrong
        super({ ...data, skillCount: data.skills.length });

        const { id, studioId, email, displayName, role, joinedAt, isDeactivated, skills } = data;

        given(id, "id").ensureHasValue().ensureIsString().ensure(t => t.startsWith(IdPrefix.creator));
        given(studioId, "studioId").ensureHasValue().ensureIsString().ensure(t => t.startsWith(IdPrefix.studio));
        this._studioId = studioId;

        given(email, "email").ensureHasValue().ensureIsString();
        this._email = email;

        given(displayName, "displayName").ensureHasValue().ensureIsString();
        this._displayName = displayName;

        given(role, "role").ensureHasValue().ensureIsString();
        this._role = role;

        given(joinedAt, "joinedAt").ensureHasValue().ensureIsNumber();
        this._joinedAt = joinedAt;

        given(isDeactivated, "isDeactivated").ensureHasValue().ensureIsBoolean();
        this._isDeactivated = isDeactivated;

        this._skills = [...skills];
        this._skillCount = skills.length;
    }


    /**
     * The projection of one creator, under the creator's own id so a re-projection replaces the row.
     */
    public static fromCreator(creator: Creator): CreatorActivity
    {
        given(creator, "creator").ensureHasValue().ensureIsObject().ensureIsType(Creator);

        return new CreatorActivity({
            id: creator.id,
            studioId: creator.organizationId,
            email: creator.email,
            displayName: creator.displayName,
            role: creator.role,
            joinedAt: creator.joinedAt,
            isDeactivated: creator.isDeactivated,
            skills: creator.skills
        });
    }
}
