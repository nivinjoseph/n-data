import { DomainEntity } from "@nivinjoseph/n-domain";
/**
 * A flat, identified projection: an `id` and, for every other data key, a scalar or an array of
 * scalars - stored one row per instance in a table with one real typed column per key, so that any
 * SQL can run against it.
 *
 * It adds nothing at runtime to `DomainEntity`. The brand below is what makes `ReadModelSchema.for`
 * accept only this family, so a plain `DomainEntity` handed to it fails with an error that names the
 * fix rather than with a structural mismatch somewhere inside the declaration types.
 *
 * Same self-referential idiom as `DomainEntity`: pass the class itself as `TThis` and its
 * `@serialize` decorated getter names (excluding `id`) as `TDataKeys`. Decorate the class and every
 * data getter with `@serialize`, and give it a **public** constructor taking
 * {@link ReadModelData}: the repository hydrates rows through it, and `ClassDefinition` - the type
 * `ReadModelSchema.for` takes the class at - admits no protected one. A derived value that must be a
 * column is listed in `TDataKeys` and derived at the `super()` call; one that is merely recomputed
 * stays an undecorated getter.
 *
 * Flatness is enforced where it fires - on the schema declaration - rather than on this class: a
 * key whose type is not a scalar, a nullable scalar, or an array of scalars cannot be declared as a
 * column, so no repository can be built over a model that is not flat.
 *
 * @example
 * ```typescript
 * @serialize
 * export class OrderSummary extends ReadModel<OrderSummary, "customerId" | "total" | "placedAt" | "tags">
 * {
 *     @serialize public get customerId(): string { return this._customerId; }
 *     @serialize public get total(): number { return this._total; }
 *     @serialize public get placedAt(): number { return this._placedAt; }   // epoch ms
 *     @serialize public get tags(): ReadonlyArray<string> { return this._tags; }
 *
 *     public constructor(data: ReadModelData<OrderSummary>)
 *     {
 *         super(data);
 *         given(data.customerId, "customerId").ensureHasValue().ensureIsString();
 *         this._customerId = data.customerId;
 *         // ...
 *     }
 * }
 * ```
 *
 * @template TThis - The concrete subclass itself.
 * @template TDataKeys - The union of the subclass's `@serialize` decorated getter names, excluding `id`.
 */
export class ReadModel extends DomainEntity {
}
//# sourceMappingURL=read-model.js.map