/**
 * Invites creators into the current studio.
 *
 * There is no studio parameter: the studio is the ambient organization on the domain context. A factory that
 * took one would let a caller create a creator in a studio the request has no business touching.
 */
export interface CreatorFactory
{
    invite(email: string, displayName: string, role: string): Promise<string>;
}
