export interface DbMigration
{
    execute(): Promise<void>;
}