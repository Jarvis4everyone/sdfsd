/**
 * Block/Unblock User Routes
 * Handles user blocking functionality
 */

import express from 'express';
import { verifyToken } from './auth.routes.js';
import postgresPool, { queryWithRetry } from '../config/postgres.config.js';
import { getMongoDB } from '../config/mongodb.config.js';

const router = express.Router();

/**
 * Get Blocked Users List
 * GET /api/block
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await queryWithRetry(
      `SELECT 
        bu.blocked_id,
        bu.created_at as blocked_at,
        u.full_name,
        u.profile_picture_url,
        u.phone_number,
        u.country_code
       FROM blocked_users bu
       JOIN users u ON u.id = bu.blocked_id
       WHERE bu.blocker_id = $1
       ORDER BY bu.created_at DESC`,
      [req.userId],
      3,
      20000
    );

    const blockedUsers = result.rows.map((row) => ({
      id: row.blocked_id,
      fullName: row.full_name,
      profilePictureUrl: row.profile_picture_url,
      phoneNumber: row.phone_number,
      countryCode: row.country_code,
      blockedAt: row.blocked_at,
    }));

    res.json({
      success: true,
      data: {
        blockedUsers,
        total: blockedUsers.length,
      },
    });
  } catch (error) {
    console.error('Get blocked users error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Unblock All Users
 * DELETE /api/block/all
 * NOTE: Must be before /:userId route to avoid route conflict
 */
router.delete('/all', verifyToken, async (req, res) => {
  try {
    // Get all blocked users by current user
    const blockedResult = await queryWithRetry(
      'SELECT blocked_id FROM blocked_users WHERE blocker_id = $1',
      [req.userId],
      3,
      20000
    );

    if (blockedResult.rows.length === 0) {
      return res.json({
        success: true,
        message: 'No blocked users to unblock',
        data: {
          unblockedCount: 0,
        },
      });
    }

    const blockedIds = blockedResult.rows.map(row => row.blocked_id);

    // Unblock all users
    await queryWithRetry(
      'DELETE FROM blocked_users WHERE blocker_id = $1',
      [req.userId],
      3,
      20000
    );

    // Also unmark as blocked in contacts
    if (blockedIds.length > 0) {
      await queryWithRetry(
        'UPDATE contacts SET is_blocked = false WHERE user_id = $1 AND contact_user_id = ANY($2::uuid[])',
        [req.userId, blockedIds],
        3,
        20000
      );
    }

    res.json({
      success: true,
      message: `Successfully unblocked ${blockedIds.length} user(s)`,
      data: {
        unblockedCount: blockedIds.length,
      },
    });
  } catch (error) {
    console.error('Unblock all users error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Check if user is blocked (either direction)
 * GET /api/block/check/:userId
 */
router.get('/check/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const currentUserId = req.userId;

    // Check if current user blocked the other user
    const blockedByMe = await queryWithRetry(
      'SELECT id FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
      [currentUserId, userId],
      3,
      20000
    );

    // Check if other user blocked current user
    const blockedByThem = await queryWithRetry(
      'SELECT id FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
      [userId, currentUserId],
      3,
      20000
    );

    res.json({
      success: true,
      data: {
        isBlockedByMe: blockedByMe.rows.length > 0,
        isBlockedByThem: blockedByThem.rows.length > 0,
        isBlocked: blockedByMe.rows.length > 0 || blockedByThem.rows.length > 0,
      },
    });
  } catch (error) {
    console.error('Check block status error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Block User
 * POST /api/block/:userId
 */
router.post('/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const blockerId = req.userId;

    if (userId === blockerId) {
      return res.status(400).json({
        success: false,
        message: 'Cannot block yourself',
      });
    }

    // Verify user exists
    const userResult = await queryWithRetry(
      'SELECT id FROM users WHERE id = $1',
      [userId],
      3,
      20000
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }

    // Check if already blocked
    const existingBlock = await queryWithRetry(
      'SELECT id FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
      [blockerId, userId],
      3,
      20000
    );

    if (existingBlock.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'User is already blocked',
      });
    }

    // Block user
    await queryWithRetry(
      'INSERT INTO blocked_users (blocker_id, blocked_id) VALUES ($1, $2)',
      [blockerId, userId],
      3,
      20000
    );

    // Also mark as blocked in contacts if exists
    await queryWithRetry(
      'UPDATE contacts SET is_blocked = true WHERE user_id = $1 AND contact_user_id = $2',
      [blockerId, userId],
      3,
      20000
    );

    res.json({
      success: true,
      message: 'User blocked successfully',
    });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Unblock User
 * DELETE /api/block/:userId
 */
router.delete('/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const blockerId = req.userId;

    // Check if user is blocked
    const existingBlock = await queryWithRetry(
      'SELECT id FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
      [blockerId, userId],
      3,
      20000
    );

    if (existingBlock.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'User is not blocked',
      });
    }

    // Unblock user
    await queryWithRetry(
      'DELETE FROM blocked_users WHERE blocker_id = $1 AND blocked_id = $2',
      [blockerId, userId],
      3,
      20000
    );

    // Also unmark as blocked in contacts if exists
    await queryWithRetry(
      'UPDATE contacts SET is_blocked = false WHERE user_id = $1 AND contact_user_id = $2',
      [blockerId, userId],
      3,
      20000
    );

    res.json({
      success: true,
      message: 'User unblocked successfully',
    });
  } catch (error) {
    console.error('Unblock user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});


export default router;

