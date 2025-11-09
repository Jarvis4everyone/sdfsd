/**
 * Blocking Utility Functions
 * Helper functions to check if users are blocked
 */

import { queryWithRetry } from '../config/postgres.config.js';

/**
 * Check if user A is blocked by user B (or vice versa)
 * Returns true if either user has blocked the other
 * @param {string} userId1 - First user ID
 * @param {string} userId2 - Second user ID
 * @returns {Promise<boolean>} - True if blocking exists in either direction
 */
export async function isBlocked(userId1, userId2) {
  try {
    // Check if userId1 blocked userId2
    const block1 = await queryWithRetry(
      'SELECT id FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
      [userId1, userId2],
      2,
      10000
    );

    // Check if userId2 blocked userId1
    const block2 = await queryWithRetry(
      'SELECT id FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
      [userId2, userId1],
      2,
      10000
    );

    return block1.rows.length > 0 || block2.rows.length > 0;
  } catch (error) {
    console.error('Error checking block status:', error);
    // On error, assume not blocked to avoid false positives
    return false;
  }
}

/**
 * Check if user A has blocked user B (one-way check)
 * @param {string} blockerId - User who might have blocked
 * @param {string} blockedId - User who might be blocked
 * @returns {Promise<boolean>} - True if blockerId has blocked blockedId
 */
export async function isBlockedBy(blockerId, blockedId) {
  try {
    const result = await queryWithRetry(
      'SELECT id FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
      [blockerId, blockedId],
      2,
      10000
    );
    return result.rows.length > 0;
  } catch (error) {
    console.error('Error checking block status:', error);
    return false;
  }
}

/**
 * Get list of user IDs that have blocked the given user
 * @param {string} userId - User ID to check
 * @returns {Promise<string[]>} - Array of user IDs who have blocked this user
 */
export async function getBlockedBy(userId) {
  try {
    const result = await queryWithRetry(
      'SELECT blocker_id FROM blocked_users WHERE blocked_id = $1',
      [userId],
      2,
      10000
    );
    return result.rows.map(row => row.blocker_id);
  } catch (error) {
    console.error('Error getting blocked by list:', error);
    return [];
  }
}

/**
 * Get list of user IDs that the given user has blocked
 * @param {string} userId - User ID to check
 * @returns {Promise<string[]>} - Array of user IDs this user has blocked
 */
export async function getBlockedUsers(userId) {
  try {
    const result = await queryWithRetry(
      'SELECT blocked_id FROM blocked_users WHERE blocker_id = $1',
      [userId],
      2,
      10000
    );
    return result.rows.map(row => row.blocked_id);
  } catch (error) {
    console.error('Error getting blocked users list:', error);
    return [];
  }
}

/**
 * Filter out blocked users from an array of user IDs
 * @param {string} currentUserId - Current user ID
 * @param {string[]} userIds - Array of user IDs to filter
 * @returns {Promise<string[]>} - Filtered array without blocked users
 */
export async function filterBlockedUsers(currentUserId, userIds) {
  try {
    if (userIds.length === 0) return [];

    // Get all users blocked by current user
    const blockedByMe = await getBlockedUsers(currentUserId);
    
    // Get all users who have blocked current user
    const blockedByThem = await getBlockedBy(currentUserId);
    
    // Combine both lists
    const allBlocked = [...new Set([...blockedByMe, ...blockedByThem])];

    // Filter out blocked users
    return userIds.filter(userId => !allBlocked.includes(userId));
  } catch (error) {
    console.error('Error filtering blocked users:', error);
    // On error, return original list to avoid false filtering
    return userIds;
  }
}

