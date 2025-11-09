# Database Schema Documentation

This document describes the complete database schema for the WhatsApp Clone application, optimized for 10k+ daily users.

## Overview

The application uses a **hybrid database architecture**:
- **PostgreSQL**: User authentication, profiles, settings, contacts
- **MongoDB**: Chats, messages, calls (high-volume, document-based data)
- **Redis**: Caching, real-time presence, unread counts

---

## PostgreSQL Schema

### Users Table
Stores user authentication, profile, and presence data.

```sql
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    country_code VARCHAR(10) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    bio TEXT,
    profile_picture_url TEXT,
    is_online BOOLEAN DEFAULT false,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

**Indexes:**
- `idx_users_phone`: `(phone_number, country_code)` - Fast user lookup
- `idx_users_online`: `(is_online)` - Quick online status queries

**Key Features:**
- UUID primary keys for security
- Automatic timestamp updates
- Timezone support for accurate last_seen

---

## MongoDB Collections

### 1. Chats Collection

Stores chat/conversation metadata.

**Schema:**
```javascript
{
  _id: ObjectId,                    // Unique chat identifier
  participants: [String],           // Array of user UUIDs
  type: String,                     // 'direct' or 'group'
  lastMessage: String | null,      // Last message text
  lastMessageAt: Date | null,      // Timestamp of last message
  createdAt: Date,                  // Chat creation timestamp
  updatedAt: Date                   // Last update timestamp
}
```

**Indexes:**
- `idx_participants`: `{ participants: 1 }` - Find user's chats
- `idx_participants_type`: `{ participants: 1, type: 1 }` - Find specific chat
- `idx_lastMessageAt`: `{ lastMessageAt: -1 }` - Sort by recent messages
- `idx_participants_lastMessageAt`: `{ participants: 1, lastMessageAt: -1 }` - Optimized chat list
- `idx_createdAt`: `{ createdAt: -1 }` - Sort new chats
- `idx_updatedAt`: `{ updatedAt: -1 }` - Track updates

**Query Patterns:**
- Find all chats for a user: `{ participants: userId }`
- Find specific chat: `{ participants: { $all: [userId1, userId2] }, type: 'direct' }`
- Get chat list sorted: `{ participants: userId }` sorted by `lastMessageAt: -1`

---

### 2. Messages Collection

Stores all chat messages, including text, media, and call history.

**Schema:**
```javascript
{
  _id: ObjectId,                    // Unique message identifier
  chatId: ObjectId,                 // Reference to chat
  senderId: String,                 // User UUID who sent the message
  message: String,                   // Message content
  messageType: String,              // 'text', 'image', 'video', 'audio', 'file', 'call'
  readBy: [String],                 // Array of user UUIDs who read the message
  callData: {                       // Only for messageType: 'call'
    roomId: String,
    callId: String,
    mediaType: String,              // 'audio' or 'video'
    status: String,                 // 'missed', 'answered', 'rejected'
    duration: Number,               // Duration in seconds
    initiatorId: String,
    createdAt: Date,
    endedAt: Date
  } | null,
  createdAt: Date,                  // Message timestamp
  updatedAt: Date                   // Last update timestamp
}
```

**Indexes:**
- `idx_chatId`: `{ chatId: 1 }` - Get messages for a chat
- `idx_chatId_createdAt`: `{ chatId: 1, createdAt: 1 }` - Pagination (ascending)
- `idx_chatId_createdAt_desc`: `{ chatId: 1, createdAt: -1 }` - Pagination (descending)
- `idx_senderId`: `{ senderId: 1 }` - Find messages by sender
- `idx_createdAt`: `{ createdAt: -1 }` - Time-based queries
- `idx_messageType`: `{ messageType: 1 }` - Filter by type
- `idx_messageType_createdAt`: `{ messageType: 1, createdAt: -1 }` - Call history queries
- `idx_readBy`: `{ readBy: 1 }` - Read receipt queries

**Query Patterns:**
- Get messages for chat: `{ chatId: chatId }` sorted by `createdAt: 1`
- Pagination: `{ chatId: chatId, createdAt: { $gt: cursor } }`
- Unread messages: `{ chatId: chatId, readBy: { $ne: userId } }`

**Performance Notes:**
- Messages are paginated (25-50 per request)
- Old messages can be archived after 1 year (optional TTL index)
- Call messages are stored inline for fast access

---

### 3. Calls Collection

Stores call session data and history.

**Schema:**
```javascript
{
  _id: ObjectId,                    // Unique call identifier
  roomId: String,                    // Unique room identifier (UUID)
  initiatorId: String,               // User UUID who started the call
  participants: [                    // Array of participant objects
    {
      userId: String,                 // User UUID
      state: String,                 // 'initiator', 'ringing', 'answered', 'declined', 'missed', 'ended'
      updatedAt: Date
    }
  ],
  mediaType: String,                 // 'audio' or 'video'
  status: String,                    // 'ringing', 'answered', 'missed', 'rejected', 'ended'
  events: [                          // Call event history
    {
      type: String,                   // 'answer', 'decline', 'end', 'missed', etc.
      userId: String,
      reason: String,
      payload: Object,
      createdAt: Date
    }
  ],
  createdAt: Date,                   // Call start timestamp
  updatedAt: Date,                   // Last update timestamp
  endedAt: Date | null,              // Call end timestamp
  endReason: String | null,          // Reason for ending
  endedBy: String | null,            // User UUID who ended the call
  metadata: Object | null,            // Additional call metadata
  signalPayload: null                // Not used (Agora doesn't need WebRTC signaling)
}
```

**Indexes:**
- `idx_roomId`: `{ roomId: 1 }` (UNIQUE) - Fast room lookup
- `idx_participants_userId`: `{ 'participants.userId': 1 }` - Find user's calls
- `idx_participants_updatedAt`: `{ 'participants.userId': 1, updatedAt: -1 }` - Call history
- `idx_initiatorId`: `{ initiatorId: 1 }` - Calls started by user
- `idx_status`: `{ status: 1 }` - Filter by status
- `idx_participants_status_updatedAt`: `{ 'participants.userId': 1, status: 1, updatedAt: -1 }` - Filtered history
- `idx_createdAt`: `{ createdAt: -1 }` - Time-based queries
- `idx_updatedAt`: `{ updatedAt: -1 }` - Recent calls
- `idx_endedAt`: `{ endedAt: -1 }` (SPARSE) - Completed calls
- `idx_mediaType`: `{ mediaType: 1 }` - Filter by call type

**Query Patterns:**
- Get user's call history: `{ 'participants.userId': userId }` sorted by `updatedAt: -1`
- Filter by status: `{ 'participants.userId': userId, status: 'missed' }`
- Find call by room: `{ roomId: roomId }`

**Status Values:**
- `ringing`: Call is ringing (not answered yet)
- `answered`: Call was answered and completed
- `missed`: Call was not answered
- `rejected`: Call was declined
- `ended`: Call ended normally

---

## Redis Keys

Used for caching and real-time data.

**Key Patterns:**
- `unread:{userId}:{chatId}`: Unread message count (Integer)
- `presence:{userId}`: User presence data (JSON, TTL: 5 minutes)
- `typing:{chatId}:{userId}`: Typing indicator (String, TTL: 3 seconds)

---

## Data Relationships

```
Users (PostgreSQL)
  ├── Chats (MongoDB) - via participants array
  │   └── Messages (MongoDB) - via chatId
  └── Calls (MongoDB) - via participants array
      └── Call Messages (MongoDB) - via callData.callId
```

---

## Performance Optimizations

### For 10k Daily Users:

1. **Indexes**: All frequently queried fields are indexed
2. **Pagination**: Messages and calls are paginated (25-50 items)
3. **Caching**: Unread counts and presence cached in Redis
4. **Connection Pooling**: MongoDB and PostgreSQL use connection pools
5. **Query Optimization**: Composite indexes for common query patterns
6. **Sparse Indexes**: Used for optional fields (lastMessageAt, endedAt)

### Scalability:

- **Horizontal Scaling**: MongoDB can be sharded by userId or chatId
- **Read Replicas**: PostgreSQL read replicas for analytics
- **TTL Indexes**: Optional auto-cleanup of old data
- **Archiving**: Old messages can be moved to archive collection

---

## Data Retention

**Recommended Retention:**
- Messages: Keep indefinitely (or 1 year with TTL)
- Calls: Keep indefinitely (or 2 years with TTL)
- Chats: Keep as long as participants exist

**Cleanup Strategy:**
- Use TTL indexes for automatic cleanup (optional)
- Archive old data to separate collections
- Regular maintenance scripts for orphaned data

---

## Migration Notes

When running the index initialization:
1. Indexes are created in the background (non-blocking)
2. Large collections may take time to build indexes
3. Monitor MongoDB logs for index build progress
4. Existing data remains intact during index creation

---

## Backup Strategy

**PostgreSQL:**
- Daily automated backups
- Point-in-time recovery enabled

**MongoDB:**
- Daily automated backups
- Replica set for high availability

**Redis:**
- Periodic snapshots
- AOF (Append Only File) for durability

---

## Security Considerations

1. **UUIDs**: All user IDs are UUIDs (not sequential)
2. **Indexes**: Don't expose internal ObjectIds in API responses
3. **Validation**: All inputs validated before database operations
4. **Access Control**: Users can only access their own data
5. **Encryption**: Sensitive data encrypted at rest

---

## Monitoring

**Key Metrics to Monitor:**
- Query performance (slow queries > 100ms)
- Index usage statistics
- Collection sizes and growth rates
- Connection pool utilization
- Cache hit rates (Redis)

**Tools:**
- MongoDB Atlas Performance Advisor
- PostgreSQL pg_stat_statements
- Redis INFO command
- Application-level logging

---

## Troubleshooting

**Common Issues:**

1. **Slow Queries**: Check if indexes exist and are being used
2. **High Memory Usage**: Review index sizes, consider sparse indexes
3. **Connection Pool Exhaustion**: Increase pool size or add read replicas
4. **Index Build Failures**: Check disk space and MongoDB logs

---

Last Updated: 2025-01-07

