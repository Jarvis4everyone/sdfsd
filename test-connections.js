import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { testPostgresConnection } from './src/config/postgres.config.js';
import { connectMongoDB } from './src/config/mongodb.config.js';
import { connectRedis } from './src/config/redis.config.js';

// Get current directory (ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try multiple possible .env file locations
const envPaths = [
  join(__dirname, '.env'),           // backend/.env
  join(__dirname, '..', '.env'),     // root/.env
  '.env',                            // current working directory
];

let envLoaded = false;
for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
    console.log(`✅ Loaded .env from: ${envPath}\n`);
    envLoaded = true;
    break;
  }
}

if (!envLoaded) {
  console.error('❌ ERROR: .env file not found!');
  console.error('   Searched in:');
  envPaths.forEach(path => console.error(`   - ${path}`));
  console.error('\n   Please create a .env file in the backend directory.');
  console.error('   You can copy env.example to .env as a starting point.\n');
  process.exit(1);
}

console.log('\n🔍 Testing Database Connections...\n');
console.log('=' .repeat(50));

// Debug: Show which env vars are loaded (without showing passwords)
console.log('\n📋 Environment Check:');
console.log(`   POSTGRES_HOST: ${process.env.POSTGRES_HOST || 'not set'}`);
console.log(`   POSTGRES_URL: ${process.env.POSTGRES_URL ? 'set (hidden)' : 'not set'}`);
console.log(`   MONGO_URI: ${process.env.MONGO_URI ? 'set (hidden)' : 'not set'}`);
console.log(`   MONGO_HOST: ${process.env.MONGO_HOST || 'not set'}`);
console.log(`   REDIS_URL: ${process.env.REDIS_URL ? 'set (hidden)' : 'not set'}`);
console.log(`   REDIS_HOST: ${process.env.REDIS_HOST || 'not set'}`);
console.log('');

// Test PostgreSQL
console.log('\n1️⃣ Testing PostgreSQL Connection...');
try {
  const postgresOk = await testPostgresConnection();
  if (postgresOk) {
    console.log('   ✅ PostgreSQL: Connected successfully\n');
  } else {
    console.log('   ❌ PostgreSQL: Connection failed\n');
  }
} catch (error) {
  console.log(`   ❌ PostgreSQL Error: ${error.message}\n`);
}

// Test MongoDB
console.log('2️⃣ Testing MongoDB Connection...');
try {
  await connectMongoDB();
  console.log('   ✅ MongoDB: Connected successfully\n');
} catch (error) {
  console.log(`   ❌ MongoDB Error: ${error.message}\n`);
  console.log('   💡 Tip: Check your MONGO_URI format');
  console.log('      Example: mongodb+srv://user:pass@cluster.mongodb.net/database\n');
}

// Test Redis
console.log('3️⃣ Testing Redis Connection...');
try {
  await connectRedis();
  console.log('   ✅ Redis: Connected successfully\n');
} catch (error) {
  console.log(`   ❌ Redis Error: ${error.message}\n`);
  console.log('   💡 Tip: Check your REDIS_URL format');
  console.log('      Example: redis://:password@host:port\n');
}

console.log('=' .repeat(50));
console.log('\n✨ Connection test complete!\n');

// Exit process
process.exit(0);

