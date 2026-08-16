import { given } from "@nivinjoseph/n-defensive";
import { DomainObject, DomainObjectData } from "@nivinjoseph/n-domain";
import { serialize } from "@nivinjoseph/n-util";

/**
 * The tier a studio is on, and the seats it buys.
 *
 * A value object rather than a plain object for a reason that bites at the storage layer:
 * `AggregateStateHelper` refuses to snapshot a plain object carrying `_`-prefixed keys, and it
 * serializes a `Serializable` through `serialize()`. So a structured state field either extends
 * `DomainObject` or it is a bare JSON literal - there is no middle ground where private fields survive.
 *
 * The `@serialize` getters are also what make the nested paths indexable: only decorated getters reach
 * `data`, so `plan.tier` and `plan.seatLimit` exist as jsonb keys precisely because they are declared
 * here. An undecorated getter is absent from storage - and, because the path types follow the
 * serialized shape (n-domain 4.0.2's `DomainObjectSerialized`, offered only for real `DomainObject`
 * members), it is not offered as a path either: `withPath("plan.isUnlimited")` is a compile error
 * rather than an always-null index.
 *
 * `features` is an array data key, and it needs **n-domain >= 4.0.3**. In 4.0.2 a scalar array on a
 * `DomainObject` was poisoned to `never` by `IllegalDataKeys`, so a class declaring one could not be
 * constructed - which is why no value object here carried an array until now. The path types were
 * never affected: `SerializedValue` turned it into `Array<string>` all along. So `plan.features` is a
 * nested **array** path - `withArrayPath("plan.features")`, indexed with GIN and read with
 * `contains` - and *not* a scalar one, because a container is never a leaf.
 *
 * @class StudioPlan
 */
@serialize
export class StudioPlan extends DomainObject<StudioPlan, "tier" | "seatLimit" | "features">
{
    private readonly _tier: string;
    private readonly _seatLimit: number;
    private readonly _features: ReadonlyArray<string>;

    public static get tiers(): ReadonlyArray<string> { return ["free", "studio", "enterprise"]; }

    @serialize
    public get tier(): string { return this._tier; }

    @serialize
    public get seatLimit(): number { return this._seatLimit; }

    @serialize
    public get features(): ReadonlyArray<string> { return this._features; }

    /**
     * Derived, and deliberately **not** serialized - it is recomputed on every read, so the rule behind
     * it can change without rewriting history.
     */
    public get isUnlimited(): boolean { return this._seatLimit === 0; }

    public constructor(data: DomainObjectData<StudioPlan>)
    {
        super(data);

        const { tier, seatLimit, features } = data;

        given(tier, "tier").ensureHasValue().ensureIsString()
            .ensure(t => StudioPlan.tiers.contains(t), `must be one of ${StudioPlan.tiers.join(", ")}`);
        this._tier = tier;

        given(seatLimit, "seatLimit").ensureHasValue().ensureIsNumber()
            .ensure(t => Number.isInteger(t) && t >= 0, "must be a non-negative integer");
        this._seatLimit = seatLimit;

        given(features, "features").ensureHasValue().ensureIsArray()
            .ensure(t => t.every(u => typeof u === "string"), "must be strings");
        // copied, so the caller's array cannot mutate the value object out from under equality
        this._features = [...features];
    }

    public static createFree(): StudioPlan
    {
        return new StudioPlan({ tier: "free", seatLimit: 3, features: [] });
    }
}
