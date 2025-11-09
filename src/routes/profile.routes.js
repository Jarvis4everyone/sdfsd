import express from 'express';
import postgresPool from '../config/postgres.config.js';
import { verifyToken } from './auth.routes.js';
import { uploadSingle, getFileUrl, deleteFile } from '../middleware/upload.middleware.js';
import { getMongoDB } from '../config/mongodb.config.js';
import { ObjectId } from 'mongodb';
import multer from 'multer';
import { getUserPresenceData } from '../utils/presence.utils.js';
import { logActivity } from '../services/analytics.service.js';

const router = express.Router();

/**
 * Get User Profile (own profile)
 * GET /api/profile
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    // CRITICAL: Convert last_seen to UTC to ensure consistent timezone handling
    const result = await postgresPool.query(
      `SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, 
              is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_seen, timezone, created_at, updated_at
       FROM users WHERE id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const user = result.rows[0];

    res.json({
      success: true,
      data: {
        id: user.id,
        fullName: user.full_name,
        phoneNumber: user.phone_number,
        countryCode: user.country_code,
        bio: user.bio,
        profilePictureUrl: user.profile_picture_url,
        isOnline: user.is_online,
        lastSeen: user.last_seen,
        timezone: user.timezone,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
    });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Update User Profile
 * PUT /api/profile
 */
router.put('/', verifyToken, async (req, res) => {
  try {
    const { fullName, bio, profilePictureUrl } = req.body;

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (fullName !== undefined) {
      updates.push(`full_name = $${paramCount++}`);
      values.push(fullName);
    }

    if (bio !== undefined) {
      updates.push(`bio = $${paramCount++}`);
      values.push(bio);
    }

    if (profilePictureUrl !== undefined) {
      updates.push(`profile_picture_url = $${paramCount++}`);
      values.push(profilePictureUrl);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No fields to update',
      });
    }

    values.push(req.userId);

    const query = `
      UPDATE users 
      SET ${updates.join(', ')}
      WHERE id = $${paramCount}
      RETURNING id, full_name, phone_number, country_code, bio, profile_picture_url, updated_at
    `;

    const result = await postgresPool.query(query, values);
    const user = result.rows[0];

    // Log activity
    const ipAddress = req.ip || req.connection.remoteAddress;
    const deviceId = req.headers['x-device-id'] || 'unknown';
    await logActivity({
      userId: req.userId,
      activityType: 'profile_updated',
      activityData: {
        updatedFields: Object.keys(req.body).filter(key => req.body[key] !== undefined),
      },
      ipAddress,
      deviceId,
    });

    res.json({
      success: true,
      message: 'Profile updated successfully',
      data: {
        id: user.id,
        fullName: user.full_name,
        phoneNumber: user.phone_number,
        countryCode: user.country_code,
        bio: user.bio,
        profilePictureUrl: user.profile_picture_url,
        updatedAt: user.updated_at,
      },
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Upload Profile Picture
 * POST /api/profile/picture
 * Accepts multipart/form-data with 'profilePicture' file
 */
router.post('/picture', verifyToken, (req, res, next) => {
  uploadSingle(req, res, (err) => {
    // Handle multer errors
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({
            success: false,
            message: 'File too large. Maximum size is 10MB.',
          });
        }
        return res.status(400).json({
          success: false,
          message: err.message || 'File upload error',
        });
      }
      // File filter error
      return res.status(400).json({
        success: false,
        message: err.message || 'Invalid file type. Only images are allowed.',
      });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded. Please select an image.',
      });
    }

    // Get current user to delete old picture
    const currentUser = await postgresPool.query(
      'SELECT profile_picture_url FROM users WHERE id = $1',
      [req.userId]
    );

    // Generate file URL
    const fileUrl = getFileUrl(req, req.file.filename);

    // Update database with new picture URL
    const result = await postgresPool.query(
      `UPDATE users 
       SET profile_picture_url = $1 
       WHERE id = $2
       RETURNING profile_picture_url`,
      [fileUrl, req.userId]
    );

    // Delete old profile picture if exists
    if (currentUser.rows[0]?.profile_picture_url) {
      const oldUrl = currentUser.rows[0].profile_picture_url;
      // Extract filename from URL
      const oldFilename = oldUrl.split('/').pop();
      if (oldFilename && oldFilename.startsWith('profile-')) {
        deleteFile(oldFilename);
      }
    }

    res.json({
      success: true,
      message: 'Profile picture uploaded successfully',
      data: {
        profilePictureUrl: result.rows[0].profile_picture_url,
      },
    });
  } catch (error) {
    console.error('Update profile picture error:', error);
    
    // Delete uploaded file if database update failed
    if (req.file) {
      deleteFile(req.file.filename);
    }

    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Get Another User's Profile by User ID
 * GET /api/profile/user/:userId
 * Note: This route must come before /:userId to avoid conflicts
 */
router.get('/user/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;

    // Check if user is blocked (either direction)
    const { isBlocked } = await import('../utils/block.utils.js');
    const blocked = await isBlocked(req.userId, userId);
    if (blocked) {
      return res.status(403).json({
        success: false,
        message: 'Cannot view profile. User is blocked.',
      });
    }

    // DO NOT update last_seen here - it's only updated on connect/disconnect/heartbeat

    // Get fresh user data from database (always fetch latest last_seen)
    // CRITICAL: Convert last_seen to UTC to ensure consistent timezone handling
    const result = await postgresPool.query(
      `SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, 
              is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_seen, timezone, created_at, updated_at
       FROM users WHERE id = $1`,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    const user = result.rows[0];
    const userPresenceData = getUserPresenceData(user);

    res.json({
      success: true,
      data: {
        id: user.id,
        fullName: user.full_name,
        phoneNumber: user.phone_number,
        countryCode: user.country_code,
        bio: user.bio,
        profilePictureUrl: user.profile_picture_url,
        isOnline: userPresenceData.isOnline,
        lastSeen: userPresenceData.lastSeen,
        timezone: user.timezone,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
      },
    });
  } catch (error) {
    console.error('Get user profile error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Get User Media (images, videos, files from all chats)
 * GET /api/profile/media
 * 
 * If userId is provided: Returns media from the chat between current user and that user (both users' media)
 * If userId is not provided: Returns all media sent by the current user from all chats
 */
router.get('/media', verifyToken, async (req, res) => {
  try {
    const { userId } = req.query; // Optional: get media from chat with specific user (for view profile)
    
    const mongoDb = getMongoDB();
    const chatsCollection = mongoDb.collection('chats');
    const messagesCollection = mongoDb.collection('messages');

    let chatIds = [];
    let senderFilter = {};

    if (userId) {
      // Check if user is blocked (either direction)
      const { isBlocked } = await import('../utils/block.utils.js');
      const blocked = await isBlocked(req.userId, userId);
      if (blocked) {
        return res.status(403).json({
          success: false,
          message: 'Cannot view media. User is blocked.',
        });
      }

      // Viewing another user's profile: Show media from the chat between current user and that user
      // Find the direct chat between req.userId and userId
      const chat = await chatsCollection.findOne({
        participants: { $all: [req.userId, userId] },
        type: 'direct',
      });

      if (!chat) {
        // No chat exists yet, return empty media
        return res.json({
          success: true,
          data: {
            media: [],
            total: 0,
          },
        });
      }

      chatIds = [chat._id];
      // Show media from both users in this chat
      senderFilter = { senderId: { $in: [req.userId, userId] } };
    } else {
      // Viewing own profile: Show all media sent by current user from all chats
      const chats = await chatsCollection
        .find({
          participants: req.userId,
        })
        .toArray();

      chatIds = chats.map((chat) => chat._id);
      senderFilter = { senderId: req.userId };
    }

    if (chatIds.length === 0) {
      return res.json({
        success: true,
        data: {
          media: [],
          total: 0,
        },
      });
    }

    // Get all media messages (image, video, file, document, audio types)
    const mediaMessages = await messagesCollection
      .find({
        chatId: { $in: chatIds },
        ...senderFilter,
        messageType: { $in: ['image', 'video', 'file', 'document', 'audio'] },
      })
      .sort({ createdAt: -1 })
      .limit(100) // Limit to recent 100 media items
      .toArray();

    // Format media items
    const media = mediaMessages.map((msg) => ({
      id: msg._id.toString(),
      chatId: msg.chatId.toString(),
      message: msg.message, // URL or file path
      messageType: msg.messageType,
      createdAt: msg.createdAt,
    }));

    res.json({
      success: true,
      data: {
        media,
        total: media.length,
      },
    });
  } catch (error) {
    console.error('Get media error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

export default router;

