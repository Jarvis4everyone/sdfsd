import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import postgresPool, { queryWithRetry } from '../config/postgres.config.js';
import { getRedisClient } from '../config/redis.config.js';
import { 
  logLoginActivity, 
  createUserSession, 
  parseDeviceInfo, 
  generateDeviceId 
} from '../services/session.service.js';
import { logActivity } from '../services/analytics.service.js';
import { authRateLimit, otpVerifyRateLimit } from '../middleware/rate-limit.middleware.js';
import { safeRedisOperation } from '../utils/redis.utils.js';

const router = express.Router();

/**
 * Verify Token Middleware
 * 
 * Fixed bugs:
 * - #13: Check token expiry before Redis lookup
 * - #5: Safe Redis operations with error handling
 */
export const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1]; // Bearer <token>

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'No token provided',
      });
    }

    // BUG FIX #13: Verify token and check expiry FIRST before Redis lookup
    // jwt.verify will throw if token is expired or invalid
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (jwtError) {
      // Token is invalid or expired
      if (jwtError.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Token expired',
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
      });
    }
    
    // BUG FIX #5: Verify token in Redis with safe operations
    const storedToken = await safeRedisOperation(async (redisClient) => {
      return await redisClient.get(`session:${decoded.userId}`);
    }, null);
    
    if (!storedToken || storedToken !== token) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token',
      });
    }

    req.userId = decoded.userId;
    req.userPhoneNumber = decoded.phoneNumber;
    next();
  } catch (error) {
    res.status(401).json({
      success: false,
      message: 'Invalid token',
      error: error.message,
    });
  }
};

/**
 * Send OTP
 * POST /api/auth/send-otp
 * 
 * Fixed bugs:
 * - #14: Rate limiting
 */
router.post('/send-otp', authRateLimit, async (req, res) => {
  try {
    const { phoneNumber, countryCode } = req.body;

    if (!phoneNumber || !countryCode) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and country code are required',
      });
    }

    // Check if user exists
    const existingUser = await postgresPool.query(
      'SELECT id FROM users WHERE phone_number = $1 AND country_code = $2',
      [phoneNumber, countryCode]
    );

    // In production, send actual OTP via SMS
    // For now, just return success
    res.json({
      success: true,
      message: 'OTP sent successfully',
      data: {
        userExists: existingUser.rows.length > 0,
        // Demo OTP: 123456
      },
    });
  } catch (error) {
    console.error('Send OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Get timezone from country code or use provided timezone
 * BUG FIX #10: Remove hardcoded timezone, use user's timezone or country-based
 */
function getTimezoneFromCountryCode(countryCode, providedTimezone) {
  // Use provided timezone if available
  if (providedTimezone && typeof providedTimezone === 'string') {
    // Validate timezone format (basic check)
    try {
      // Try to create a date with the timezone to validate
      Intl.DateTimeFormat(undefined, { timeZone: providedTimezone });
      return providedTimezone;
    } catch (e) {
      // Invalid timezone, fall back to country code
    }
  }
  
  // Map country codes to timezones (common ones)
  const timezoneMap = {
    'IN': 'Asia/Kolkata',
    'US': 'America/New_York',
    'GB': 'Europe/London',
    'CA': 'America/Toronto',
    'AU': 'Australia/Sydney',
    'DE': 'Europe/Berlin',
    'FR': 'Europe/Paris',
    'JP': 'Asia/Tokyo',
    'CN': 'Asia/Shanghai',
    'BR': 'America/Sao_Paulo',
  };
  
  // Return timezone based on country code, default to UTC
  return timezoneMap[countryCode] || 'UTC';
}

/**
 * Verify OTP and Login/Register
 * POST /api/auth/verify-otp
 * 
 * Fixed bugs:
 * - #10: Fix timezone handling (use user's timezone)
 * - #14: Rate limiting
 */
router.post('/verify-otp', otpVerifyRateLimit, async (req, res) => {
  try {
    const { phoneNumber, countryCode, otp, timezone } = req.body;

    if (!phoneNumber || !countryCode || !otp) {
      return res.status(400).json({
        success: false,
        message: 'Phone number, country code, and OTP are required',
      });
    }

    // Get device info for logging
    const ipAddress = req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'] || 'Unknown';

    // For demo, accept OTP 123456
    if (otp !== '123456') {
      // Log failed login attempt
      await logLoginActivity({
        userId: null,
        phoneNumber,
        countryCode,
        action: 'login_failed',
        status: 'failed',
        ipAddress,
        userAgent,
        deviceId: generateDeviceId(userAgent, ipAddress),
        deviceType: parseDeviceInfo(userAgent).deviceType,
        failureReason: 'Invalid OTP',
      });

      return res.status(400).json({
        success: false,
        message: 'Invalid OTP',
      });
    }

    // BUG FIX #10: Use user's timezone or determine from country code
    const userTimezone = getTimezoneFromCountryCode(countryCode, timezone);

    // Check if user already exists (check by phone_number only, as it's unique)
    // First try exact match with country code
    let existingUser = await postgresPool.query(
      'SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, timezone FROM users WHERE phone_number = $1 AND country_code = $2',
      [phoneNumber, countryCode]
    );

    // If not found, try by phone number only (in case country code changed)
    if (existingUser.rows.length === 0) {
      existingUser = await postgresPool.query(
        'SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, timezone FROM users WHERE phone_number = $1',
        [phoneNumber]
      );
    }

    let user;
    let isNewUser = false;

    if (existingUser.rows.length > 0) {
      // User exists - login
      user = existingUser.rows[0];
      
      // Update country code and timezone if changed (always use country code to determine timezone)
      if (user.country_code !== countryCode || user.timezone !== userTimezone) {
        await postgresPool.query(
          "UPDATE users SET country_code = $1, timezone = $2, last_seen = (NOW() AT TIME ZONE 'UTC'), is_online = true WHERE id = $3",
          [countryCode, userTimezone, user.id]
        );
        user.country_code = countryCode;
        user.timezone = userTimezone;
      } else {
        await postgresPool.query(
          "UPDATE users SET last_seen = (NOW() AT TIME ZONE 'UTC'), is_online = true WHERE id = $1",
          [user.id]
        );
      }
    } else {
      // Create new user without name (will be set in profile setup)
      try {
        const result = await postgresPool.query(
          `INSERT INTO users (phone_number, country_code, full_name, is_online, timezone)
           VALUES ($1, $2, $3, true, $4)
           RETURNING id, full_name, phone_number, country_code, bio, profile_picture_url, timezone, created_at`,
          [phoneNumber, countryCode, '', userTimezone] // Empty name initially
        );
        user = result.rows[0];
        isNewUser = true;

        // Create default settings for new user
        await postgresPool.query(
          'INSERT INTO user_settings (user_id) VALUES ($1)',
          [user.id]
        );

        // Add default contacts for new user
        const defaultContacts = [
          { phoneNumber: '9090909090', countryCode: '+91', name: 'Contact 1' },
          { phoneNumber: '8080808080', countryCode: '+91', name: 'Contact 2' },
          { phoneNumber: '7070707070', countryCode: '+91', name: 'Contact 3' },
          { phoneNumber: '6060606060', countryCode: '+91', name: 'Contact 4' },
          { phoneNumber: '5050505050', countryCode: '+91', name: 'Contact 5' },
        ];

        for (const contact of defaultContacts) {
          try {
            await postgresPool.query(
              `INSERT INTO contacts (user_id, contact_phone_number, contact_country_code, contact_name)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (user_id, contact_phone_number, contact_country_code) DO NOTHING`,
              [user.id, contact.phoneNumber, contact.countryCode, contact.name]
            );
          } catch (error) {
            // Silently ignore errors (contact might already exist)
            console.error(`Error adding default contact ${contact.phoneNumber}:`, error.message);
          }
        }
      } catch (insertError) {
        // If insert fails due to duplicate key, try to find the user again
        if (insertError.code === '23505') { // Unique violation
          const retryUser = await postgresPool.query(
            'SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, timezone FROM users WHERE phone_number = $1',
            [phoneNumber]
          );
          if (retryUser.rows.length > 0) {
            user = retryUser.rows[0];
            // Update country code, timezone, and status
            await postgresPool.query(
              "UPDATE users SET country_code = $1, timezone = $2, last_seen = (NOW() AT TIME ZONE 'UTC'), is_online = true WHERE id = $3",
              [countryCode, userTimezone, user.id]
            );
            user.country_code = countryCode;
            user.timezone = userTimezone;
            isNewUser = false;
          } else {
            throw insertError;
          }
        } else {
          throw insertError;
        }
      }
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, phoneNumber: user.phone_number },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Store token in Redis for session management
    const redisClient = getRedisClient();
    await redisClient.setEx(
      `session:${user.id}`,
      7 * 24 * 60 * 60, // 7 days
      token
    );

    res.status(isNewUser ? 201 : 200).json({
      success: true,
      message: isNewUser ? 'OTP verified. Please complete your profile.' : 'Login successful',
      data: {
        user: {
          id: user.id,
          fullName: user.full_name || '',
          phoneNumber: user.phone_number,
          countryCode: user.country_code,
          bio: user.bio,
          profilePictureUrl: user.profile_picture_url,
          timezone: user.timezone || userTimezone || getTimezoneFromCountryCode(countryCode),
        },
        token,
        isNewUser,
      },
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Complete Profile Setup (for new users)
 * POST /api/auth/complete-profile
 */
router.post('/complete-profile', verifyToken, async (req, res) => {
  try {
    const { fullName, bio, profilePictureUrl, timezone } = req.body;

    if (!fullName || fullName.trim().length < 3) {
      return res.status(400).json({
        success: false,
        message: 'Full name is required and must be at least 3 characters',
      });
    }

    // Update user profile
    const updates = [];
    const values = [];
    let paramCount = 1;

    updates.push(`full_name = $${paramCount++}`);
    values.push(fullName.trim());

    if (bio !== undefined && bio !== null) {
      updates.push(`bio = $${paramCount++}`);
      values.push(bio.trim() || null);
    }

    if (profilePictureUrl !== undefined && profilePictureUrl !== null) {
      updates.push(`profile_picture_url = $${paramCount++}`);
      values.push(profilePictureUrl);
    }

    values.push(req.userId);

    const query = `
      UPDATE users 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING id, full_name, phone_number, country_code, bio, profile_picture_url, timezone, created_at
    `;

    const result = await postgresPool.query(query, values);
    const user = result.rows[0];

    res.json({
      success: true,
      message: 'Profile completed successfully',
      data: {
        user: {
          id: user.id,
          fullName: user.full_name,
          phoneNumber: user.phone_number,
          countryCode: user.country_code,
          bio: user.bio,
          profilePictureUrl: user.profile_picture_url,
          timezone: user.timezone,
        },
      },
    });
  } catch (error) {
    console.error('Complete profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Register/Login User (after OTP verification) - Legacy endpoint
 * POST /api/auth/register
 */
router.post('/register', async (req, res) => {
  try {
    const { fullName, phoneNumber, countryCode } = req.body;

    // Validation
    if (!fullName || !phoneNumber || !countryCode) {
      return res.status(400).json({
        success: false,
        message: 'Full name, phone number, and country code are required',
      });
    }

    // Check if user already exists
    const existingUser = await postgresPool.query(
      'SELECT id, full_name, phone_number, country_code FROM users WHERE phone_number = $1 AND country_code = $2',
      [phoneNumber, countryCode]
    );

    let user;
    let isNewUser = false;

    if (existingUser.rows.length > 0) {
      // User exists, update last login
      user = existingUser.rows[0];
      await postgresPool.query(
        'UPDATE users SET last_seen = CURRENT_TIMESTAMP, is_online = true WHERE id = $1',
        [user.id]
      );
    } else {
      // Create new user
      const result = await postgresPool.query(
        `INSERT INTO users (full_name, phone_number, country_code, is_online)
         VALUES ($1, $2, $3, true)
         RETURNING id, full_name, phone_number, country_code, bio, profile_picture_url, created_at`,
        [fullName, phoneNumber, countryCode]
      );
      user = result.rows[0];
      isNewUser = true;

      // Create default settings for new user
      await postgresPool.query(
        'INSERT INTO user_settings (user_id) VALUES ($1)',
        [user.id]
      );
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, phoneNumber: user.phone_number },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Store token in Redis for session management
    const redisClient = getRedisClient();
    await redisClient.setEx(
      `session:${user.id}`,
      7 * 24 * 60 * 60, // 7 days
      token
    );

    res.status(isNewUser ? 201 : 200).json({
      success: true,
      message: isNewUser ? 'User registered successfully' : 'User logged in successfully',
      data: {
        user: {
          id: user.id,
          fullName: user.full_name,
          phoneNumber: user.phone_number,
          countryCode: user.country_code,
          bio: user.bio,
          profilePictureUrl: user.profile_picture_url,
        },
        token,
        isNewUser,
      },
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Heartbeat - Update last_seen to keep user online
 * POST /api/auth/heartbeat
 * This is ONE of the ONLY places where last_seen is updated (along with connect/disconnect)
 */
router.post('/heartbeat', verifyToken, async (req, res) => {
  try {
    // Import queryWithRetry
    const { queryWithRetry } = await import('../config/postgres.config.js');
    
    // Update last_seen in database - this is the ONLY way to keep user online
    await queryWithRetry(
        "UPDATE users SET last_seen = (NOW() AT TIME ZONE 'UTC'), is_online = true WHERE id = $1",
        [req.userId],
        3, // 3 retries
        20000 // 20 second timeout for heartbeat
      );

    // Broadcast presence update to all users who have chats with this user
    try {
      const { getSocketIO } = await import('../socket/socket.server.js');
      const socketIO = getSocketIO();
      if (socketIO) {
        // Get fresh user data after update
        const userResult = await queryWithRetry(
          "SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as last_seen, timezone FROM users WHERE id = $1",
          [req.userId],
          3,
          20000
        );
        if (userResult.rows.length > 0) {
          const { getUserPresenceData, preparePresenceForBroadcast } = await import('../utils/presence.utils.js');
          const userPresenceData = getUserPresenceData(userResult.rows[0]);
          
          if (userPresenceData) {
            // Get all chats for this user
            const { getMongoDB } = await import('../config/mongodb.config.js');
            const mongoDb = getMongoDB();
            const chatsCollection = mongoDb.collection('chats');
            const chats = await chatsCollection.find({ participants: req.userId }).toArray();
            
            // Prepare presence data with proper ISO string serialization
            const presenceData = preparePresenceForBroadcast(userPresenceData);
            
            // Broadcast to all chat participants
            if (presenceData) {
              for (const chat of chats) {
                const otherParticipantId = chat.participants.find((id) => id !== req.userId);
                if (otherParticipantId) {
                  socketIO.to(`user:${otherParticipantId}`).emit('presence_update', presenceData);
                }
              }
            }
          }
        }
      }
    } catch (broadcastError) {
      // Don't fail heartbeat if broadcast fails
      console.error('Error broadcasting presence update from heartbeat:', broadcastError);
    }

    res.json({
      success: true,
      message: 'Heartbeat updated',
    });
  } catch (error) {
    console.error('Heartbeat error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

/**
 * Logout User
 * POST /api/auth/logout
 */
router.post('/logout', verifyToken, async (req, res) => {
  try {
    // Remove session from Redis
    const redisClient = getRedisClient();
    await redisClient.del(`session:${req.userId}`);

    // Update user online status
    await postgresPool.query(
      "UPDATE users SET is_online = false, last_seen = (NOW() AT TIME ZONE 'UTC') WHERE id = $1",
      [req.userId]
    );

    res.json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
    });
  }
});

export default router;

