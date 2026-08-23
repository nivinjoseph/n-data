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
 * ## The two kinds of derived getter
 *
 * This class carries one of each, and the difference is a storage decision rather than a domain one.
 *
 * `featureCount` is **materialized**: `@serialize`d, so it lands in the jsonb, so it can be indexed
 * and compared as a number. That buys the one question containment cannot ask - `plan.features` is a
 * GIN array index, which answers "does it hold '4k-export'" and nothing about *how many* - so
 * `gt("plan.featureCount", 1)` exists precisely because `contains` has no way to count.
 *
 * `isUnlimited` is **recomputed-only**: undecorated, absent from storage, re-derived on every read,
 * and therefore not queryable at all. That is the trade. A recomputed value is always current, so the
 * rule behind it can change without rewriting history; a materialized one is a fact about the moment
 * it was written.
 *
 * A materialized derived value must be listed in `TDataKeys`, and leaving it out fails **silently**.
 * The runtime serializer walks `@serialize` decorators, so a decorated getter is stored whether or
 * not the type mentions it - but the path types walk `DomainObjectSerialized`, which maps over
 * `TDataKeys` alone. So a decorated getter left out of that union is written to every row and yet
 * `withPath("plan.featureCount")` is a compile error, and `verifyDocument` cannot catch it either: it
 * checks that declared paths resolve, never that stored keys are declared. Stored, unqueryable, and
 * nothing fails. Note this is the *inverse* of the case the design guards - an **un**decorated getter
 * is absent from storage and rejected as a path, which is the pairing that holds.
 *
 * Two costs come with materializing, and neither has a fix in this class. Rows written before this
 * getter existed carry no `plan.featureCount`, so the index reads null for them until each aggregate
 * is saved again. And a row written under an older rule holds whatever that rule produced - the
 * object reconstructed from it recomputes and is correct, while the index still holds the old number,
 * so the two can disagree until a re-save.
 *
 * Both are paid the same way, in a migration: load each aggregate and save it back. An aggregate
 * loaded and not touched is neither new nor changed, so an ordinary save would return having done
 * nothing - which is why the snapshot repositories' `save` and `saveWithin` take `force`. It rewrites
 * `data` from the current code and touches nothing else; the event stream keeps its own change check,
 * so no events are appended and no history is republished.
 *
 * @class StudioPlan
 */
@serialize
export class StudioPlan extends DomainObject<StudioPlan, "tier" | "seatLimit" | "features" | "featureCount">
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
     * Derived, and deliberately **serialized** - the count is stored so it can be indexed and
     * compared as a number, which is the one question the GIN index over `features` cannot answer.
     * Recomputed on every construction, so a stale value in a row cannot reach the object.
     */
    @serialize
    public get featureCount(): number { return this._features.length; }

    /**
     * Derived, and deliberately **not** serialized - it is recomputed on every read, so the rule behind
     * it can change without rewriting history.
     */
    public get isUnlimited(): boolean { return this._seatLimit === 0; }

    /**
     * Takes every data key **except** the materialized one. `Schema<T, K>` makes each key in
     * `TDataKeys` required, so accepting `DomainObjectData<StudioPlan>` whole would oblige every
     * caller to pass a `featureCount` this constructor ignores and that could disagree with
     * `features`. Deriving it at the `super()` call keeps the input honest without giving up a
     * single compile-time check - and the base is content, since it rejects only data keys that are
     * *not* `@serialize` decorated getters, never ones that are merely absent.
     *
     * The `Deserializer` path arrives here too, with the stored `featureCount` and a `$typename`
     * alongside it. The spread recomputes over the former and preserves the latter, so a row written
     * under an older rule yields a correct object - see the note on staleness in the class doc.
     */
    public constructor(data: Omit<DomainObjectData<StudioPlan>, "featureCount">)
    {
        super({ ...data, featureCount: data.features.length });

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
