import { given } from "@nivinjoseph/n-defensive";
import { OrgAggregateRoot } from "@nivinjoseph/n-domain";
import { serialize } from "@nivinjoseph/n-util";
import { CreatorState } from "./creator-state.js";
import { CreatorDeactivated } from "./events/creator-deactivated.js";
import { CreatorEvent } from "./events/creator-event.js";
import { CreatorProfileUpdated } from "./events/creator-profile-updated.js";
import { CreatorRoleChanged } from "./events/creator-role-changed.js";
import { CreatorSkillAdded } from "./events/creator-skill-added.js";

/**
 * Someone who works within a studio.
 *
 * `OrgAggregateRoot` adds one member - `organizationId`, read from state - and one guard: its `applyEvent`
 * insists every event is an `OrgDomainEvent`. The organization is never set by an event; it is stamped into
 * default state by `CreatorStateFactory` from the domain context, and each event's `apply` cross-checks its
 * own copy against it.
 *
 * As on the studio side there is no constructor, and the getters carry no `@serialize` - the class-level one
 * is what registers the type.
 *
 * @class Creator
 */
@serialize
export class Creator extends OrgAggregateRoot<CreatorState, CreatorEvent>
{
    public static get roles(): ReadonlyArray<string> { return ["member", "lead", "admin"]; }

    public get email(): string { return this.state.email; }
    public get displayName(): string { return this.state.displayName; }
    public get role(): string { return this.state.role; }
    public get joinedAt(): number { return this.state.joinedAt; }
    public get isDeactivated(): boolean { return this.state.isDeactivated; }
    public get skills(): ReadonlyArray<string> { return [...this.state.skills]; }

    /**
     * Normalizes an email into the form the natural key is stored in.
     *
     * Lower-cased because the unique index compares the extracted text exactly as stored, so without this
     * `A@x.com` and `a@x.com` would be two rows the constraint happily admits.
     */
    public static toEmail(email: string): string
    {
        given(email, "email").ensureHasValue().ensureIsString();

        return email.trim().toLowerCase();
    }

    public updateProfile(displayName: string): void
    {
        given(displayName, "displayName").ensureHasValue().ensureIsString()
            .ensure(t => t.trim().length <= 128, "must not be longer than 128");
        given(this, "this").ensure(t => !t.isDeactivated, "must not be deactivated");

        const normalizedDisplayName = displayName.trim();

        if (normalizedDisplayName === this.state.displayName)
            return;

        this.applyEvent(new CreatorProfileUpdated({ displayName: normalizedDisplayName }));
    }

    public changeRole(role: string): void
    {
        given(role, "role").ensureHasValue().ensureIsString()
            .ensure(t => Creator.roles.contains(t), `must be one of ${Creator.roles.join(", ")}`);
        given(this, "this").ensure(t => !t.isDeactivated, "must not be deactivated");

        if (role === this.state.role)
            return;

        this.applyEvent(new CreatorRoleChanged({ role }));
    }

    public addSkill(skill: string): void
    {
        given(skill, "skill").ensureHasValue().ensureIsString();
        given(this, "this").ensure(t => !t.isDeactivated, "must not be deactivated");

        const normalizedSkill = skill.trim().toLowerCase();

        given(normalizedSkill, "skill").ensure(t => t.isNotEmptyOrWhiteSpace(), "must not be whitespace");

        if (this.state.skills.contains(normalizedSkill))
            return;

        this.applyEvent(new CreatorSkillAdded({ skill: normalizedSkill }));
    }

    public deactivate(): void
    {
        given(this, "this").ensure(t => !t.isDeactivated, "must not be deactivated");

        this.applyEvent(new CreatorDeactivated({}));
    }
}
