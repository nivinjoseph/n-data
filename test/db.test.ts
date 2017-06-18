import * as Assert from "assert";
import { DbConnectionFactory } from "../src/db-connection-factory/db-connection-factory";
import { Db } from "../src/db/db";
import { KnexPgDbConnectionFactory } from "../src/db-connection-factory/knex-pg-db-connection-factory";
import { KnexPgDb } from "../src/db/knex-pg-db";
import { KnexPgUnitOfWork } from "../src/unit-of-work/knex-pg-unit-of-work";


suite("Db tests", () =>
{
    let dbConnectionFactory: DbConnectionFactory;
    let db: Db;

    suiteSetup(async () =>
    {
        dbConnectionFactory = new KnexPgDbConnectionFactory("localhost", "5432", "testdb", "postgres", "P0stgr3s");
        db = new KnexPgDb(dbConnectionFactory);
    });

    suiteTeardown(() =>
    {
        if (dbConnectionFactory && dbConnectionFactory instanceof KnexPgDbConnectionFactory)
            (dbConnectionFactory as KnexPgDbConnectionFactory).destructor();
    });


    suite("Query tests", () =>
    {
        suiteSetup(async () =>
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

        suiteTeardown(async () =>
        {
            await db.executeCommand(`drop table if exists products`);
        });


        test("query should return multiple results", async () =>
        {
            let result = await db.executeQuery(`select * from products`);
            Assert.strictEqual(2, result.rows.length);
            Assert.deepEqual(result.rows, [{ id: 1, name: "cheese" }, { id: 2, name: "wine" }]);
        });

        test("query with filter should return one result", async () =>
        {
            let result = await db.executeQuery(`select * from products where id = ?`, 1);
            Assert.strictEqual(1, result.rows.length);
            Assert.deepEqual(result.rows, [{ id: 1, name: "cheese" }]);
        });

        test("query should return count", async () =>
        {
            let result = await db.executeQuery<any>(`select cast(count(*) as int) from products`);
            Assert.strictEqual(1, result.rows.length);
            Assert.strictEqual(result.rows[0].count, 2);
        });
    });

    suite("Command tests", () =>
    {
        suiteSetup(async () =>
        {
            await db.executeCommand(`
                drop table if exists products;
                create table products(
                    id int primary key,
                    name varchar(10)
                );
            `);
        });

        suiteTeardown(async () =>
        {
            await db.executeCommand(`drop table if exists products`);
        });


        test("command should execute successfully", async () =>
        {
            await db.executeCommand(`insert into products(id, name) values(?, ?)`, 3, "milk");
            let result = await db.executeQuery("select * from products where id = ?", 3);
            Assert.strictEqual(result.rows.length, 1);
            Assert.deepEqual(result.rows, [{ id: 3, name: "milk" }]);
        });

        test("multiple commands should execute independently", async () =>
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

            let result = await db.executeQuery("select * from products order by id");
            Assert.strictEqual(result.rows.length, 2);
            Assert.deepEqual(result.rows, [{ id: 3, name: "milk" }, { id: 4, name: "pasta" }]);
        });
    });

    suite("UnitOfWork tests", () =>
    {
        suiteSetup(async () =>
        {
            await db.executeCommand(`
                drop table if exists products;
                create table products(
                    id int primary key,
                    name varchar(10)
                );
            `);
        });

        suiteTeardown(async () =>
        {
            await db.executeCommand(`drop table if exists products`);
        });


        test("commands should execute successfully if committed", async () =>
        {
            let unitOfWork = new KnexPgUnitOfWork(dbConnectionFactory);
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

            let result = await db.executeQuery(`select * from products where id in (3, 4)`);
            Assert.strictEqual(result.rows.length, 2);
            Assert.deepEqual(result.rows, [{ id: 3, name: "milk" }, { id: 4, name: "pasta" }]);
        });

        test("no commands should execute successfully if rolledback", async () =>
        {
            let unitOfWork = new KnexPgUnitOfWork(dbConnectionFactory);
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

            let result = await db.executeQuery<any>(`select cast(count(*) as int) from products where id in (5, 6)`);
            Assert.strictEqual(result.rows[0].count, 0);
        });
    });

    suite("Object tree tests", () =>
    {
        suiteSetup(async () =>
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

        suiteTeardown(async () =>
        {
            await db.executeCommand(`
                drop table if exists orders;
                drop table if exists customers;
            `);
        });

        test("Produce single object tree from query", async () =>
        {
            let result = await db.executeQuery(`
                    select c.id as id, c.name as name, o.id as "orders:id", o.amount as "orders:amount"
                    from customers as c inner join orders as o on c.id = o.customer_id where c.id = 1
                `);

            let data = result.toObjectTree();
            Assert.deepEqual(data, [
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
        
        test("Produce multiple object trees from query", async () =>
        {
            let result = await db.executeQuery(`
                    select c.id as id, c.name as name, o.id as "orders:id", o.amount as "orders:amount"
                    from customers as c inner join orders as o on c.id = o.customer_id
                `);

            let data = result.toObjectTree();
            Assert.deepEqual(data, [
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
    
    suite("JsonB query tests", () =>
    {
        let createdOn = Date.now();
        
        suiteSetup(async () =>
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
            `, 1, { name: "txt1.txt", ext: "txt", createdOn: createdOn },
                2, { name: "import.xls", ext: "xls" });
        });
        
        suiteTeardown(async () =>
        {
            await db.executeCommand(`
                drop table if exists assets;
            `);
        });
        
        test("successfully retrieve jsonb data", async () =>
        {
            let result = await db.executeQuery("select * from assets where id = 1");
            Assert.strictEqual(result.rows.length, 1);
            Assert.deepEqual(result.rows, [
                {
                id: 1,
                body: {
                    name: "txt1.txt",
                    ext: "txt",
                    createdOn: createdOn
                }
                }]);
        });
    });
    
    suite("JsonB command tests", () =>
    {
        suiteSetup(async () =>
        {
            await db.executeCommand(`
                drop table if exists assets;
            
                create table assets(
                    id int primary key,
                    body jsonb
                );
            `); 
        });

        suiteTeardown(async () =>
        {
            await db.executeCommand(`
                drop table if exists assets;
            `);
        });
        
        test("successfully insert jsonb data", async () =>
        {
            await db.executeCommand(`
                insert into assets(id, body)
                    values(?,?), (?,?)
            `, 1, { name: "txt1.txt", ext: "txt" }, 2, { name: "import.xls", ext: "xls" });
            
            let result = await db.executeQuery("select * from assets");
            Assert.strictEqual(result.rows.length, 2);
            Assert.deepEqual(result.rows, [{ id: 1, body: { name: "txt1.txt", ext: "txt" } },
                { id: 2, body: { name: "import.xls", ext: "xls" } }]);
        });
    });
});