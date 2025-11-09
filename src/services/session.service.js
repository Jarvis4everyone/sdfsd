/**
 * Session Management Service
 * 
 * Handles user sessions, login logs, and device management
 * for comprehensive tracking and security.
 */

import postgresPool from '../config/postgres.config.js';
import { getRedisClient } from '../config/redis.config.js';
import crypto from 'crypto';

/**
 * Log login activity
 */
export const logLoginActivity = async ({
  userId,
  phoneNumber,
  countryCode,
  action, // 'login', 'logout', 'login_failed', 'token_refresh'
  status, // 'success', 'failed', 'blocked'
  ipAddress,
  userAgent,
  deviceId,
  deviceType,
  failureReason = null,
}) => {
  try {
    await postgresPool.query(
      `INSERT INTO login_logs 
       (user_id, phone_number, country_code, action, status, ip_address, user_agent, device_id, device_type, failure_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        userId,
        phoneNumber,
        countryCode,
        action,
        status,
        ipAddress,
        userAgent,
        deviceId,
        deviceType,
        failureReason,
      ]
    );

    // Update user's last_login_at on successful login
    if (status === 'success' && action === 'login' && userId) {
      await postgresPool.query(
        "UPDATE users SET last_login_at = (NOW() AT TIME ZONE 'UTC'), last_activity_at = (NOW() AT TIME ZONE 'UTC') WHERE id = $1",
        [userId]
      );
    }
  } catch (error) {
    console.error('Error logging login activity:', error);
    // Don't throw - logging failures shouldn't break the app
  }
};

/**
 * Create or update user session
 */
export const createUserSession = async ({
  userId,
  token,
  deviceId,
  deviceName,
  deviceType,
  ipAddress,
  userAgent,
  expiresIn = 7 * 24 * 60 * 60, // 7 days in seconds
}) => {
  try {
    // Hash token for storage
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    // Check if session already exists for this device
    const existingSession = await postgresPool.query(
      'SELECT id FROM user_sessions WHERE user_id = $1 AND device_id = $2',
      [userId, deviceId]
    );

    if (existingSession.rows.length > 0) {
      // Update existing session
      await postgresPool.query(
        `UPDATE user_sessions 
         SET token_hash = $1, device_name = $2, device_type = $3, ip_address = $4, 
             user_agent = $5, last_used_at = CURRENT_TIMESTAMP, expires_at = $6, is_active = true
         WHERE user_id = $7 AND device_id = $8`,
        [tokenHash, deviceName, deviceType, ipAddress, userAgent, expiresAt, userId, deviceId]
      );
    } else {
      // Create new session
      await postgresPool.query(
        `INSERT INTO user_sessions 
         (user_id, token_hash, device_id, device_name, device_type, ip_address, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, tokenHash, deviceId, deviceName, deviceType, ipAddress, userAgent, expiresAt]
      );
    }

    return true;
  } catch (error) {
    console.error('Error creating user session:', error);
    return false;
  }
};

/**
 * Get user sessions
 */
export const getUserSessions = async (userId) => {
  try {
    const result = await postgresPool.query(
      `SELECT id, device_id, device_name, device_type, ip_address, 
              last_used_at, expires_at, is_active, created_at
       FROM user_sessions 
       WHERE user_id = $1 
       ORDER BY last_used_at DESC`,
      [userId]
    );

    return result.rows;
  } catch (error) {
    console.error('Error getting user sessions:', error);
    return [];
  }
};

/**
 * Revoke session
 */
export const revokeSession = async (userId, sessionId) => {
  try {
    await postgresPool.query(
      'UPDATE user_sessions SET is_active = false WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );

    // Also remove from Redis
    const redisClient = getRedisClient();
    await redisClient.del(`session:${userId}`);

    return true;
  } catch (error) {
    console.error('Error revoking session:', error);
    return false;
  }
};

/**
 * Revoke all sessions except current
 */
export const revokeAllOtherSessions = async (userId, currentDeviceId) => {
  try {
    await postgresPool.query(
      'UPDATE user_sessions SET is_active = false WHERE user_id = $1 AND device_id != $2',
      [userId, currentDeviceId]
    );

    return true;
  } catch (error) {
    console.error('Error revoking other sessions:', error);
    return false;
  }
};

/**
 * Clean up expired sessions
 */
export const cleanupExpiredSessions = async () => {
  try {
    const result = await postgresPool.query(
      'UPDATE user_sessions SET is_active = false WHERE expires_at < CURRENT_TIMESTAMP AND is_active = true'
    );

    return result.rowCount;
  } catch (error) {
    console.error('Error cleaning up expired sessions:', error);
    return 0;
  }
};

/**
 * Get device info from user agent
 */
export const parseDeviceInfo = (userAgent) => {
  if (!userAgent) {
    return {
      deviceName: 'Unknown Device',
      deviceType: 'unknown',
    };
  }

  const ua = userAgent.toLowerCase();

  // Detect device type
  let deviceType = 'web';
  if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
    deviceType = 'mobile';
  } else if (ua.includes('tablet') || ua.includes('ipad')) {
    deviceType = 'tablet';
  }

  // Detect device name
  let deviceName = 'Unknown Device';
  if (ua.includes('chrome')) {
    deviceName = deviceType === 'mobile' ? 'Chrome Mobile' : 'Chrome Browser';
  } else if (ua.includes('firefox')) {
    deviceName = deviceType === 'mobile' ? 'Firefox Mobile' : 'Firefox Browser';
  } else if (ua.includes('safari') && !ua.includes('chrome')) {
    deviceName = deviceType === 'mobile' ? 'Safari Mobile' : 'Safari Browser';
  } else if (ua.includes('android')) {
    deviceName = 'Android Device';
  } else if (ua.includes('iphone')) {
    deviceName = 'iPhone';
  } else if (ua.includes('ipad')) {
    deviceName = 'iPad';
  }

  return {
    deviceName,
    deviceType,
  };
};

/**
 * Generate device ID
 */
export const generateDeviceId = (userAgent, ipAddress) => {
  const data = `${userAgent || ''}-${ipAddress || ''}`;
  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
};

