/**
 * Creates studios.
 *
 * It returns the **id**, not the aggregate. Creation here is a completed act - the factory has already
 * saved - so handing back a live aggregate would invite a caller to mutate and save it again as though
 * it were still new. The id is what a caller needs to go and load it.
 */
export interface StudioFactory
{
    create(name: string, tier: string, seatLimit: number): Promise<string>;
}
