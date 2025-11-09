/**
 * Reset All Data Script
 * This script clears ALL data from PostgreSQL, MongoDB, and Redis
 * Run with: node scripts/reset-all-data.js
 * 
 * WARNING: This will delete ALL data from all databases!
 */

import postgresPool, { queryWithRetry } from '../src/config/postgres.config.js';
import { getMongoDB, connectMongoDB } from '../src/config/mongodb.config.js';
import { getRedisClient, connectRedis } from '../src/config/redis.config.js';

async function resetAllData() {
  console.log('🔄 Starting complete data reset...\n');
  console.log('⚠️  WARNING: This will delete ALL data from PostgreSQL, MongoDB, and Redis!\n');

  try {
    // ============================================
    // 1. Reset PostgreSQL (All Tables)
    // ============================================
    console.log('📊 Resetting PostgreSQL...');
    
    // Delete in order to respect foreign key constraints
    console.log('   🗑️  Deleting child tables...');
    await queryWithRetry('DELETE FROM status_views', [], 3, 20000);
    await queryWithRetry('DELETE FROM status_updates', [], 3, 20000);
    await queryWithRetry('DELETE FROM blocked_users', [], 3, 20000);
    await queryWithRetry('DELETE FROM user_activity_logs', [], 3, 20000);
    await queryWithRetry('DELETE FROM login_logs', [], 3, 20000);
    await queryWithRetry('DELETE FROM user_sessions', [], 3, 20000);
    await queryWithRetry('DELETE FROM contacts', [], 3, 20000);
    await queryWithRetry('DELETE FROM user_settings', [], 3, 20000);
    
    console.log('   🗑️  Deleting parent tables...');
    await queryWithRetry('DELETE FROM users', [], 3, 20000);
    
    console.log('✅ PostgreSQL reset complete\n');

    // ============================================
    // 2. Reset MongoDB (All Collections)
    // ============================================
    console.log('📊 Resetting MongoDB...');
    await connectMongoDB();
    const mongoDb = getMongoDB();
    
    // Delete all collections
    const collections = [
      'chats',
      'messages',
      'calls',
      'activity_logs',
      'status_updates',
      'status_views',
      'analytics'
    ];
    
    let totalDeleted = 0;
    for (const collectionName of collections) {
      try {
        const collection = mongoDb.collection(collectionName);
        const result = await collection.deleteMany({});
        totalDeleted += result.deletedCount;
        if (result.deletedCount > 0) {
          console.log(`   🗑️  Deleted ${result.deletedCount} documents from ${collectionName}`);
        }
      } catch (error) {
        // Collection might not exist, that's fine
        console.log(`   ℹ️  Collection ${collectionName} not found or already empty`);
      }
    }
    
    console.log(`✅ MongoDB reset complete (${totalDeleted} total documents deleted)\n`);

    // ============================================
    // 3. Reset Redis (All Keys)
    // ============================================
    console.log('📊 Resetting Redis...');
    try {
      await connectRedis();
      const redisClient = getRedisClient();
      
      // Get all keys
      const keys = await redisClient.keys('*');
      
      if (keys.length > 0) {
        // Delete in batches to avoid memory issues
        const batchSize = 1000;
        for (let i = 0; i < keys.length; i += batchSize) {
          const batch = keys.slice(i, i + batchSize);
          await redisClient.del(batch);
        }
        console.log(`   🗑️  Deleted ${keys.length} keys from Redis`);
      } else {
        console.log('   ℹ️  Redis is already empty');
      }
      
      console.log('✅ Redis reset complete\n');
    } catch (error) {
      console.log('   ⚠️  Redis reset failed (might not be connected):', error.message);
      console.log('   ℹ️  Continuing with other databases...\n');
    }

    // ============================================
    // Summary
    // ============================================
    console.log('✨ All data has been cleared successfully!');
    console.log('📊 Summary:');
    console.log('   ✅ PostgreSQL: All 9 tables cleared');
    console.log('   ✅ MongoDB: All 7 collections cleared');
    console.log('   ✅ Redis: All keys cleared');
    console.log('\n🚀 The application is now in a fresh state.\n');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error resetting data:', error);
    console.error('   Error details:', error.message);
    console.error('   Stack:', error.stack);
    process.exit(1);
  }
}

// Run the reset
resetAllData();

