/**
 * Complete Database Initialization Script
 * 
 * This script initializes both PostgreSQL and MongoDB databases
 * with proper schemas and indexes for optimal performance.
 * 
 * Run: node src/database/init-all.js
 */

import { connectMongoDB } from '../config/mongodb.config.js';
import postgresPool from '../config/postgres.config.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';
import { existsSync } from 'fs';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envPaths = [
  join(__dirname, '..', '..', '.env'),
  join(__dirname, '..', '..', '..', '.env'),
  '.env',
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

/**
 * Initialize PostgreSQL schema
 */
async function initPostgreSQL() {
  try {
    console.log('\n🗄️  Initializing PostgreSQL schema...\n');

    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');

    await postgresPool.query(schema);

    console.log('✅ PostgreSQL schema initialized successfully!');
    console.log('   Created tables:');
    console.log('     - users (with activity tracking)');
    console.log('     - user_settings (enhanced)');
    console.log('     - contacts (with favorites)');
    console.log('     - user_sessions (multi-device support)');
    console.log('     - login_logs (authentication tracking)');
    console.log('     - user_activity_logs (comprehensive tracking)');
    console.log('     - status_updates (prepared for future)');
    console.log('     - status_views (prepared for future)');
    console.log('     - blocked_users');
    console.log('   Created indexes, triggers, and views\n');
  } catch (error) {
    if (error.message.includes('already exists')) {
      console.log('⚠️  PostgreSQL tables already exist (this is normal)\n');
    } else {
      throw error;
    }
  }
}

/**
 * Initialize MongoDB schema and indexes
 */
async function initMongoDB() {
  try {
    // Import and run the comprehensive MongoDB schema initialization
    const { initializeMongoDBSchema } = await import('./init-mongodb-schema.js');
    await initializeMongoDBSchema();
  } catch (error) {
    console.error('❌ MongoDB schema initialization error:', error.message);
    throw error;
  }
}

/**
 * Main initialization function
 */
async function initializeAll() {
  try {
    console.log('🚀 Starting complete database initialization...\n');
    
    await initPostgreSQL();
    await initMongoDB();
    
    console.log('✅ All databases initialized successfully!');
    console.log('\n📊 Summary:');
    console.log('   - PostgreSQL: 9 tables, comprehensive indexes, triggers, and views');
    console.log('   - MongoDB: 7 collections with optimized indexes');
    console.log('   - Activity tracking: Enabled for all user actions');
    console.log('   - Session management: Multi-device support ready');
    console.log('   - Status support: Schema prepared for future feature');
    console.log('\n💡 Note: Indexes are built in the background and may take a few minutes.');
    console.log('💡 You can monitor progress in MongoDB logs.');
    console.log('💡 All user activities are now being tracked and logged.\n');
    
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Initialization failed:', error);
    process.exit(1);
  }
}

initializeAll();

