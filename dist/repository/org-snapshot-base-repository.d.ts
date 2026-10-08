import { OrgAggregateRoot, OrgAggregateState, OrgDomainContext, OrgDomainEvent } from "@nivinjoseph/n-domain";
import { Repository } from "./repository.js";
import { BaseRepository } from "./base-repository.js";
import { UnitOfWork } from "../unit-of-work/unit-of-work.js";
import { OrgEventStreamBaseRepository } from "./org-event-stream-base-repository.js";
import { RepositoryQuery } from "./repository-query.js";
import { QueryResult } from "../db/query-result.js";
import type { DeclaredSnapshotQuerySet, SnapshotPredicate } from "../migration/snapshot-query-set.js";
/**
 * The organization-scoped counterpart to `SnapshotBaseRepository`.
 *
 * The snapshot table holds `id` (the primary key), `organization_id`, and `data` (the
 * serialized state as jsonb). Publicly, {@link get} and {@link getByIds} cover lookup by id and
 * {@link getAll} takes every row this organization has. Any other read is a method the concrete
 * subclass names for itself, built over one of the `protected` doors: {@link query} for a condition
 * on a field inside `data`, {@link queryById} or {@link queryByIds} for one that also constrains the
 * id, {@link exists} and {@link count} for a yes-or-no or a number, and - for a read that genuinely
 * leaves the tenant boundary - {@link queryByIdAcrossOrganizations} and
 * {@link queryByIdsAcrossOrganizations} by id, {@link queryAcrossOrganizations} for a typed predicate
 * over paths declared `acrossOrganizations`, {@link existsAcrossOrganizations} and
 * {@link countAcrossOrganizations} for the same shapes as their scoped namesakes,
 * {@link queryStatementAcrossOrganizations} for a whole statement, {@link queryRawAcrossOrganizations}
 * for a projection.
 *
 * **Every one of those scopes itself to the current organization, so a subclass never writes that
 * filter.** `query` owns the statement - `select data from <table> where organization_id = ? and
 * (<your predicate>)` - so a subclass supplies only the predicate, and the filter lands ahead of it,
 * which is both the tenant isolation and the leading index column; the id-shaped pair goes through
 * `query`, so it inherits the same guarantee, and an id belonging to another organization reads
 * exactly as one that does not exist. There is no way to forget it.
 * The doors that leave the boundary are named for that consequence. {@link queryAcrossOrganizations}
 * takes a typed predicate, and its type admits only paths declared `{ acrossOrganizations: true }` on
 * the query set (and array paths): each such path also carries a prefix-free `_xorg` index, so the
 * read is an index lookup with the filter dropped - which a path without the flag cannot be, since
 * every other btree index here leads with `organization_id` and btree serves only a leading prefix
 * (the planner then scans the table, or the whole index). {@link queryByIdAcrossOrganizations} and
 * {@link queryByIdsAcrossOrganizations} are the id-shaped doors, cheap because `id` is the primary
 * key and carries no tenant prefix; {@link queryStatementAcrossOrganizations} runs a whole statement,
 * for what the built shape cannot express.
 *
 * As with the plain variant, what is queryable is declared with a `SnapshotQuerySet` exposed by
 * overriding {@link querySet} - one object that both the migration creates the
 * table from and the predicates are built by, so a queried index is necessarily a created one, and so
 * every path and value is checked against that declaration at compile time.
 *
 * ```typescript
 * const indexes = SnapshotQuerySet.for<InvoiceState>()
 *     .withPath("status", { acrossOrganizations: true })
 *     .withComposite(["series", "invoiceNumber"], { unique: true });
 *
 * await tableCreator.createSnapshotTableForOrgAggregate(Invoice, indexes);
 * // -> create index ... on invoice_snaps(organization_id, (data->>'status'));
 * //    create index ... idx_invoice_snaps_status_xorg on invoice_snaps((data->>'status'));
 * //    create unique index ... on invoice_snaps(organization_id, (data->>'series'), (data->>'invoiceNumber'));
 * ```
 *
 * `organizationId` is deliberately not an indexable path, even though the state declares it. It is a
 * real column here and it leads every index, so constraining the column both isolates the tenant and
 * uses the index; the copy inside `data` is not what any index covers, so both indexing and querying
 * that path are always wrong - which is why the set does not offer it, and why {@link query}
 * constrains the column for you.
 *
 * Because every index leads with `organization_id`, one declared `unique` is unique **within an
 * organization** rather than globally - the same natural key, or tuple of them, can exist once
 * per tenant, which is normally what a tenant-scoped natural key means. Rows whose `data` omits
 * an indexed key are unconstrained; for a composite that means a row missing any member never
 * collides. A collision raises out of {@link save} as a DbException and rolls the unit of work
 * back, rather than surfacing as a domain error.
 *
 * That leading column is also why no expression here is independently searchable: btree serves only a
 * leading prefix, so a predicate must constrain `organization_id` before any indexed expression can
 * be used - which the filter {@link query} adds already does. `info.createdIndexes` reports it as
 * `leadingColumn`.
 *
 * **An array index is the one exception.** A `SnapshotArrayIndex` builds a GIN index, which *cannot*
 * lead with `organization_id` - a multicolumn GIN over a varchar column needs the `btree_gin`
 * extension, which is not trusted on Postgres 12 and would demand superuser at migration time. So a
 * GIN declaration never satisfies the leading-column requirement on its own: a table whose only
 * indexes are array ones also gets the standalone `(organization_id)` index, for the planner to
 * BitmapAnd the GIN scan against, while one that also declares btree paths does not - each of those
 * already leads with `organization_id` and serves it as a leading prefix.
 * `info.createdIndexes[i].leadingColumn` is `undefined` for the GIN index either way - read it rather
 * than assuming. The organization filter is still applied regardless: tenant isolation is a
 * correctness rule independent of the plan.
 *
 * @example
 * ```typescript
 * @inject("InvoiceEventStreamRepository")
 * export class InvoiceRepository extends OrgSnapshotBaseRepository<Invoice, InvoiceState, InvoiceEvent>
 * {
 *     // declared once: the migration creates these, this class queries them, and the paths below are
 *     // checked against exactly this list
 *     public static readonly indexes = SnapshotQuerySet.for<InvoiceState>()
 *         .withPath("status", { acrossOrganizations: true })
 *         .withPath("issuedAt", { type: JsonValueType.bigint })
 *         .withArrayPath("labels");
 *
 *     protected override get querySet(): typeof InvoiceRepository.indexes { return InvoiceRepository.indexes; }
 *
 *     public constructor(eventStreamRepository: InvoiceEventStreamRepository)
 *     {
 *         super(eventStreamRepository);
 *     }
 *
 *     public getByStatus(status: string): Promise<Array<Invoice>>
 *     {
 *         // the predicate only - the organization filter is added ahead of it, for isolation and
 *         // because the index leads with it
 *         return this.query(this.querySet.eq("status", status));
 *     }
 *
 *     public getByLabel(label: string): Promise<Array<Invoice>>
 *     {
 *         return this.query(this.querySet.contains("labels", label));
 *     }
 *
 *     public getRecentByStatus(status: string): Promise<Array<Invoice>>
 *     {
 *         return this.query({
 *             where: this.querySet.eq("status", status),
 *             orderBy: this.querySet.orderBy("issuedAt", "desc"),
 *             limit: 20
 *         });
 *     }
 *
 *     public getOpen(id: string): Promise<Invoice | null>
 *     {
 *         // by id AND on a declared path - `query` cannot express this, because `id` is a column
 *         // beside `data` and no query set predicate can reach it. The organization filter still
 *         // leads, so an id in another organization reads as a miss, exactly as a missing one does
 *         // -> where organization_id = ? and (id in (?) and (((data->>'status') = ?)))
 *         return this.queryById(id, this.querySet.eq("status", "open"));
 *     }
 *
 *     public getByStatusAcrossOrganizations(status: string): Promise<Array<Invoice>>
 *     {
 *         // typed, and an index lookup with the organization filter dropped: `status` is declared
 *         // across organizations, so it has a prefix-free twin to walk. `issuedAt` is not, and a
 *         // predicate on it would be a compile error here; `labels` is an array path, always admitted
 *         // -> select data from invoice_snaps where (((data->>'status') = ?));
 *         return this.queryAcrossOrganizations(this.querySet.eq("status", status));
 *     }
 * }
 *
 * // in the migration - the same object
 * await tableCreator.createSnapshotTableForOrgAggregate(Invoice, InvoiceRepository.indexes);
 * ```
 *
 * @class OrgSnapshotBaseRepository
 */
export declare abstract class OrgSnapshotBaseRepository<T extends OrgAggregateRoot<TState, TDomainEvent>, TState extends OrgAggregateState, TDomainEvent extends OrgDomainEvent<TState>> extends BaseRepository implements Repository<T> {
    private readonly _eventStreamRepository;
    /**
     * The indexes this repository declares, and the typed predicates over them.
     *
     * **Abstract on purpose.** The declared return type is `DeclaredSnapshotQuerySet` - the declarations
     * only, with not one query method on it - because the base cannot know which paths a subclass
     * chooses. Implement it by returning the `SnapshotQuerySet` static, typed with `typeof`:
     *
     * ```typescript
     * public static readonly indexes = SnapshotQuerySet.for<InvoiceState>().withPath("status");
     *
     * protected override get querySet(): typeof InvoiceRepository.indexes { return InvoiceRepository.indexes; }
     * ```
     *
     * The two names in that line are deliberate, not an oversight to be tidied up. One object wears the
     * name of the job each side does with it: the migration reads the static to create the table's
     * *indexes*, and this getter is what the *queries* below are built from.
     *
     * The `typeof` is what carries the narrow type to the call sites, and the trap it guards against is
     * closed twice over: an override that copies THIS declared type gets an object that cannot build a
     * single predicate (no `eq`, no `contains` - the mistake announces itself at the first query, where
     * at the old widened type `eq` accepted *any* string as a path, including `organizationId`, which is
     * a column here and never queryable through `data`), and the widened spelling
     * `SnapshotQuerySet<TState, any, any>` is now itself a compile error whose message names the fix.
     *
     * `_save` reads this getter, to verify the declared paths against the first snapshot it stores.
     * Nothing should read it from a constructor: a subclass may back it with an instance field rather
     * than a static, and a subclass field initializer runs *after* `super()` - so a constructor-time
     * read would see `undefined`.
     */
    protected abstract get querySet(): DeclaredSnapshotQuerySet<TState>;
    /**
     * The `organization_id = ?` filter {@link query} prepends, as a predicate you can splice into a
     * statement of your own.
     *
     * The companion to {@link queryStatementAcrossOrganizations} and {@link queryRawAcrossOrganizations}:
     * those two leave the tenant boundary, and this is how a statement that only needed the *shape*
     * they allow - a CTE, a `distinct on`, a group-by - gets the filter back without re-deriving it.
     * Splice `sql` and spread `params` in the same order the fragments appear; positional binding is
     * unforgiving.
     *
     * It exposes nothing new - `domainContext.organizationId` is public - it just means the filter is
     * written once, here, rather than once per statement that needs it.
     *
     * @returns {SnapshotPredicate} The filter and the current organization's id. Branded `acrossOrganizations: false`, naturally - it is the tenant filter.
     */
    protected get organizationPredicate(): SnapshotPredicate<false>;
    get domainContext(): OrgDomainContext;
    get eventStreamRepository(): OrgEventStreamBaseRepository<T, TState, TDomainEvent>;
    /**
     * @param {OrgEventStreamBaseRepository} eventStreamRepository - The event stream this snapshot is materialized from; the source of the db, unit of work, logger and domain context.
     */
    protected constructor(eventStreamRepository: OrgEventStreamBaseRepository<T, TState, TDomainEvent>);
    /**
     * The aggregates with these ids, within the current organization.
     *
     * Ids that are blank once trimmed are dropped, and if that leaves none the result is empty -
     * asking for zero ids returns zero aggregates, which is unremarkable because the caller passed an
     * array. It was not always: as `getAll(...ids)` this shared a signature with {@link getAll}, so
     * the empty case had to stand for either everything or nothing and could not be read off the call.
     *
     * To load only the ids that also satisfy a condition, a subclass builds its own method over
     * {@link queryByIds} - the predicate belongs inside the class, not on this signature. To find
     * them wherever they live rather than only here, {@link queryByIdsAcrossOrganizations}.
     *
     * @param {ReadonlyArray<string>} ids - The aggregate ids to load.
     * @returns {Promise<Array<T>>} The aggregates found; empty when none of the ids matched, or when no usable id was given.
     */
    getByIds(ids: ReadonlyArray<string>): Promise<Array<T>>;
    /**
     * Every row in the snapshot table **for the current organization**.
     *
     * Unbounded within the tenant, and takes no arguments so that it can only be called on purpose.
     * It is {@link query} with no predicate, so the organization filter is still prepended - this is
     * one studio's rows, never the whole table. Crossing that boundary takes
     * {@link queryAcrossOrganizations}, which is named for it - with `{}` it is this read over every
     * organization.
     *
     * @returns {Promise<Array<T>>} Every aggregate in the current organization, deserialized.
     */
    getAll(): Promise<Array<T>>;
    /**
     * The aggregate with this id, **within the current organization**.
     *
     * An id belonging to another organization reads exactly as one that does not exist - the tenant
     * filter is part of the statement, not a check applied afterwards.
     *
     * To load it only if it also satisfies a condition, a subclass builds its own method over
     * {@link queryById} - the predicate belongs inside the class, not on this signature. To find it in
     * whatever organization owns it, {@link queryByIdAcrossOrganizations}.
     *
     * @param {string} id - The aggregate id to load.
     * @returns {Promise<T>} The aggregate.
     * @throws {AggregateNotFoundException} If the current organization carries no row with the id.
     */
    get(id: string): Promise<T>;
    /**
     * Saves the snapshot and the underlying event stream in a transaction this repository owns, and
     * commits it - or rolls it back and rethrows if anything fails.
     *
     * The transaction is this repository's own {@link BaseRepository.unitOfWork}. If anything else
     * was queued on that same instance, **this commits that too**, because a unit of work commits as
     * a whole. Use {@link saveWithin} when several writes have to land together.
     *
     * The first save each process makes per query set also verifies the declared index paths against
     * the real snapshot document (`SnapshotQuerySet.verifyDocument`): a fatal shape issue - a
     * `@serialize("customKey")` rename, raw-path drift, a Map/Set where an array was declared -
     * throws before anything is queued, and ambiguous findings log one warning. One `WeakSet` lookup
     * per save after that.
     *
     * **`force` re-writes the row for an aggregate that has not changed**, which is what a data
     * migration needs when the stored *shape* moved rather than the state: a newly `@serialize`d
     * computed field on a value object, declared on {@link querySet} and indexed by a migration, is
     * absent from every row written before it existed. Load each aggregate and save it back with
     * `force`, and `data` is re-serialized from the current code.
     *
     * It bypasses this repository's change check and nothing else. The event stream keeps its own, so
     * an unchanged aggregate appends no events and fires no `onSave` - a re-save does not republish
     * history - and the write is the same `on conflict (id) do update` upsert an ordinary update
     * takes. Prefer {@link saveWithin} with `force` across a migration, so a batch lands as one
     * transaction rather than one per aggregate.
     *
     * **Forcing does not step outside the organization**, because nothing about the tenant check
     * moves: an aggregate belonging to another organization is rejected here exactly as it always
     * was. So a migration that has to cover every tenant runs once per organization's
     * {@link BaseRepository.domainContext}, and nothing a cross-organization read returns can be fed
     * straight back into this door - not {@link queryAcrossOrganizations}, and not
     * {@link queryByIdAcrossOrganizations} or {@link queryByIdsAcrossOrganizations}, which are the
     * likelier source of a foreign aggregate.
     *
     * `force` lives here and not on {@link Repository}, whose `save` the event stream repositories
     * also implement and could not honor - an unchanged aggregate has no events to append. So it is
     * reachable through a snapshot repository's own type; a caller holding the `Repository<T>`
     * interface, or a domain interface extending it, does not see it.
     *
     * @param {T} value - The aggregate to save. A no-op when it is neither new nor changed, unless `force`.
     * @param {boolean} [force=false] - Writes the snapshot row even when the aggregate is neither new nor changed. For a data migration that re-serializes stored state; see above.
     * @throws {ApplicationException} If a declared index path has a fatal shape issue against the document being saved.
     */
    save(value: T, force?: boolean): Promise<void>;
    /**
     * Saves the snapshot and the underlying event stream into a transaction the caller owns, and
     * **does not commit**.
     *
     * Shape-verified exactly as {@link save} is - a fatal issue throws before anything is queued on
     * the caller's transaction.
     *
     * This is the door a data migration wants: `force` here re-writes each unchanged row into the
     * caller's transaction, so one organization's batch commits once rather than once per aggregate.
     * See {@link save} for what forcing does and does not touch.
     *
     * @param {T} value - The aggregate to save. A no-op when it is neither new nor changed, unless `force`.
     * @param {UnitOfWork} unitOfWork - The caller's transaction. Required; committing it is theirs to do.
     * @param {boolean} [force=false] - Writes the snapshot row even when the aggregate is neither new nor changed.
     * @throws {ApplicationException} If a declared index path has a fatal shape issue against the document being saved.
     */
    saveWithin(value: T, unitOfWork: UnitOfWork, force?: boolean): Promise<void>;
    /**
     * Runs a query **scoped to the current organization** and deserializes each row into an
     * aggregate.
     *
     * This owns the statement: `select data from <this.table> where organization_id = ? and (<your
     * predicate>)`. So what you supply is the predicate, without the `where` keyword - and the
     * organization filter is added for you, ahead of it, which is both the tenant isolation and the
     * leading index column every btree index on this table needs.
     *
     * **A predicate always carries its own values.** Every one comes from {@link querySet} - a typed
     * `eq`/`gt`/`in`/`contains`, a combinator, or `raw` for a hand-written fragment - and each binds
     * its own `?` placeholders. There is nothing to pass positionally and no way to mis-order the
     * binding against the organization value that precedes it, which is why this takes no parameters
     * beyond the predicate itself.
     *
     * The predicate is parenthesized, so a top-level `or` in it stays contained rather than escaping
     * the organization filter.
     *
     * Pass a {@link RepositoryQuery} instead of a bare predicate to add `order by`, `limit` or
     * `offset`, or to run with no predicate at all (`{}`). To constrain the id as well as the
     * predicate, use {@link queryById} or {@link queryByIds} - `id` is a column beside `data`, so no
     * predicate this takes can reach it. For a read that genuinely spans organizations, and only
     * then, use {@link queryAcrossOrganizations} - this same shape, admitting only predicates over
     * paths declared `acrossOrganizations` - or {@link queryStatementAcrossOrganizations} for a whole
     * statement. For reads whose shape does not map onto the
     * aggregate - counts, group-bys, projections - use {@link queryRawAcrossOrganizations}, which
     * performs no deserialization and, as its name says, adds no organization filter either.
     *
     * @param {SnapshotPredicate | RepositoryQuery} whereOrQuery - A predicate from {@link querySet}, or the predicate and the clauses that follow it.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'; if orderBy is empty or contains a ';'; or if limit or offset is not a non-negative integer.
     */
    protected query(whereOrQuery: SnapshotPredicate | RepositoryQuery): Promise<Array<T>>;
    /**
     * The aggregate with this id, within the current organization, if it also satisfies `predicate`.
     *
     * The id column is the one thing a {@link querySet} cannot reach - its paths read inside `data`,
     * and the primary key is a column beside it - so an id lookup and a declared-path condition come
     * from different places and cannot be composed by the caller. This is where they meet: the
     * statement is `where organization_id = ? and (id in (?) and (<your predicate>))`, with the
     * organization filter leading as always and the predicate parenthesized so a top-level `or`
     * inside it can escape neither the id filter nor the tenant one.
     *
     * **Returns null rather than throwing**, unlike {@link get}, and does so for every miss alike -
     * no such id, an id in another organization, and an id whose row the predicate excluded. To find
     * that second case rather than read it as a miss, {@link queryByIdAcrossOrganizations} is this
     * without the tenant filter. They are
     * not distinguished here on purpose: only the subclass knows what its predicate meant, so only
     * the subclass can say whether an excluded row is exceptional.
     *
     * @param {string} id - The aggregate id to load.
     * @param {SnapshotPredicate} [predicate] - A further condition the row must satisfy; omitted loads by id alone.
     * @returns {Promise<T | null>} The aggregate, or null when nothing matched.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'.
     */
    protected queryById(id: string, predicate?: SnapshotPredicate): Promise<T | null>;
    /**
     * The aggregates with these ids that also satisfy `predicate`, within the current organization.
     *
     * The set-shaped counterpart to {@link queryById}, and the read {@link getByIds} is built from -
     * so the id hygiene is the same one: ids that are blank once trimmed are dropped, and if that
     * leaves none the result is empty without a statement being run at all.
     *
     * {@link queryByIdsAcrossOrganizations} is this without the tenant filter, for ids that may belong
     * to any organization.
     *
     * @param {ReadonlyArray<string>} ids - The aggregate ids to load.
     * @param {SnapshotPredicate} [predicate] - A further condition each row must satisfy; omitted loads by id alone.
     * @returns {Promise<Array<T>>} The aggregates found in the current organization; empty when nothing matched, or when no usable id was given.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'.
     */
    protected queryByIds(ids: ReadonlyArray<string>, predicate?: SnapshotPredicate): Promise<Array<T>>;
    /**
     * Whether anything matches - without deserializing it.
     *
     * The question a natural-key rule asks: *is this value already taken within the current organization, by
     * someone other than me*. `excludeId` is what makes the "other than me" half work on an update, and it is
     * a parameter rather than something a caller filters out afterwards because it goes into the statement,
     * which is what lets the read stop at the first match instead of materializing every one.
     *
     * Unlike {@link queryRawAcrossOrganizations}, this applies the same filtering {@link query} does - the organization filter included.
     * A hand-written condition reaches it through `SnapshotQuerySet.raw`, so there is no need to assemble a
     * statement to ask a yes-or-no question.
     *
     * Note that it answers about *stored* rows, so it races with a concurrent write. It is a check, not a
     * constraint: declare the path `unique` on the query set and let the index be the guarantee.
     *
     * @param {SnapshotPredicate} [predicate] - What to match; omitted asks whether there is any row at all.
     * @param {string} [excludeId] - An id that does not count as a match.
     * @returns {Promise<boolean>} Whether at least one row matched.
     */
    protected exists(predicate?: SnapshotPredicate, excludeId?: string): Promise<boolean>;
    /**
     * How many rows match - without deserializing them.
     *
     * The counterpart to {@link exists}, and scoped the same way. For a count broken down by something -
     * a group-by - use {@link queryRawAcrossOrganizations}: that shape is a projection rather than a single
     * number, and this cannot express it.
     *
     * @param {SnapshotPredicate} [predicate] - What to count; omitted counts every row within the current organization.
     * @returns {Promise<number>} The number of matching rows.
     */
    protected count(predicate?: SnapshotPredicate): Promise<number>;
    /**
     * Runs a raw SQL query, **with no organization filter added**, and returns the unprocessed
     * {@link QueryResult}.
     *
     * For reads whose shape does not map onto the aggregate - counts, group-bys, projections. It is
     * named for its consequence, like {@link queryAcrossOrganizations}: nothing here scopes the read,
     * so a statement meant to stay within one organization has to constrain the column itself.
     * {@link organizationPredicate} is how, and leading, so the index is used.
     *
     * **This is the only raw door on this class, but not the only way to reach the database.**
     * `this.db` is right there, and has to be - the snapshot repositories are constructed from an
     * event stream repository's `db`, and TypeScript's `protected` does not reach across sibling
     * classes, so it is public. The naming here is guidance about which door reads as the obvious
     * one, not a boundary the type system enforces. It is worth knowing which it is.
     *
     * @template TRow - The expected shape of each returned row.
     * @param {string} sql - The statement to run.
     * @param {...ReadonlyArray<any>} params - Values bound to the statement's `?` placeholders.
     * @returns {Promise<QueryResult<TRow>>} The raw query result.
     */
    protected queryRawAcrossOrganizations<TRow>(sql: string, ...params: ReadonlyArray<any>): Promise<QueryResult<TRow>>;
    /**
     * Runs a typed query **across every organization** and deserializes each row into an aggregate.
     *
     * {@link query} with the organization filter dropped: the same statement shape - `select data from
     * <this.table> where (<your predicate>)`, with `order by`, `limit` and `offset` on the
     * {@link RepositoryQuery} form and `{}` for every row of every organization - built by the same
     * builder, so what differs is exactly one conjunct. Named for its consequence, so the tenant
     * implication is visible at the call site.
     *
     * **What it accepts is what an index can still serve.** Every btree index on this table leads with
     * `organization_id`, and btree serves only a leading prefix, so once the filter is gone a condition
     * on an ordinary declared path cannot be an index lookup - the planner scans the table, or walks the
     * whole index. A path declared `{ acrossOrganizations: true }` on the query set is different: the
     * migration also builds it a prefix-free `_xorg` twin, and every predicate and order-by term over
     * such paths is branded `acrossOrganizations: true`. This door takes only that brand
     * (`SnapshotPredicate<true>`, `RepositoryQuery<true>`), so a predicate on an unflagged path is a
     * compile error here - the same contract as {@link query}'s path checking, restated for the index
     * that is actually there. Containment is always branded (a GIN index has no prefix), `and`/`or`
     * only when every arm is, and a hand-written fragment is branded by
     * `SnapshotQuerySet.rawAcrossOrganizations`, where the caller owns the claim. The brand is checked
     * at runtime as well, so a JavaScript caller is refused the same way.
     *
     * The brand says every path is indexed across organizations; whether a particular plan uses the
     * index is Postgres's, exactly as within an organization - a `not`, an `is null`, or the second
     * member of a composite compile on both doors and are served by neither.
     *
     * **What comes back is read-only in practice**: each aggregate is deserialized against the
     * *current* {@link BaseRepository.domainContext} while carrying its own `organizationId`, and
     * `save` rejects one whose organization is not this one, `force` included.
     *
     * @param {SnapshotPredicate<true> | RepositoryQuery<true>} whereOrQuery - A branded predicate from {@link querySet}, or the predicate and the clauses that follow it; `{}` reads every row of every organization.
     * @returns {Promise<Array<T>>} The deserialized aggregates, from whatever organizations hold them; empty when nothing matched.
     * @throws {ArgumentException} If the predicate or a typed order-by term is not branded across organizations; if the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'; if orderBy is empty or contains a ';'; or if limit or offset is not a non-negative integer.
     */
    protected queryAcrossOrganizations(whereOrQuery: SnapshotPredicate<true> | RepositoryQuery<true>): Promise<Array<T>>;
    /**
     * Whether anything matches **in any organization** - {@link exists} with the organization filter
     * dropped, and typed like {@link queryAcrossOrganizations}: only a predicate branded across
     * organizations, so the check is an index lookup rather than a scan.
     *
     * @param {SnapshotPredicate<true>} [predicate] - What to match; omitted asks whether the table holds any row at all.
     * @param {string} [excludeId] - An id that does not count as a match.
     * @returns {Promise<boolean>} Whether at least one row matched, in any organization.
     * @throws {ArgumentException} If the predicate is not branded across organizations, or is malformed as described on {@link queryAcrossOrganizations}.
     */
    protected existsAcrossOrganizations(predicate?: SnapshotPredicate<true>, excludeId?: string): Promise<boolean>;
    /**
     * How many rows match **across every organization** - {@link count} with the organization filter
     * dropped, and typed like {@link queryAcrossOrganizations}.
     *
     * @param {SnapshotPredicate<true>} [predicate] - What to count; omitted counts every row of every organization.
     * @returns {Promise<number>} The number of matching rows.
     * @throws {ArgumentException} If the predicate is not branded across organizations, or is malformed as described on {@link queryAcrossOrganizations}.
     */
    protected countAcrossOrganizations(predicate?: SnapshotPredicate<true>): Promise<number>;
    /**
     * Runs a whole statement, **with no organization filter added**, and deserializes each row into
     * an aggregate.
     *
     * The plain repository's `queryStatement`, named here for its consequence: for the joins, unions
     * and CTEs the statement {@link queryAcrossOrganizations} builds cannot express. Everything the
     * built doors guarantee is yours to get right:
     *
     * - the select list must be `data`, since that is the column each row is deserialized from;
     * - build any expression over `data` from {@link querySet}'s `expressionFor`, so it still matches
     *   the index it was created from - Postgres uses an expression index only when the expression
     *   matches *textually*, and a near-miss silently loses the index;
     * - if the read is meant to stay within one organization, splice {@link organizationPredicate} in
     *   leading, so the filter both isolates the tenant and lets the index be used.
     *
     * **Know what an index can and cannot serve once the filter is gone.** Every btree expression
     * index on this table leads with `organization_id`, and btree serves only a leading prefix - so a
     * cross-organization condition on an unflagged path cannot be an index lookup: the planner scans
     * the table, or walks the whole index. What survives the boundary intact: a path declared
     * `acrossOrganizations`, whose prefix-free `_xorg` twin is what {@link queryAcrossOrganizations}
     * exists to use; containment on an array path, whose GIN index carries no tenant prefix; and a
     * lookup by `id`, the primary key, which has its own doors in {@link queryByIdAcrossOrganizations}
     * and {@link queryByIdsAcrossOrganizations}.
     *
     * Prefer {@link queryAcrossOrganizations} unless it cannot express the read.
     *
     * @param {string} sql - The statement to run. Must select the `data` column.
     * @param {...ReadonlyArray<any>} params - Values bound to the statement's `?` placeholders.
     * @returns {Promise<Array<T>>} The deserialized aggregates; empty when nothing matched.
     */
    protected queryStatementAcrossOrganizations(sql: string, ...params: ReadonlyArray<any>): Promise<Array<T>>;
    /**
     * The aggregate with this id, **in whatever organization owns it**, if it also satisfies
     * `predicate`.
     *
     * {@link queryById} without the tenant filter, and named for that consequence. Where the scoped
     * pair reads an id from another organization as a miss, this finds it - which is what a
     * platform-wide question ("which organization owns this id?") needs, and why it is a door a
     * subclass has to name for itself rather than something `get` could do quietly.
     *
     * **At most one row, because `id` is the primary key - and globally, not per tenant.** That is
     * also what makes this cheap: the primary key carries no leading `organization_id`, so this is an
     * index lookup where a cross-organization condition on an unflagged path would be a scan (see
     * {@link queryAcrossOrganizations}, and the `acrossOrganizations` declaration that gives a path
     * its own prefix-free index).
     *
     * **The aggregate that comes back is read-only in practice.** It is deserialized against the
     * *current* {@link BaseRepository.domainContext} while its state carries its own
     * `organizationId`, and `save` rejects an aggregate whose organization is not this one - so a
     * cross-organization read cannot be fed back into a write, `force` included.
     *
     * @param {string} id - The aggregate id to load.
     * @param {SnapshotPredicate} [predicate] - A further condition the row must satisfy; omitted loads by id alone.
     * @returns {Promise<T | null>} The aggregate, in whatever organization holds it, or null when nothing matched.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'.
     */
    protected queryByIdAcrossOrganizations(id: string, predicate?: SnapshotPredicate): Promise<T | null>;
    /**
     * The aggregates with these ids, **across every organization**, that also satisfy `predicate`.
     *
     * The set-shaped counterpart to {@link queryByIdAcrossOrganizations}, and {@link queryByIds}
     * without the tenant filter - so the id hygiene is the same one: ids that are blank once trimmed
     * are dropped, and if that leaves none the result is empty without a statement being run at all.
     *
     * The optional predicate costs nothing here, which is why - unlike {@link queryAcrossOrganizations} -
     * this door takes any `SnapshotPredicate`, branded or not: the ids have already narrowed the read
     * to a primary key lookup, so the predicate filters those few rows rather than deciding whether an
     * index can be used at all.
     *
     * @param {ReadonlyArray<string>} ids - The aggregate ids to load.
     * @param {SnapshotPredicate} [predicate] - A further condition each row must satisfy; omitted loads by id alone.
     * @returns {Promise<Array<T>>} The aggregates found, in whatever organizations hold them; empty when nothing matched, or when no usable id was given.
     * @throws {ArgumentException} If the predicate is a whole statement, keeps the `where` keyword, is empty, or contains a ';'.
     */
    protected queryByIdsAcrossOrganizations(ids: ReadonlyArray<string>, predicate?: SnapshotPredicate): Promise<Array<T>>;
    /**
     * The body both save doors share; `owned` is who commits and `force` is whether the change check
     * applies, and between them they are the whole of what separates one call from another. The
     * organization check is not one of them - it runs before either.
     */
    private _save;
    private _deserialize;
}
//# sourceMappingURL=org-snapshot-base-repository.d.ts.map