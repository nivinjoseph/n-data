/**
 * The single registry of id prefixes for this example.
 *
 * `DomainHelper.generateId` accepts exactly three alphabetic characters, so a prefix is not free-form -
 * and because ids are otherwise opaque strings, the prefix is the only thing that stops one aggregate's
 * id being recorded on another and replayed forever. Every id entering the domain asserts its prefix,
 * inside the events themselves.
 */
export enum IdPrefix
{
    studio = "std",
    creator = "crt"
}
