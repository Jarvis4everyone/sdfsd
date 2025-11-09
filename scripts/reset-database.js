/**
 * Reset Database Only (PostgreSQL)
 * This script clears ALL data from PostgreSQL database
 * Run with: node scripts/reset-database.js
 * 
 * WARNING: This will delete ALL data from all PostgreSQL tables!
 */

import postgresPool, { queryWithRetry } from '../src/config/postgres.config.js';

async function resetDatabase() {
  console.log('🔄 Resetting PostgreSQL database...\n');
  console.log('⚠️  WARNING: This will delete ALL data from all tables!\n');

  try {
    // Delete in order to respect foreign key constraints
    // Start with child tables first, then parent tables
    
    console.log('📊 Deleting data from all tables...\n');
    
    // Child tables (with foreign keys) - delete first
    console.log('   🗑️  Deleting status_views...');
    await queryWithRetry('DELETE FROM status_views', [], 3, 20000);
    
    console.log('   🗑️  Deleting status_updates...');
    await queryWithRetry('DELETE FROM status_updates', [], 3, 20000);
    
    console.log('   🗑️  Deleting blocked_users...');
    await queryWithRetry('DELETE FROM blocked_users', [], 3, 20000);
    
    console.log('   🗑️  Deleting user_activity_logs...');
    await queryWithRetry('DELETE FROM user_activity_logs', [], 3, 20000);
    
    console.log('   🗑️  Deleting login_logs...');
    await queryWithRetry('DELETE FROM login_logs', [], 3, 20000);
    
    console.log('   🗑️  Deleting user_sessions...');
    await queryWithRetry('DELETE FROM user_sessions', [], 3, 20000);
    
    console.log('   🗑️  Deleting contacts...');
    await queryWithRetry('DELETE FROM contacts', [], 3, 20000);
    
    console.log('   🗑️  Deleting user_settings...');
    await queryWithRetry('DELETE FROM user_settings', [], 3, 20000);
    
    // Parent table (users) - delete last
    console.log('   🗑️  Deleting users...');
    await queryWithRetry('DELETE FROM users', [], 3, 20000);
    
    // Reset sequences (if any exist)
    console.log('\n📊 Resetting sequences...');
    try {
      await queryWithRetry('ALTER SEQUENCE IF EXISTS contacts_id_seq RESTART WITH 1', [], 3, 20000);
      await queryWithRetry('ALTER SEQUENCE IF EXISTS user_settings_id_seq RESTART WITH 1', [], 3, 20000);
      await queryWithRetry('ALTER SEQUENCE IF EXISTS users_id_seq RESTART WITH 1', [], 3, 20000);
      await queryWithRetry('ALTER SEQUENCE IF EXISTS user_sessions_id_seq RESTART WITH 1', [], 3, 20000);
      await queryWithRetry('ALTER SEQUENCE IF EXISTS login_logs_id_seq RESTART WITH 1', [], 3, 20000);
      await queryWithRetry('ALTER SEQUENCE IF EXISTS user_activity_logs_id_seq RESTART WITH 1', [], 3, 20000);
      await queryWithRetry('ALTER SEQUENCE IF EXISTS status_updates_id_seq RESTART WITH 1', [], 3, 20000);
      await queryWithRetry('ALTER SEQUENCE IF EXISTS status_views_id_seq RESTART WITH 1', [], 3, 20000);
      await queryWithRetry('ALTER SEQUENCE IF EXISTS blocked_users_id_seq RESTART WITH 1', [], 3, 20000);
    } catch (seqError) {
      // Sequences might not exist (UUID primary keys don't use sequences)
      console.log('   ℹ️  No sequences to reset (using UUID primary keys)');
    }
    
    console.log('\n✅ PostgreSQL database reset complete!');
    console.log('📊 All data has been deleted from the following tables:');
    console.log('   - users');
    console.log('   - user_settings');
    console.log('   - contacts');
    console.log('   - user_sessions');
    console.log('   - login_logs');
    console.log('   - user_activity_logs');
    console.log('   - status_updates');
    console.log('   - status_views');
    console.log('   - blocked_users\n');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error resetting database:', error);
    console.error('   Error details:', error.message);
    process.exit(1);
  }
}

resetDatabase();

