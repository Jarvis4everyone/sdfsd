import { getRedisClient } from '../config/redis.config.js';

/**
 * Safely execute Redis operations with error handling
 */
export const safeRedisOperation = async (operation, defaultValue = null) => {
  try {
    const redisClient = getRedisClient();
    return await operation(redisClient);
  } catch (error) {
    console.error('Redis operation error:', error.message);
    // Return default value instead of crashing
    return defaultValue;
  }
};

/**
 * Increment unread count with proper locking to prevent race conditions
 * Uses Redis SETNX for atomic operations
 */
export const incrementUnreadCount = async (userId, chatId, increment = 1) => {
  return await safeRedisOperation(async (redisClient) => {
    const key = `unread:${userId}:${chatId}`;
    
    // Use Redis pipeline for atomic operation
    const pipeline = redisClient.multi();
    pipeline.incrBy(key, increment);
    pipeline.expire(key, 86400 * 7); // Expire after 7 days if no activity
    
    const results = await pipeline.exec();
    return results?.[0]?.[1] || 0;
  }, 0);
};

/**
 * Decrement unread count (used when messages are deleted)
 */
export const decrementUnreadCount = async (userId, chatId, decrement = 1) => {
  return await safeRedisOperation(async (redisClient) => {
    const key = `unread:${userId}:${chatId}`;
    const current = await redisClient.get(key);
    const currentCount = parseInt(current || '0', 10);
    
    if (currentCount <= decrement) {
      // If count would go negative, set to 0
      await redisClient.del(key);
      return 0;
    }
    
    await redisClient.decrBy(key, decrement);
    return currentCount - decrement;
  }, 0);
};

/**
 * Get unread count safely
 */
export const getUnreadCount = async (userId, chatId) => {
  return await safeRedisOperation(async (redisClient) => {
    const key = `unread:${userId}:${chatId}`;
    const count = await redisClient.get(key);
    return parseInt(count || '0', 10);
  }, 0);
};

/**
 * Set unread count safely
 */
export const setUnreadCount = async (userId, chatId, count) => {
  return await safeRedisOperation(async (redisClient) => {
    const key = `unread:${userId}:${chatId}`;
    if (count <= 0) {
      await redisClient.del(key);
      return 0;
    }
    await redisClient.setEx(key, 86400 * 7, count.toString()); // 7 days TTL
    return count;
  }, 0);
};

/**
 * Clear unread count safely
 */
export const clearUnreadCount = async (userId, chatId) => {
  return await safeRedisOperation(async (redisClient) => {
    const key = `unread:${userId}:${chatId}`;
    await redisClient.del(key);
    return 0;
  }, 0);
};

