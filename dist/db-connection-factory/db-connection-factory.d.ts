import { Disposable } from "@nivinjoseph/n-util";
export interface DbConnectionFactory extends Disposable {
    create(): Promise<object>;
}
//# sourceMappingURL=db-connection-factory.d.ts.map