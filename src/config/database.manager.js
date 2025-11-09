import { testPostgresConnection } from './postgres.config.js';
import { connectMongoDB } from './mongodb.config.js';
import { connectRedis } from './redis.config.js';

/**
 * Database Manager - Initializes all database connections
 * Call this at application startup
 */
export const initializeDatabases = async () => {
  console.log('\n🚀 Initializing database connections...\n');

  const results = {
    postgres: false,
    mongodb: false,
    redis: false,
  };

  // Initialize PostgreSQL
  try {
    results.postgres = await testPostgresConnection();
  } catch (error) {
    console.error('PostgreSQL initialization failed:', error.message);
  }

  // Initialize MongoDB
  try {
    await connectMongoDB();
    results.mongodb = true;
  } catch (error) {
    console.error('MongoDB initialization failed:', error.message);
  }

  // Initialize Redis
  try {
    await connectRedis();
    results.redis = true;
  } catch (error) {
    console.error('Redis initialization failed:', error.message);
  }

  console.log('\n📊 Database Connection Status:');
  console.log(`   PostgreSQL: ${results.postgres ? '✅' : '❌'}`);
  console.log(`   MongoDB: ${results.mongodb ? '✅' : '❌'}`);
  console.log(`   Redis: ${results.redis ? '✅' : '❌'}\n`);

  return results;
};

export default initializeDatabases;

