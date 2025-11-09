/**
 * Reset MongoDB Only
 * This script clears ALL data from MongoDB collections
 * Run with: node scripts/reset-mongodb.js
 * 
 * WARNING: This will delete ALL data from all MongoDB collections!
 */

import { getMongoDB, connectMongoDB } from '../src/config/mongodb.config.js';

async function resetMongoDB() {
  console.log('🔄 Resetting MongoDB...\n');
  console.log('⚠️  WARNING: This will delete ALL data from all MongoDB collections!\n');

  try {
    await connectMongoDB();
    const mongoDb = getMongoDB();
    
    // All MongoDB collections based on schema
    const collections = [
      { name: 'chats', description: 'Chat conversations' },
      { name: 'messages', description: 'Chat messages' },
      { name: 'calls', description: 'Call sessions' },
      { name: 'activity_logs', description: 'Activity logs' },
      { name: 'status_updates', description: 'Status updates' },
      { name: 'status_views', description: 'Status views' },
      { name: 'analytics', description: 'Analytics data' }
    ];
    
    let totalDeleted = 0;
    console.log('📊 Deleting data from all collections...\n');
    
    for (const { name, description } of collections) {
      try {
        const collection = mongoDb.collection(name);
        const result = await collection.deleteMany({});
        totalDeleted += result.deletedCount;
        
        if (result.deletedCount > 0) {
          console.log(`   🗑️  ${name}: Deleted ${result.deletedCount} documents (${description})`);
        } else {
          console.log(`   ℹ️  ${name}: Already empty (${description})`);
        }
      } catch (error) {
        // Collection might not exist, that's fine
        console.log(`   ⚠️  ${name}: Error or collection doesn't exist - ${error.message}`);
      }
    }
    
    console.log(`\n✅ MongoDB reset complete!`);
    console.log(`📊 Total documents deleted: ${totalDeleted}`);
    console.log(`📊 Collections processed: ${collections.length}\n`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error resetting MongoDB:', error);
    console.error('   Error details:', error.message);
    process.exit(1);
  }
}

resetMongoDB();

