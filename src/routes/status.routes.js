import express from 'express';
import { ObjectId } from 'mongodb';
import { getMongoDB } from '../config/mongodb.config.js';
import postgresPool, { queryWithRetry } from '../config/postgres.config.js';
import { verifyToken } from './auth.routes.js';
import { uploadMessageFile, getFileUrl, deleteFile } from '../middleware/upload.middleware.js';
import { emitStatusUpdate } from '../socket/socket.server.js';
import multer from 'multer';
import rateLimit from 'express-rate-limit';

const router = express.Router();

// Rate limiting for status creation (max 5 statuses per hour)
const statusRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 requests per window
  message: {
    success: false,
    message: 'Too many status updates. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// File size limits
const MAX_IMAGE_SIZE = 16 * 1024 * 1024; // 16MB
const MAX_VIDEO_SIZE = 50 * 1024 * 1024; // 50MB

/**
 * Get All Statuses (for current user's contacts)
 * GET /api/status
 * Query params: page (default 1), limit (default 50)
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const mongoDb = getMongoDB();
    const statusCollection = mongoDb.collection('status');

    // Pagination
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100 per page
    const skip = (page - 1) * limit;

    // Get user's contacts from PostgreSQL (with retry)
    const contactsResult = await queryWithRetry(
      `SELECT u.id as user_id
       FROM contacts c
       LEFT JOIN users u ON u.phone_number = c.contact_phone_number 
         AND u.country_code = c.contact_country_code
       WHERE c.user_id = $1 AND u.id IS NOT NULL`,
      [req.userId]
    );

    const contactIds = contactsResult.rows.map(row => row.user_id);
    // Include current user's own status
    contactIds.push(req.userId);

    // Get blocked users (with retry)
    const blockedResult = await queryWithRetry(
      `SELECT blocked_id FROM blocked_users WHERE blocker_id = $1`,
      [req.userId]
    );
    const blockedIds = blockedResult.rows.map(row => row.blocked_id);
    
    // Filter out blocked users
    const allowedContactIds = contactIds.filter(id => !blockedIds.includes(id));

    // Get all statuses from contacts (and self) that are not expired
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const statuses = await statusCollection
      .find({
        userId: { $in: allowedContactIds },
        updatedAt: { $gte: twentyFourHoursAgo }, // Check updatedAt for better performance
      })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    // Get user privacy settings (with retry)
    const privacyResult = await queryWithRetry(
      `SELECT user_id, status_privacy FROM user_settings WHERE user_id = ANY($1::uuid[])`,
      [allowedContactIds]
    );
    const privacyMap = {};
    privacyResult.rows.forEach(row => {
      privacyMap[row.user_id] = row.status_privacy || 'contacts';
    });

    // Get user details for each status and filter expired status items
    const statusList = await Promise.all(
      statuses.map(async (status) => {
        // Get user info from PostgreSQL (with retry)
        const userResult = await queryWithRetry(
          'SELECT id, full_name, profile_picture_url FROM users WHERE id = $1',
          [status.userId]
        );

        const user = userResult.rows[0];
        const userPrivacy = privacyMap[status.userId] || 'contacts';

        // Filter expired status items (check individual timestamps)
        const validStatuses = (status.statuses || []).filter(statusItem => {
          const statusTime = new Date(statusItem.timestamp);
          return statusTime >= twentyFourHoursAgo;
        });

        // Check privacy settings
        let filteredStatuses = validStatuses;
        if (status.userId !== req.userId) {
          if (userPrivacy === 'nobody') {
            filteredStatuses = [];
          } else if (userPrivacy === 'contacts') {
            // Already filtered by contacts query
            filteredStatuses = validStatuses;
          } else if (userPrivacy === 'selected') {
            // Check if current user is in selected contacts
            // For now, treat as contacts (would need selected_contacts array in MongoDB)
            filteredStatuses = validStatuses;
          }
        }

        return {
          userId: status.userId,
          userName: user?.full_name || 'Unknown',
          profilePic: user?.profile_picture_url || null,
          statuses: filteredStatuses,
          createdAt: status.createdAt,
          updatedAt: status.updatedAt,
        };
      })
    );

    // Filter out users with no valid statuses
    const filteredStatusList = statusList.filter(s => s.statuses.length > 0);

    // Separate my status from others
    const myStatus = filteredStatusList.find(s => s.userId === req.userId);
    const othersStatus = filteredStatusList.filter(s => s.userId !== req.userId);

    res.json({
      success: true,
      data: {
        myStatus: myStatus || null,
        othersStatus: othersStatus,
        pagination: {
          page,
          limit,
          hasMore: statuses.length === limit,
        },
      },
    });
  } catch (error) {
    console.error('Get statuses error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statuses',
      error: error.message,
    });
  }
});

/**
 * Get User's Own Status
 * GET /api/status/me
 */
router.get('/me', verifyToken, async (req, res) => {
  try {
    const mongoDb = getMongoDB();
    const statusCollection = mongoDb.collection('status');

    const status = await statusCollection.findOne({
      userId: req.userId,
    });

    if (!status) {
      return res.json({
        success: true,
        data: null,
      });
    }

    // Get user info
    const userResult = await queryWithRetry(
      'SELECT id, full_name, profile_picture_url FROM users WHERE id = $1',
      [req.userId]
    );

    const user = userResult.rows[0];

    // Filter expired status items
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const validStatuses = (status.statuses || []).filter(statusItem => {
      const statusTime = new Date(statusItem.timestamp);
      return statusTime >= twentyFourHoursAgo;
    });

    res.json({
      success: true,
      data: {
        userId: status.userId,
        userName: user?.full_name || 'Unknown',
        profilePic: user?.profile_picture_url || null,
        statuses: validStatuses,
        createdAt: status.createdAt,
        updatedAt: status.updatedAt,
      },
    });
  } catch (error) {
    console.error('Get my status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch status',
      error: error.message,
    });
  }
});

/**
 * Add Status
 * POST /api/status
 * Supports: image, video, text
 */
router.post('/', verifyToken, statusRateLimit, uploadMessageFile, async (req, res) => {
  try {
    const { type, text, backgroundColor, textColor, fontFamily } = req.body;

    if (!type || !['image', 'video', 'text'].includes(type)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status type. Must be image, video, or text',
      });
    }

    if (type === 'text' && !text) {
      return res.status(400).json({
        success: false,
        message: 'Text is required for text status',
      });
    }

    if (type === 'text' && text.length > 500) {
      return res.status(400).json({
        success: false,
        message: 'Text status must be 500 characters or less',
      });
    }

    if ((type === 'image' || type === 'video') && !req.file) {
      return res.status(400).json({
        success: false,
        message: 'File is required for image/video status',
      });
    }

    // File size validation
    if (req.file) {
      const fileSize = req.file.size;
      if (type === 'image' && fileSize > MAX_IMAGE_SIZE) {
        // Delete uploaded file
        try {
          const { deleteFile } = await import('../middleware/upload.middleware.js');
          deleteFile(req.file.filename);
        } catch (e) {
          console.error('Error deleting oversized file:', e);
        }
        return res.status(400).json({
          success: false,
          message: `Image size exceeds limit. Maximum size is ${MAX_IMAGE_SIZE / (1024 * 1024)}MB`,
        });
      }
      if (type === 'video' && fileSize > MAX_VIDEO_SIZE) {
        // Delete uploaded file
        try {
          const { deleteFile } = await import('../middleware/upload.middleware.js');
          deleteFile(req.file.filename);
        } catch (e) {
          console.error('Error deleting oversized file:', e);
        }
        return res.status(400).json({
          success: false,
          message: `Video size exceeds limit. Maximum size is ${MAX_VIDEO_SIZE / (1024 * 1024)}MB`,
        });
      }
    }

    const mongoDb = getMongoDB();
    const statusCollection = mongoDb.collection('status');

    // Get user info
    const userResult = await queryWithRetry(
      'SELECT id, full_name, profile_picture_url FROM users WHERE id = $1',
      [req.userId]
    );

    const user = userResult.rows[0];

    // Create status item
    const statusItem = {
      id: new ObjectId().toString(),
      type: type,
      url: req.file ? getFileUrl(req, req.file.filename) : null,
      text: text || null,
      backgroundColor: backgroundColor || null,
      textColor: textColor || null,
      fontFamily: fontFamily || null,
      timestamp: new Date(),
      viewers: [],
    };

    // Check if user already has a status document
    const existingStatus = await statusCollection.findOne({
      userId: req.userId,
    });

    if (existingStatus) {
      // Add to existing statuses array
      await statusCollection.updateOne(
        { userId: req.userId },
        {
          $push: { statuses: statusItem },
          $set: { updatedAt: new Date() },
        }
      );
    } else {
      // Create new status document
      await statusCollection.insertOne({
        userId: req.userId,
        userName: user?.full_name || 'Unknown',
        profilePic: user?.profile_picture_url || null,
        statuses: [statusItem],
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // Emit socket event for real-time update
    emitStatusUpdate(req.userId, {
      type: 'status_added',
      userId: req.userId,
    });

    res.json({
      success: true,
      message: 'Status added successfully',
      data: statusItem,
    });
  } catch (error) {
    console.error('Add status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add status',
      error: error.message,
    });
  }
});

/**
 * View Status (mark as viewed)
 * POST /api/status/:statusId/view
 */
router.post('/:statusId/view', verifyToken, async (req, res) => {
  try {
    const { statusId } = req.params;
    const { userId: statusUserId } = req.body; // User who owns the status

    if (!statusUserId) {
      return res.status(400).json({
        success: false,
        message: 'Status user ID is required',
      });
    }

    const mongoDb = getMongoDB();
    const statusCollection = mongoDb.collection('status');

    // Don't allow viewing own status
    if (statusUserId === req.userId) {
      return res.json({
        success: true,
        message: 'Cannot view own status',
      });
    }

    // Fix: Use arrayFilters to update the specific status item by ID
    // This fixes the positional operator bug
    const result = await statusCollection.updateOne(
      {
        userId: statusUserId,
        'statuses.id': statusId,
      },
      {
        $addToSet: {
          'statuses.$[status].viewers': req.userId,
        },
        $set: { updatedAt: new Date() },
      },
      {
        arrayFilters: [
          {
            'status.id': statusId,
            'status.viewers': { $ne: req.userId },
          },
        ],
      }
    );

    // If arrayFilters didn't work (older MongoDB), fallback to fetch-modify-update
    if (result.matchedCount === 0) {
      const statusDoc = await statusCollection.findOne({
        userId: statusUserId,
        'statuses.id': statusId,
      });

      if (statusDoc) {
        const statusIndex = statusDoc.statuses.findIndex(s => s.id === statusId);
        if (statusIndex !== -1) {
          const statusItem = statusDoc.statuses[statusIndex];
          if (!statusItem.viewers || !statusItem.viewers.includes(req.userId)) {
            if (!statusItem.viewers) {
              statusItem.viewers = [];
            }
            statusItem.viewers.push(req.userId);
            statusDoc.updatedAt = new Date();

            await statusCollection.updateOne(
              { userId: statusUserId },
              {
                $set: {
                  statuses: statusDoc.statuses,
                  updatedAt: statusDoc.updatedAt,
                },
              }
            );

            // Emit socket event
            emitStatusUpdate(statusUserId, {
              type: 'status_viewed',
              statusId: statusId,
              viewerId: req.userId,
            });
          }
        }
      }
    } else if (result.modifiedCount > 0) {
      // Emit socket event
      emitStatusUpdate(statusUserId, {
        type: 'status_viewed',
        statusId: statusId,
        viewerId: req.userId,
      });
    }

    res.json({
      success: true,
      message: 'Status marked as viewed',
    });
  } catch (error) {
    console.error('View status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to mark status as viewed',
      error: error.message,
    });
  }
});

/**
 * Delete Status
 * DELETE /api/status/:statusId
 */
router.delete('/:statusId', verifyToken, async (req, res) => {
  try {
    const { statusId } = req.params;

    const mongoDb = getMongoDB();
    const statusCollection = mongoDb.collection('status');

    // Get the status to find the file URL for deletion
    const status = await statusCollection.findOne({
      userId: req.userId,
      'statuses.id': statusId,
    });

    if (!status) {
      return res.status(404).json({
        success: false,
        message: 'Status not found',
      });
    }

    const statusItem = status.statuses.find(s => s.id === statusId);
    if (statusItem && statusItem.url) {
      // Extract filename from URL and delete file
      const filename = statusItem.url.split('/').pop();
      let fileDeleted = false;
      let retryCount = 0;
      const maxRetries = 3;
      
      // Retry file deletion with exponential backoff
      while (!fileDeleted && retryCount < maxRetries) {
        try {
          deleteFile(filename);
          fileDeleted = true;
        } catch (fileError) {
          retryCount++;
          console.error(`Error deleting file ${filename} (attempt ${retryCount}/${maxRetries}):`, fileError);
          
          if (retryCount < maxRetries) {
            // Wait before retry (exponential backoff: 100ms, 200ms, 400ms)
            await new Promise(resolve => setTimeout(resolve, 100 * Math.pow(2, retryCount - 1)));
          } else {
            // Log final failure but continue with status deletion
            console.error(`Failed to delete file ${filename} after ${maxRetries} attempts. Status will still be deleted from database.`);
          }
        }
      }
    }

    // Remove status from array
    await statusCollection.updateOne(
      { userId: req.userId },
      {
        $pull: { statuses: { id: statusId } },
        $set: { updatedAt: new Date() },
      }
    );

    // If no statuses left, delete the document
    const updatedStatus = await statusCollection.findOne({
      userId: req.userId,
    });

    if (updatedStatus && (!updatedStatus.statuses || updatedStatus.statuses.length === 0)) {
      await statusCollection.deleteOne({ userId: req.userId });
    }

    // Emit socket event
    emitStatusUpdate(req.userId, {
      type: 'status_deleted',
      statusId: statusId,
    });

    res.json({
      success: true,
      message: 'Status deleted successfully',
    });
  } catch (error) {
    console.error('Delete status error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete status',
      error: error.message,
    });
  }
});

export default router;

