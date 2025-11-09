/**
 * MongoDB Schema Initialization Script
 * 
 * Creates comprehensive collections with proper structure for:
 * - Chats with enhanced metadata
 * - Messages with read receipts tracking
 * - Calls with analytics
 * - Activity logs
 * - Status updates (prepared for future)
 * 
 * Run: node src/database/init-mongodb-schema.js
 */

import { connectMongoDB } from '../config/mongodb.config.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
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
 * Initialize MongoDB collections with validation schemas
 * Exported for use in init-all.js
 */
export async function initializeMongoDBSchema() {
  try {
    console.log('🔄 Initializing MongoDB collections and indexes...\n');
    
    const db = await connectMongoDB();
    
    // ============================================
    // CHATS COLLECTION - Enhanced Schema
    // ============================================
    console.log('📁 Setting up "chats" collection...');
    const chatsCollection = db.collection('chats');
    
    // Create indexes
    await chatsCollection.createIndex({ participants: 1 }, { name: 'idx_participants', background: true });
    await chatsCollection.createIndex({ participants: 1, type: 1 }, { name: 'idx_participants_type', background: true });
    await chatsCollection.createIndex({ lastMessageAt: -1 }, { name: 'idx_lastMessageAt', background: true, sparse: true });
    await chatsCollection.createIndex({ participants: 1, lastMessageAt: -1 }, { name: 'idx_participants_lastMessageAt', background: true });
    await chatsCollection.createIndex({ createdAt: -1 }, { name: 'idx_createdAt', background: true });
    await chatsCollection.createIndex({ updatedAt: -1 }, { name: 'idx_updatedAt', background: true });
    await chatsCollection.createIndex({ archivedBy: 1 }, { name: 'idx_archivedBy', background: true, sparse: true });
    await chatsCollection.createIndex({ pinnedBy: 1 }, { name: 'idx_pinnedBy', background: true, sparse: true });
    console.log('   ✅ Chats collection ready\n');
    
    // ============================================
    // MESSAGES COLLECTION - Enhanced Schema
    // ============================================
    console.log('📁 Setting up "messages" collection...');
    const messagesCollection = db.collection('messages');
    
    // Create indexes
    await messagesCollection.createIndex({ chatId: 1 }, { name: 'idx_chatId', background: true });
    await messagesCollection.createIndex({ chatId: 1, createdAt: 1 }, { name: 'idx_chatId_createdAt', background: true });
    await messagesCollection.createIndex({ chatId: 1, createdAt: -1 }, { name: 'idx_chatId_createdAt_desc', background: true });
    await messagesCollection.createIndex({ senderId: 1 }, { name: 'idx_senderId', background: true });
    await messagesCollection.createIndex({ createdAt: -1 }, { name: 'idx_createdAt', background: true });
    await messagesCollection.createIndex({ messageType: 1 }, { name: 'idx_messageType', background: true, sparse: true });
    await messagesCollection.createIndex({ messageType: 1, createdAt: -1 }, { name: 'idx_messageType_createdAt', background: true, partialFilterExpression: { messageType: 'call' } });
    await messagesCollection.createIndex({ readBy: 1 }, { name: 'idx_readBy', background: true });
    await messagesCollection.createIndex({ 'readReceipts.userId': 1 }, { name: 'idx_readReceipts_userId', background: true, sparse: true });
    await messagesCollection.createIndex({ deletedAt: 1 }, { name: 'idx_deletedAt', background: true, sparse: true });
    await messagesCollection.createIndex({ editedAt: 1 }, { name: 'idx_editedAt', background: true, sparse: true });
    console.log('   ✅ Messages collection ready\n');
    
    // ============================================
    // CALLS COLLECTION - Enhanced Schema
    // ============================================
    console.log('📁 Setting up "calls" collection...');
    const callsCollection = db.collection('calls');
    
    // Drop existing unique index if it exists and has duplicates
    try {
      const indexes = await callsCollection.indexes();
      const roomIdIndex = indexes.find(idx => idx.name === 'idx_roomId');
      if (roomIdIndex) {
        console.log('   ⚠️  Dropping existing idx_roomId index to fix duplicates...');
        await callsCollection.dropIndex('idx_roomId');
      }
    } catch (error) {
      // Index doesn't exist, that's fine
    }
    
    // Remove duplicate roomIds before creating unique index
    console.log('   🔍 Checking for duplicate roomIds...');
    const duplicates = await callsCollection.aggregate([
      { $group: { _id: '$roomId', count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } }
    ]).toArray();
    
    if (duplicates.length > 0) {
      console.log(`   ⚠️  Found ${duplicates.length} duplicate roomIds, removing duplicates...`);
      for (const dup of duplicates) {
        const docs = await callsCollection.find({ roomId: dup._id }).sort({ createdAt: -1 }).toArray();
        // Keep the most recent one, delete others
        if (docs.length > 1) {
          const idsToDelete = docs.slice(1).map(d => d._id);
          await callsCollection.deleteMany({ _id: { $in: idsToDelete } });
        }
      }
      console.log('   ✅ Duplicates removed');
    }
    
    // Create indexes
    await callsCollection.createIndex({ roomId: 1 }, { name: 'idx_roomId', unique: true, background: true });
    await callsCollection.createIndex({ 'participants.userId': 1 }, { name: 'idx_participants_userId', background: true });
    await callsCollection.createIndex({ 'participants.userId': 1, updatedAt: -1 }, { name: 'idx_participants_updatedAt', background: true });
    await callsCollection.createIndex({ initiatorId: 1 }, { name: 'idx_initiatorId', background: true });
    await callsCollection.createIndex({ status: 1 }, { name: 'idx_status', background: true });
    await callsCollection.createIndex({ 'participants.userId': 1, status: 1, updatedAt: -1 }, { name: 'idx_participants_status_updatedAt', background: true });
    await callsCollection.createIndex({ createdAt: -1 }, { name: 'idx_createdAt', background: true });
    await callsCollection.createIndex({ updatedAt: -1 }, { name: 'idx_updatedAt', background: true });
    await callsCollection.createIndex({ endedAt: -1 }, { name: 'idx_endedAt', background: true, sparse: true });
    await callsCollection.createIndex({ mediaType: 1 }, { name: 'idx_mediaType', background: true });
    await callsCollection.createIndex({ 'analytics.quality': 1 }, { name: 'idx_analytics_quality', background: true, sparse: true });
    console.log('   ✅ Calls collection ready\n');
    
    // ============================================
    // ACTIVITY LOGS COLLECTION
    // ============================================
    console.log('📁 Setting up "activity_logs" collection...');
    const activityLogsCollection = db.collection('activity_logs');
    
    // Create indexes
    await activityLogsCollection.createIndex({ userId: 1 }, { name: 'idx_userId', background: true });
    await activityLogsCollection.createIndex({ activityType: 1 }, { name: 'idx_activityType', background: true });
    await activityLogsCollection.createIndex({ createdAt: -1 }, { name: 'idx_createdAt', background: true });
    await activityLogsCollection.createIndex({ userId: 1, createdAt: -1 }, { name: 'idx_userId_createdAt', background: true });
    await activityLogsCollection.createIndex({ userId: 1, activityType: 1, createdAt: -1 }, { name: 'idx_userId_type_createdAt', background: true });
    
    // TTL index for auto-cleanup (90 days retention)
    await activityLogsCollection.createIndex(
      { createdAt: 1 },
      { 
        name: 'idx_ttl_createdAt',
        expireAfterSeconds: 7776000, // 90 days
        background: true
      }
    );
    console.log('   ✅ Activity logs collection ready\n');
    
    // ============================================
    // STATUS UPDATES COLLECTION (Prepared for future)
    // ============================================
    console.log('📁 Setting up "status_updates" collection...');
    const statusUpdatesCollection = db.collection('status_updates');
    
    // Drop old expiresAt index if it exists (to replace with TTL index)
    try {
      const indexes = await statusUpdatesCollection.indexes();
      const oldExpiresIndex = indexes.find(idx => 
        idx.name === 'idx_expiresAt' || 
        (idx.key && idx.key.expiresAt && idx.name !== 'idx_ttl_expiresAt')
      );
      if (oldExpiresIndex) {
        console.log('   ⚠️  Dropping old expiresAt index to replace with TTL index...');
        await statusUpdatesCollection.dropIndex(oldExpiresIndex.name);
      }
    } catch (error) {
      // Index doesn't exist, that's fine
    }
    
    // Create indexes
    await statusUpdatesCollection.createIndex({ userId: 1 }, { name: 'idx_userId', background: true });
    await statusUpdatesCollection.createIndex({ createdAt: -1 }, { name: 'idx_createdAt', background: true });
    await statusUpdatesCollection.createIndex({ userId: 1, createdAt: -1 }, { name: 'idx_userId_createdAt', background: true });
    await statusUpdatesCollection.createIndex({ type: 1 }, { name: 'idx_type', background: true });
    await statusUpdatesCollection.createIndex({ privacy: 1 }, { name: 'idx_privacy', background: true });
    
    // TTL index for auto-deleting expired statuses (24 hours)
    // Check if TTL index already exists
    try {
      const indexes = await statusUpdatesCollection.indexes();
      const ttlIndex = indexes.find(idx => idx.name === 'idx_ttl_expiresAt');
      if (!ttlIndex) {
        await statusUpdatesCollection.createIndex(
          { expiresAt: 1 },
          { 
            name: 'idx_ttl_expiresAt',
            expireAfterSeconds: 0, // Delete immediately when expiresAt is reached
            background: true
          }
        );
      } else {
        console.log('   ℹ️  TTL index already exists');
      }
    } catch (error) {
      // If there's still a conflict, try to drop all expiresAt indexes and recreate
      console.log('   ⚠️  Handling index conflict, recreating TTL index...');
      try {
        const indexes = await statusUpdatesCollection.indexes();
        for (const idx of indexes) {
          if (idx.key && idx.key.expiresAt) {
            await statusUpdatesCollection.dropIndex(idx.name).catch(() => {});
          }
        }
        await statusUpdatesCollection.createIndex(
          { expiresAt: 1 },
          { 
            name: 'idx_ttl_expiresAt',
            expireAfterSeconds: 0,
            background: true
          }
        );
      } catch (retryError) {
        console.log('   ⚠️  Could not create TTL index, continuing...');
      }
    }
    console.log('   ✅ Status updates collection ready\n');
    
    // ============================================
    // STATUS VIEWS COLLECTION
    // ============================================
    console.log('📁 Setting up "status_views" collection...');
    const statusViewsCollection = db.collection('status_views');
    
    // Create indexes
    await statusViewsCollection.createIndex({ statusId: 1 }, { name: 'idx_statusId', background: true });
    await statusViewsCollection.createIndex({ viewerId: 1 }, { name: 'idx_viewerId', background: true });
    await statusViewsCollection.createIndex({ statusId: 1, viewerId: 1 }, { name: 'idx_statusId_viewerId', unique: true, background: true });
    await statusViewsCollection.createIndex({ viewedAt: -1 }, { name: 'idx_viewedAt', background: true });
    console.log('   ✅ Status views collection ready\n');
    
    // ============================================
    // ANALYTICS COLLECTION (For aggregated stats)
    // ============================================
    console.log('📁 Setting up "analytics" collection...');
    const analyticsCollection = db.collection('analytics');
    
    // Create indexes
    await analyticsCollection.createIndex({ date: -1 }, { name: 'idx_date', background: true });
    await analyticsCollection.createIndex({ metricType: 1, date: -1 }, { name: 'idx_metricType_date', background: true });
    await analyticsCollection.createIndex({ userId: 1, date: -1 }, { name: 'idx_userId_date', background: true, sparse: true });
    
    // TTL index for old analytics (1 year retention)
    await analyticsCollection.createIndex(
      { date: 1 },
      { 
        name: 'idx_ttl_date',
        expireAfterSeconds: 31536000, // 1 year
        background: true
      }
    );
    console.log('   ✅ Analytics collection ready\n');
    
    // ============================================
    // VERIFICATION
    // ============================================
    console.log('🔍 Verifying collections and indexes...\n');
    
    const collections = [
      'chats',
      'messages',
      'calls',
      'activity_logs',
      'status_updates',
      'status_views',
      'analytics'
    ];
    
    for (const collectionName of collections) {
      const collection = db.collection(collectionName);
      const indexes = await collection.indexes();
      console.log(`   📊 ${collectionName}: ${indexes.length} indexes`);
    }
    
    console.log('\n✅ All MongoDB collections and indexes initialized successfully!');
    console.log('💡 Indexes are created in the background and may take a few minutes to build.');
    console.log('💡 TTL indexes will automatically clean up old data.\n');
    
    return true;
  } catch (error) {
    console.error('❌ Error initializing MongoDB schema:', error);
    throw error;
  }
}

// Run initialization if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  initializeMongoDBSchema()
    .then(() => {
      console.log('\n✅ MongoDB schema initialization complete!\n');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ Initialization failed:', error);
      process.exit(1);
    });
}

