import postgresPool from '../config/postgres.config.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Initialize database schema
 * Run this once to create all necessary tables
 */
const initDatabase = async () => {
  try {
    console.log('\n🗄️  Initializing database schema...\n');

    // Read schema file
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');

    // Execute schema
    await postgresPool.query(schema);

    console.log('✅ Database schema initialized successfully!\n');
    console.log('Created tables:');
    console.log('  - users');
    console.log('  - user_settings');
    console.log('  - contacts');
    console.log('  - Indexes and triggers\n');

    // Test query
    const result = await postgresPool.query('SELECT COUNT(*) FROM users');
    console.log(`Current users in database: ${result.rows[0].count}\n`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
    
    // If tables already exist, that's okay
    if (error.message.includes('already exists')) {
      console.log('\n⚠️  Some tables already exist. This is normal if you\'ve run this before.\n');
      process.exit(0);
    } else {
      console.error('\nFull error:', error);
      process.exit(1);
    }
  }
};

initDatabase();

