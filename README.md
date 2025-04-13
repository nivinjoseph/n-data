# @nivinjoseph/n-data

A comprehensive data access library for Node.js applications, built on top of Knex.js with PostgreSQL support. This library provides a robust set of tools for database operations, caching, file storage, and distributed locking.

## Features

- **Database Operations**
  - PostgreSQL database access with Knex.js
  - Read and write database operations
  - Unit of Work pattern implementation
  - Database migrations
  - Connection management

- **Caching**
  - In-memory caching
  - Redis-based caching
  - Cache service abstraction

- **File Storage**
  - S3 file storage integration
  - File metadata management
  - Secure file handling

- **Distributed Systems**
  - Distributed locking mechanism
  - Redis-based distributed locks
  - Lock management and configuration

## Installation

```bash
npm install @nivinjoseph/n-data

or 

yarn add @nivinjoseph/n-data
```

## Requirements

- Node.js >= 20.10
- PostgreSQL database
- Redis (for distributed locking and caching features)

## Usage

### Database Operations

```typescript
import { KnexPgDb, DbConnectionConfig, KnexPgDbConnectionFactory } from '@nivinjoseph/n-data';

// Configure database connection
const config: DbConnectionConfig = {
    host: 'localhost',
    port: 5432,
    database: 'mydb',
    user: 'postgres',
    password: 'password'
};

// Create database connection factory
const connectionFactory = new KnexPgDbConnectionFactory(config);

// Create database instance
const db = new KnexPgDb(connectionFactory);

// Execute queries with type safety
const result = await db.executeQuery<{id: number; name: string; age: number;}>('SELECT * FROM users WHERE id = ?', 1);

// Execute commands
await db.executeCommand('INSERT INTO users (name, age) VALUES (?, ?)', 'John', 30);
await db.executeCommand('UPDATE users SET age = ? WHERE name = ?', 31, 'John');
await db.executeCommand('DELETE FROM users WHERE name = ?', 'John');
```

### Unit of Work

```typescript
import { UnitOfWork, KnexPgUnitOfWork } from '@nivinjoseph/n-data';

// Create unit of work
const unitOfWork = new KnexPgUnitOfWork(connectionFactory);

// Register callbacks for commit and rollback
unitOfWork.onCommit(async () => {
    console.log('Transaction committed successfully');
});

unitOfWork.onRollback(async () => {
    console.log('Transaction rolled back');
});

try {
    // Execute commands within the transaction
    await db.executeCommandWithinUnitOfWork(unitOfWork, 
        'INSERT INTO products(id, name) VALUES(?, ?)', 
        1, "milk");
    
    await db.executeCommandWithinUnitOfWork(unitOfWork,
        'INSERT INTO products(id, name) VALUES(?, ?)',
        2, "pasta");
    
    // Commit if all operations succeed
    await unitOfWork.commit();
} catch (error) {
    // Rollback if any operation fails
    await unitOfWork.rollback();
}
```

### Caching

```typescript
import { CacheService, RedisCacheService } from '@nivinjoseph/n-data';
import { Duration } from '@nivinjoseph/n-util';
import { createClient } from 'redis';

// Create Redis client
const redisClient = await createClient({}).connect();

// Create cache service
const cacheService = new RedisCacheService(redisClient);

// Store values with different types
await cacheService.store('number-key', 42);
await cacheService.store('string-key', 'hello world');
await cacheService.store('boolean-key', true);
await cacheService.store('object-key', { foo: { bar: null } });

// Store with expiration
await cacheService.store('expiring-key', 'value', Duration.fromSeconds(30));

// Retrieve values
const number = await cacheService.retrieve<number>('number-key');
const string = await cacheService.retrieve<string>('string-key');
const boolean = await cacheService.retrieve<boolean>('boolean-key');
const object = await cacheService.retrieve<{ foo: { bar: null } }>('object-key');

// Check if key exists
const exists = await cacheService.exists('number-key');

// Remove values
await cacheService.remove('number-key');

// Cleanup
await cacheService.dispose();
await redisClient.quit();
```

### File Storage

```typescript
import { S3FileStore, S3FileStoreConfig } from '@nivinjoseph/n-data';

// Configure S3 storage
const config: S3FileStoreConfig = {
    region: 'us-east-1',
    bucket: 'my-bucket',
    accessKeyId: 'your-access-key',
    secretAccessKey: 'your-secret-key'
};

// Create file store
const fileStore = new S3FileStore(config);

// Store and retrieve files
await fileStore.store('path/to/file.txt', buffer);
const file = await fileStore.retrieve('path/to/file.txt');
```

### Distributed Locking

```typescript
import { RedisDistributedLockService, DistributedLockConfig } from '@nivinjoseph/n-data';
import { Duration } from '@nivinjoseph/n-util';

// Configure distributed lock
const config: DistributedLockConfig = {
    host: 'localhost',
    port: 6379,
    retryCount: 3,
    retryDelay: 1000
};

// Create lock service
const lockService = new RedisDistributedLockService(config);

// Acquire and release locks
const lock = await lockService.lock('resource-key', Duration.fromSeconds(30));
try {
    // Perform locked operation
} finally {
    await lock.release();
}
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
