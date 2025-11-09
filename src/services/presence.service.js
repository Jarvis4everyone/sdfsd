/**
 * Centralized Presence Service
 * 
 * This service provides a single source of truth for user presence (online/offline status)
 * and last_seen timestamps. All presence updates should go through this service.
 * 
 * Features:
 * - Updates presence in PostgreSQL database
 * - Broadcasts real-time updates via Socket.IO
 * - Ensures consistent data format (ISO strings for dates)
 * - Fast retrieval from database
 */

import postgresPool from '../config/postgres.config.js';
import { getUserPresenceData, preparePresenceForBroadcast } from '../utils/presence.utils.js';

/**
 * Update user's online status and last_seen timestamp
 * This is the PRIMARY way to update presence - use this instead of direct SQL
 * 
 * @param {string} userId - User ID
 * @param {boolean} isOnline - Whether user is online
 * @param {boolean} broadcast - Whether to broadcast update to other users (default: true)
 * @returns {Promise<Object>} Updated user presence data
 */
export async function updateUserPresence(userId, isOnline = true, broadcast = true) {
  try {
    // Update database with current timestamp
    await postgresPool.query(
      "UPDATE users SET is_online = $1, last_seen = (NOW() AT TIME ZONE 'UTC') WHERE id = $2",
      [isOnline, userId]
    );

    // Get fresh data from database
    // CRITICAL: Convert last_seen to UTC to ensure consistent timezone handling
    const userResult = await postgresPool.query(
      "SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as last_seen, timezone FROM users WHERE id = $1",
      [userId]
    );

    if (userResult.rows.length === 0) {
      throw new Error(`User ${userId} not found`);
    }

    const user = userResult.rows[0];
    const userPresenceData = getUserPresenceData(user);

    // Broadcast update if requested
    if (broadcast && userPresenceData) {
      await broadcastPresenceUpdate(userId, userPresenceData);
    }

    return userPresenceData;
  } catch (error) {
    console.error('Error updating user presence:', error);
    throw error;
  }
}

/**
 * Get user presence data by user ID
 * Fast retrieval from database with proper serialization
 * 
 * @param {string} userId - User ID
 * @returns {Promise<Object|null>} User presence data or null if not found
 */
export async function getUserPresence(userId) {
  try {
    // CRITICAL: Convert last_seen to UTC to ensure consistent timezone handling
    const userResult = await postgresPool.query(
      "SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as last_seen, timezone FROM users WHERE id = $1",
      [userId]
    );

    if (userResult.rows.length === 0) {
      return null;
    }

    const user = userResult.rows[0];
    return getUserPresenceData(user);
  } catch (error) {
    console.error('Error getting user presence:', error);
    return null;
  }
}

/**
 * Get presence data for multiple users (batch retrieval)
 * Useful for chat lists, contact lists, etc.
 * 
 * @param {string[]} userIds - Array of user IDs
 * @returns {Promise<Object>} Map of userId -> presence data
 */
export async function getMultipleUsersPresence(userIds) {
  if (!userIds || userIds.length === 0) {
    return {};
  }

  try {
    // CRITICAL: Convert last_seen to UTC to ensure consistent timezone handling
    const userResult = await postgresPool.query(
      "SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as last_seen, timezone FROM users WHERE id = ANY($1)",
      [userIds]
    );

    const presenceMap = {};
    for (const user of userResult.rows) {
      const presenceData = getUserPresenceData(user);
      if (presenceData) {
        presenceMap[user.id] = presenceData;
      }
    }

    return presenceMap;
  } catch (error) {
    console.error('Error getting multiple users presence:', error);
    return {};
  }
}

/**
 * Broadcast presence update to all users who have chats with this user
 * This is called automatically by updateUserPresence, but can be called manually if needed
 * 
 * @param {string} userId - User ID
 * @param {Object} userPresenceData - User presence data (from getUserPresenceData)
 * @returns {Promise<void>}
 */
export async function broadcastPresenceUpdate(userId, userPresenceData) {
  try {
    const { getSocketIO } = await import('../socket/socket.server.js');
    const { getMongoDB } = await import('../config/mongodb.config.js');
    
    const socketIO = getSocketIO();
    if (!socketIO) {
      console.warn('Socket.IO not initialized, cannot broadcast presence update');
      return;
    }

    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');

    // Find all chats where this user is a participant
    const chats = await chatsCollection.find({
      participants: userId,
    }).toArray();

    if (chats.length === 0) {
      return; // No chats to broadcast to
    }

    // Prepare presence data for broadcast (ensures ISO string serialization)
    const presenceData = preparePresenceForBroadcast(userPresenceData);
    if (!presenceData) {
      return;
    }

    // Broadcast to all other participants
    for (const chat of chats) {
      const otherParticipantId = chat.participants.find((id) => id !== userId);
      if (otherParticipantId) {
        // Emit presence update
        socketIO.to(`user:${otherParticipantId}`).emit('presence_update', presenceData);

        // Also update their chat list with new presence info
        socketIO.to(`user:${otherParticipantId}`).emit('chat_updated', {
          chatId: chat._id.toString(),
          otherUser: userPresenceData,
        });
      }
    }

    console.log(`✅ Broadcasted presence update for user ${userId} (online: ${presenceData.isOnline}) to ${chats.length} chat(s)`);
  } catch (error) {
    console.error('Error broadcasting presence update:', error);
    // Don't throw - this is a non-critical operation
  }
}

/**
 * Mark user as online (convenience method)
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Updated user presence data
 */
export async function markUserOnline(userId) {
  return updateUserPresence(userId, true, true);
}

/**
 * Mark user as offline (convenience method)
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Updated user presence data
 */
export async function markUserOffline(userId) {
  return updateUserPresence(userId, false, true);
}

