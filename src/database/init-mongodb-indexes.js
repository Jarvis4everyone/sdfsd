/**
 * MongoDB Indexes Initialization Script
 * 
 * This script creates optimized indexes for all MongoDB collections
 * to ensure fast queries and scalability for 10k+ daily users.
 * 
 * Run: node src/database/init-mongodb-indexes.js
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
 * Initialize all MongoDB indexes
 */
async function initializeIndexes() {
  try {
    console.log('🔄 Initializing MongoDB indexes...\n');
    
    const db = await connectMongoDB();
    
    // ============================================
    // CHATS COLLECTION INDEXES
    // ============================================
    console.log('📁 Creating indexes for "chats" collection...');
    const chatsCollection = db.collection('chats');
    
    // Index 1: participants array (most common query - finding user's chats)
    await chatsCollection.createIndex(
      { participants: 1 },
      { 
        name: 'idx_participants',
        background: true,
        sparse: false
      }
    );
    console.log('   ✅ Index: participants');
    
    // Index 2: Composite index for finding specific chat between two users
    await chatsCollection.createIndex(
      { participants: 1, type: 1 },
      { 
        name: 'idx_participants_type',
        background: true
      }
    );
    console.log('   ✅ Index: participants + type');
    
    // Index 3: lastMessageAt for sorting chats by most recent message
    await chatsCollection.createIndex(
      { lastMessageAt: -1 },
      { 
        name: 'idx_lastMessageAt',
        background: true,
        sparse: true // Sparse because some chats may not have messages yet
      }
    );
    console.log('   ✅ Index: lastMessageAt (descending)');
    
    // Index 4: Composite index for efficient chat list queries
    await chatsCollection.createIndex(
      { participants: 1, lastMessageAt: -1 },
      { 
        name: 'idx_participants_lastMessageAt',
        background: true
      }
    );
    console.log('   ✅ Index: participants + lastMessageAt');
    
    // Index 5: createdAt for sorting new chats
    await chatsCollection.createIndex(
      { createdAt: -1 },
      { 
        name: 'idx_createdAt',
        background: true
      }
    );
    console.log('   ✅ Index: createdAt (descending)');
    
    // Index 6: updatedAt for tracking chat updates
    await chatsCollection.createIndex(
      { updatedAt: -1 },
      { 
        name: 'idx_updatedAt',
        background: true
      }
    );
    console.log('   ✅ Index: updatedAt (descending)');
    
    console.log('   ✅ All chat indexes created successfully\n');
    
    // ============================================
    // MESSAGES COLLECTION INDEXES
    // ============================================
    console.log('📁 Creating indexes for "messages" collection...');
    const messagesCollection = db.collection('messages');
    
    // Index 1: chatId (most common query - getting messages for a chat)
    await messagesCollection.createIndex(
      { chatId: 1 },
      { 
        name: 'idx_chatId',
        background: true
      }
    );
    console.log('   ✅ Index: chatId');
    
    // Index 2: Composite index for pagination (chatId + createdAt)
    await messagesCollection.createIndex(
      { chatId: 1, createdAt: 1 },
      { 
        name: 'idx_chatId_createdAt',
        background: true
      }
    );
    console.log('   ✅ Index: chatId + createdAt');
    
    // Index 3: Composite index for reverse pagination (chatId + createdAt descending)
    await messagesCollection.createIndex(
      { chatId: 1, createdAt: -1 },
      { 
        name: 'idx_chatId_createdAt_desc',
        background: true
      }
    );
    console.log('   ✅ Index: chatId + createdAt (descending)');
    
    // Index 4: senderId for finding messages by sender
    await messagesCollection.createIndex(
      { senderId: 1 },
      { 
        name: 'idx_senderId',
        background: true
      }
    );
    console.log('   ✅ Index: senderId');
    
    // Index 5: createdAt for time-based queries
    await messagesCollection.createIndex(
      { createdAt: -1 },
      { 
        name: 'idx_createdAt',
        background: true
      }
    );
    console.log('   ✅ Index: createdAt (descending)');
    
    // Index 6: messageType for filtering by message type
    await messagesCollection.createIndex(
      { messageType: 1 },
      { 
        name: 'idx_messageType',
        background: true,
        sparse: true
      }
    );
    console.log('   ✅ Index: messageType');
    
    // Index 7: Composite index for call messages (messageType + createdAt)
    await messagesCollection.createIndex(
      { messageType: 1, createdAt: -1 },
      { 
        name: 'idx_messageType_createdAt',
        background: true,
        partialFilterExpression: { messageType: 'call' }
      }
    );
    console.log('   ✅ Index: messageType + createdAt (for call messages)');
    
    // Index 8: readBy array for read receipt queries
    await messagesCollection.createIndex(
      { readBy: 1 },
      { 
        name: 'idx_readBy',
        background: true
      }
    );
    console.log('   ✅ Index: readBy');
    
    // Index 9: TTL index for auto-deleting old messages (optional - 1 year retention)
    // Uncomment if you want automatic cleanup of messages older than 1 year
    // await messagesCollection.createIndex(
    //   { createdAt: 1 },
    //   { 
    //     name: 'idx_ttl_createdAt',
    //     expireAfterSeconds: 31536000, // 1 year in seconds
    //     background: true
    //   }
    // );
    // console.log('   ✅ TTL Index: createdAt (1 year expiration)');
    
    console.log('   ✅ All message indexes created successfully\n');
    
    // ============================================
    // CALLS COLLECTION INDEXES
    // ============================================
    console.log('📁 Creating indexes for "calls" collection...');
    const callsCollection = db.collection('calls');
    
    // Index 1: roomId (unique identifier for call sessions)
    await callsCollection.createIndex(
      { roomId: 1 },
      { 
        name: 'idx_roomId',
        unique: true,
        background: true
      }
    );
    console.log('   ✅ Index: roomId (unique)');
    
    // Index 2: participants array (finding user's call history)
    await callsCollection.createIndex(
      { 'participants.userId': 1 },
      { 
        name: 'idx_participants_userId',
        background: true
      }
    );
    console.log('   ✅ Index: participants.userId');
    
    // Index 3: Composite index for call history queries
    await callsCollection.createIndex(
      { 'participants.userId': 1, updatedAt: -1 },
      { 
        name: 'idx_participants_updatedAt',
        background: true
      }
    );
    console.log('   ✅ Index: participants.userId + updatedAt');
    
    // Index 3: initiatorId for finding calls initiated by user
    await callsCollection.createIndex(
      { initiatorId: 1 },
      { 
        name: 'idx_initiatorId',
        background: true
      }
    );
    console.log('   ✅ Index: initiatorId');
    
    // Index 4: status for filtering calls by status
    await callsCollection.createIndex(
      { status: 1 },
      { 
        name: 'idx_status',
        background: true
      }
    );
    console.log('   ✅ Index: status');
    
    // Index 5: Composite index for status-based queries
    await callsCollection.createIndex(
      { 'participants.userId': 1, status: 1, updatedAt: -1 },
      { 
        name: 'idx_participants_status_updatedAt',
        background: true
      }
    );
    console.log('   ✅ Index: participants.userId + status + updatedAt');
    
    // Index 6: createdAt for time-based queries
    await callsCollection.createIndex(
      { createdAt: -1 },
      { 
        name: 'idx_createdAt',
        background: true
      }
    );
    console.log('   ✅ Index: createdAt (descending)');
    
    // Index 7: updatedAt for sorting by most recent
    await callsCollection.createIndex(
      { updatedAt: -1 },
      { 
        name: 'idx_updatedAt',
        background: true
      }
    );
    console.log('   ✅ Index: updatedAt (descending)');
    
    // Index 8: endedAt for completed calls
    await callsCollection.createIndex(
      { endedAt: -1 },
      { 
        name: 'idx_endedAt',
        background: true,
        sparse: true // Sparse because ongoing calls don't have endedAt
      }
    );
    console.log('   ✅ Index: endedAt (descending, sparse)');
    
    // Index 9: mediaType for filtering by call type
    await callsCollection.createIndex(
      { mediaType: 1 },
      { 
        name: 'idx_mediaType',
        background: true
      }
    );
    console.log('   ✅ Index: mediaType');
    
    // Index 10: TTL index for auto-deleting old call records (optional - 2 years retention)
    // Uncomment if you want automatic cleanup of calls older than 2 years
    // await callsCollection.createIndex(
    //   { endedAt: 1 },
    //   { 
    //     name: 'idx_ttl_endedAt',
    //     expireAfterSeconds: 63072000, // 2 years in seconds
    //     background: true,
    //     sparse: true
    //   }
    // );
    // console.log('   ✅ TTL Index: endedAt (2 years expiration)');
    
    console.log('   ✅ All call indexes created successfully\n');
    
    // ============================================
    // STATUS COLLECTION INDEXES
    // ============================================
    console.log('📁 Creating indexes for "status" collection...');
    const statusCollection = db.collection('status');
    
    // Index 1: userId (most common query - finding user's status)
    await statusCollection.createIndex(
      { userId: 1 },
      { 
        name: 'idx_status_userId',
        background: true,
        unique: false
      }
    );
    console.log('   ✅ Index: userId');
    
    // Index 2: createdAt for sorting by creation time
    await statusCollection.createIndex(
      { createdAt: -1 },
      { 
        name: 'idx_status_createdAt',
        background: true
      }
    );
    console.log('   ✅ Index: createdAt (descending)');
    
    // Index 3: updatedAt for sorting and filtering recent updates
    await statusCollection.createIndex(
      { updatedAt: -1 },
      { 
        name: 'idx_status_updatedAt',
        background: true
      }
    );
    console.log('   ✅ Index: updatedAt (descending)');
    
    // Index 4: Composite index for efficient status queries (userId + updatedAt)
    await statusCollection.createIndex(
      { userId: 1, updatedAt: -1 },
      { 
        name: 'idx_status_userId_updatedAt',
        background: true
      }
    );
    console.log('   ✅ Index: userId + updatedAt');
    
    // Index 5: statuses.timestamp for filtering expired status items
    await statusCollection.createIndex(
      { 'statuses.timestamp': 1 },
      { 
        name: 'idx_statuses_timestamp',
        background: true,
        sparse: true
      }
    );
    console.log('   ✅ Index: statuses.timestamp');
    
    // Index 6: statuses.id for finding specific status items
    await statusCollection.createIndex(
      { 'statuses.id': 1 },
      { 
        name: 'idx_statuses_id',
        background: true,
        sparse: true
      }
    );
    console.log('   ✅ Index: statuses.id');
    
    console.log('   ✅ All status indexes created successfully\n');
    
    // ============================================
    // VERIFICATION
    // ============================================
    console.log('🔍 Verifying indexes...\n');
    
    const chatIndexes = await chatsCollection.indexes();
    const messageIndexes = await messagesCollection.indexes();
    const callIndexes = await callsCollection.indexes();
    const statusIndexes = await statusCollection.indexes();
    
    console.log(`📊 Chats collection: ${chatIndexes.length} indexes`);
    console.log(`📊 Messages collection: ${messageIndexes.length} indexes`);
    console.log(`📊 Calls collection: ${callIndexes.length} indexes`);
    console.log(`📊 Status collection: ${statusIndexes.length} indexes`);
    
    console.log('\n✅ All indexes initialized successfully!');
    console.log('💡 Indexes are created in the background and may take a few minutes to build.');
    console.log('💡 You can monitor index build progress in MongoDB logs.\n');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error initializing indexes:', error);
    process.exit(1);
  }
}

// Run initialization
initializeIndexes();

