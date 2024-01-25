import assert from "node:assert";
import test, { after, before, describe } from "node:test";
import { Db, DbConnectionConfig, DbConnectionFactory, KnexPgDb, KnexPgDbConnectionFactory, KnexPgUnitOfWork } from "../src/index.js";


await describe("Db tests", async () =>
{
    let dbConnectionFactory: DbConnectionFactory;
    let db: Db;

    before(async () =>
    {
        const config: DbConnectionConfig = {
            host: "localhost",
            port: "5432",
            database: "testdb",
            username: "postgres",
            password: "p@ssw0rd"
        };
        dbConnectionFactory = new KnexPgDbConnectionFactory(config);
        db = new KnexPgDb(dbConnectionFactory);
    });

    after(async () =>
    {
        await dbConnectionFactory.dispose();
    });


    await describe("Query tests", async () =>
    {
        before(async () =>
        {
            await db.executeCommand(`
                drop table if exists products;
                create table products(
                    id int primary key,
                    name varchar(10)
                );
                insert into products(id, name) values(1, 'cheese'), (2, 'wine');
            `);
        });

        after(async () =>
        {
            await db.executeCommand(`drop table if exists products`);
        });


        await test("query should return multiple results", async () =>
        {
            const result = await db.executeQuery(`select * from products`);
            assert.strictEqual(2, result.rows.length);
            assert.deepEqual(result.rows, [{ id: 1, name: "cheese" }, { id: 2, name: "wine" }]);
        });

        await test("query with filter should return one result", async () =>
        {
            const result = await db.executeQuery(`select * from products where id = ?`, 1);
            assert.strictEqual(1, result.rows.length);
            assert.deepEqual(result.rows, [{ id: 1, name: "cheese" }]);
        });

        await test("query should return count", async () =>
        {
            const result = await db.executeQuery<any>(`select cast(count(*) as int) from products`);
            assert.strictEqual(1, result.rows.length);
            assert.strictEqual(result.rows[0].count, 2);
        });

        await test("query with in clause should return results", async () =>
        {
            const result = await db.executeQuery(`select * from products where id in (?, ?)`, 1, 2);
            assert.strictEqual(2, result.rows.length);
            assert.deepEqual(result.rows, [{ id: 1, name: "cheese" }, { id: 2, name: "wine" }]);
        });
    });

    await describe("Command tests", async () =>
    {
        before(async () =>
        {
            await db.executeCommand(`
                drop table if exists products;
                create table products(
                    id int primary key,
                    name varchar(10)
                );
            `);
        });

        after(async () =>
        {
            await db.executeCommand(`drop table if exists products`);
        });


        await test("command should execute successfully", async () =>
        {
            await db.executeCommand(`insert into products(id, name) values(?, ?)`, 3, "milk");
            const result = await db.executeQuery("select * from products where id = ?", 3);
            assert.strictEqual(result.rows.length, 1);
            assert.deepEqual(result.rows, [{ id: 3, name: "milk" }]);
        });

        await test("multiple commands should execute independently", async () =>
        {
            await db.executeCommand(`insert into products(id, name) values(?, ?)`, 4, "pasta");

            try
            {
                await db.executeCommand(`insert into products(id, name) values(?, ?)`, 5, "012345678901234567890123456789012345678901234567890123456789");
            }
            catch (error)
            {
                // console.log(error);
            }

            const result = await db.executeQuery("select * from products order by id");
            assert.strictEqual(result.rows.length, 2);
            assert.deepEqual(result.rows, [{ id: 3, name: "milk" }, { id: 4, name: "pasta" }]);
        });
    });

    await describe("Versioning tests", async () =>
    {
        before(async () =>
        {
            // console.log("creating table");
            await db.executeCommand(`
                drop table if exists products;
                create table products(
                    id int primary key,
                    version int not null,
                    name varchar(100)
                );
            `);

            // console.log("Inserting 2");
            await db.executeCommand(`
                insert into products(id, version, name) values(1, 1, 'cheese'), (2, 1, 'bread');
            `);

            // console.log("updating 1");
            // await db.executeCommand(`update products set version = ?, name = ? where id = ? and version = ?;`,
            //     2, "brie cheese", 1, 1);

            // console.log("updating 2");
            // await db.executeCommand(`update products set version = ? where id in (?, ?);`,
            //     3, 1, 2);

            // console.log("deleting 1");
            // await db.executeCommand(`delete from products where id = 1;`);
        });

        // test("nothing", () =>
        // {
        //     assert.ok(true);
        // });

        await test("Should successfully update record", async () =>
        {
            const sql = `update products set version = ?, name = ? where id = ? and version = ?;`;
            await db.executeCommand(sql, 2, "brie cheese", 1, 1);
            const result = await db.executeQuery("select * from products order by id;");
            assert.strictEqual(result.rows.length, 2);
            assert.deepEqual(result.rows, [{ id: 1, version: 2, name: "brie cheese" }, { id: 2, version: 1, name: "bread" }]);
        });

        await test("Should fail and not update the record", async () =>
        {
            const sql = `update products set version = ?, name = ? where id = ? and version = ?;`;

            let exceptionThrown = false;
            try
            {
                await db.executeCommand(sql, 2, "provolone cheese", 1, 1);
            }
            catch (error)
            {
                exceptionThrown = true;
                // console.log(error);
            }

            assert.strictEqual(exceptionThrown, true);
            const result = await db.executeQuery("select * from products order by id;");
            assert.strictEqual(result.rows.length, 2);
            assert.deepEqual(result.rows, [{ id: 1, version: 2, name: "brie cheese" }, { id: 2, version: 1, name: "bread" }]);
        });
    });

    await describe("UnitOfWork tests", async () =>
    {
        before(async () =>
        {
            await db.executeCommand(`
                drop table if exists products;
                create table products(
                    id int primary key,
                    name varchar(10)
                );
            `);
        });

        after(async () =>
        {
            await db.executeCommand(`drop table if exists products`);
        });


        await test("commands should execute successfully if committed", async () =>
        {
            let isCommitted = false;
            let isRolledback = false;
            const unitOfWork = new KnexPgUnitOfWork(dbConnectionFactory);
            unitOfWork.onCommit(async () => { isCommitted = true; });
            unitOfWork.onRollback(async () => { isRolledback = true; });
            try
            {
                await db.executeCommandWithinUnitOfWork(unitOfWork, `insert into products(id, name) values(?, ?)`, 3, "milk");
                await db.executeCommandWithinUnitOfWork(unitOfWork, `insert into products(id, name) values(?, ?)`, 4, "pasta");
                await unitOfWork.commit();
            }
            catch (error)
            {
                await unitOfWork.rollback();
            }

            const result = await db.executeQuery(`select * from products where id in (3, 4)`);
            assert.strictEqual(result.rows.length, 2);
            assert.deepEqual(result.rows, [{ id: 3, name: "milk" }, { id: 4, name: "pasta" }]);
            assert.strictEqual(isCommitted, true);
            assert.strictEqual(isRolledback, false);
        });

        await test("no commands should execute successfully if rolledback", async () =>
        {
            let isCommitted = false;
            let isRolledback = false;
            const unitOfWork = new KnexPgUnitOfWork(dbConnectionFactory);
            unitOfWork.onCommit(async () => { isCommitted = true; });
            unitOfWork.onRollback(async () => { isRolledback = true; });
            try
            {
                await db.executeCommandWithinUnitOfWork(unitOfWork, `insert into products(id, name) values(?, ?)`, 5, "fish");
                await db.executeCommandWithinUnitOfWork(unitOfWork, `insert into products(id, name) values(?, ?)`, 6, "012345678901234567890123456789012345678901234567890123456789");
                await unitOfWork.commit();
            }
            catch (error)
            {
                await unitOfWork.rollback();
            }

            const result = await db.executeQuery<any>(`select cast(count(*) as int) from products where id in (5, 6)`);
            assert.strictEqual(result.rows[0].count, 0);
            assert.strictEqual(isCommitted, false);
            assert.strictEqual(isRolledback, true);
        });
    });

    await describe("Object tree tests", async () =>
    {
        before(async () =>
        {
            await db.executeCommand(`
                    drop table if exists orders;
                    drop table if exists customers;
                `);

            await db.executeCommand(`
                    create table customers(
                        id int primary key,
                        name varchar(50)
                    );
                `);

            await db.executeCommand(`
                    create table orders(
                        id int primary key,
                        customer_id int references customers(id),
                        amount numeric not null check(amount > 0)
                    );
                `);

            await db.executeCommand(`
                    insert into customers(id, name) values(1, 'nivin');
                    insert into orders(id, customer_id, amount)
                        values(1, 1, 50.00), (2, 1, 30.00);

                    insert into customers(id, name) values(2, 'shrey');
                    insert into orders(id, customer_id, amount)
                        values(3, 2, 10.00), (4, 2, 20.00), (5, 2, 35.00);
                `);
        });

        after(async () =>
        {
            await db.executeCommand(`
                drop table if exists orders;
                drop table if exists customers;
            `);
        });

        await test("Produce single object tree from query", async () =>
        {
            const result = await db.executeQuery(`
                    select c.id as id, c.name as name, o.id as "orders:id", o.amount as "orders:amount"
                    from customers as c inner join orders as o on c.id = o.customer_id where c.id = 1
                `);

            const data = result.toObjectTree();
            assert.deepEqual(data, [
                {
                    id: 1,
                    name: "nivin",
                    orders: [
                        {
                            id: 1,
                            amount: 50.00
                        },
                        {
                            id: 2,
                            amount: 30.00
                        }
                    ]
                }
            ]);
        });

        await test("Produce multiple object trees from query", async () =>
        {
            const result = await db.executeQuery(`
                    select c.id as id, c.name as name, o.id as "orders:id", o.amount as "orders:amount"
                    from customers as c inner join orders as o on c.id = o.customer_id
                `);

            const data = result.toObjectTree();
            assert.deepEqual(data, [
                {
                    id: 1,
                    name: "nivin",
                    orders: [
                        {
                            id: 1,
                            amount: 50.00
                        },
                        {
                            id: 2,
                            amount: 30.00
                        }
                    ]
                },
                {
                    id: 2,
                    name: "shrey",
                    orders: [
                        {
                            id: 3,
                            amount: 10.00
                        },
                        {
                            id: 4,
                            amount: 20.00
                        },
                        {
                            id: 5,
                            amount: 35.00
                        }
                    ]
                }
            ]);
        });
    });

    await describe("JsonB query tests", async () =>
    {
        const createdOn = Date.now();

        before(async () =>
        {
            await db.executeCommand(`
                drop table if exists assets;

                create table assets(
                    id int primary key,
                    body jsonb
                );
            `);

            await db.executeCommand(`
                insert into assets(id, body)
                    values(?,?), (?,?)
            `, 1,
                {
                    name: "txt1.txt",
                    ext: "txt", createdOn:
                        createdOn,
                    tags: ["baz", "bar"]
                },
                2,
                {
                    name: "import.xls",
                    ext: "xls",
                    tags: ["foo", "bar"]
                });
        });

        after(async () =>
        {
            await db.executeCommand(`
                drop table if exists assets;
            `);
        });

        await test("successfully retrieve jsonb data when queried by id", async () =>
        {
            const result = await db.executeQuery("select * from assets where id = ?", 1);
            assert.strictEqual(result.rows.length, 1);
            assert.deepEqual(result.rows, [
                {
                    id: 1,
                    body: {
                        name: "txt1.txt",
                        ext: "txt",
                        createdOn: createdOn,
                        tags: ["baz", "bar"]
                    }
                }]);
        });

        await test("successfully retrieve jsonb data when queried by jsonb scalar field", async () =>
        {
            const result = await db.executeQuery(`select * from assets where body @> ?;`, { ext: "xls" });
            assert.strictEqual(result.rows.length, 1);
            assert.deepEqual(result.rows, [
                {
                    id: 2,
                    body: {
                        name: "import.xls",
                        ext: "xls",
                        tags: ["foo", "bar"]
                    }
                }]);
        });

        await test("successfully retrieve jsonb data when queried by jsonb array field", async () =>
        {
            const result = await db.executeQuery(`select * from assets where body @> ?;`, { tags: ["bar"] });
            assert.strictEqual(result.rows.length, 2);
            assert.deepEqual(result.rows, [
                {
                    id: 1,
                    body: {
                        name: "txt1.txt",
                        ext: "txt",
                        createdOn: createdOn,
                        tags: ["baz", "bar"]
                    }
                },
                {
                    id: 2,
                    body: {
                        name: "import.xls",
                        ext: "xls",
                        tags: ["foo", "bar"]
                    }
                }]);
        });
    });

    await describe("JsonB command tests", async () =>
    {
        before(async () =>
        {
            await db.executeCommand(`
                drop table if exists assets;

                create table assets(
                    id int primary key,
                    body jsonb
                );
            `);
        });

        after(async () =>
        {
            await db.executeCommand(`
                drop table if exists assets;
            `);
        });

        await test("successfully insert jsonb data", async () =>
        {
            await db.executeCommand(`
                insert into assets(id, body)
                    values(?,?), (?,?)
            `, 1, { name: "txt1.txt", ext: "txt" }, 2, { name: "import.xls", ext: "xls" });

            const result = await db.executeQuery("select * from assets");
            assert.strictEqual(result.rows.length, 2);
            assert.deepEqual(result.rows, [{ id: 1, body: { name: "txt1.txt", ext: "txt" } },
            { id: 2, body: { name: "import.xls", ext: "xls" } }]);
        });
    });
});