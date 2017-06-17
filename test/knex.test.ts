// import * as Assert from "assert";
// import * as Knex from "knex";
// import { given } from "n-defensive";


// suite.skip("Knex tests", () =>
// {
//     let knex: Knex;
    
//     suiteSetup(() =>
//     {
//         let config = {
//             client: "pg",
//             pool: {
//                 min: 2,
//                 max: 10
//             },
//             connection: {
//                 host: "localhost",
//                 port: "5432",
//                 database: "testdb",
//                 user: "postgres",
//                 password: "P0stgr3s"
//             },
//             // debug: true
//         };
        
//         knex = Knex(config);
//     });
    
//     suiteTeardown(() =>
//     {
//         knex.destroy();
//     });
    
    
//     test.skip("ensure connection is created", () =>
//     {
//         given(knex, "knex").ensureHasValue();
//         Assert.ok(true);
//     });
    
//     test("simple select async", async () =>
//     {
//         let result = await knex.raw("select * from products where id = ? and name = ?", [1, "cheese"]);
//         console.log(result.rows);
//     });
    
//     test.skip("simple select callback", (done) =>
//     {
//         knex.raw("select * from products where name = 'cheese'").asCallback((err, result) =>
//         {
//             if (err)
//                 console.log(err);
//             else
//                 console.log(result.rows);
            
//             done();
//         });
//     });
    
//     test.skip("select using method", async () =>
//     {
//         let result = await knex.select().from("products");
//         console.log(result);
//     });
// });


