import { ApplicationException } from "@nivinjoseph/n-exception";
import { given } from "@nivinjoseph/n-defensive";

/**
 * The base for this example's domain exceptions.
 *
 * A domain exception exists so a rule the *domain* enforces can be told apart from a failure the
 * database reports. Both happen for the same rule here: a slug collision is caught by a probe in the
 * factory and raised as one of these, and is *also* caught by a unique index and raised as a
 * `DbException`. The probe gives a precise error under normal conditions; the index is the backstop
 * that holds under a race. A real application maps the first to a 4xx and discriminates the second on
 * Postgres error code `23505`.
 *
 * @class ExampleException
 */
export abstract class ExampleException extends ApplicationException
{
    private readonly _code: string;

    /**
     * A stable identifier for the rule that was broken, for a caller that has to branch on it - as
     * opposed to the message, which is for a human.
     */
    public get code(): string { return this._code; }

    protected constructor(code: string, message: string)
    {
        given(code, "code").ensureHasValue().ensureIsString();
        given(message, "message").ensureHasValue().ensureIsString();

        super(message);

        this._code = code;
    }
}
