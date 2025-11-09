import express from 'express';
import postgresPool from '../config/postgres.config.js';
import { verifyToken } from './auth.routes.js';

const router = express.Router();

/**
 * Get All Users (Admin endpoint)
 * GET /api/admin/users
 * Note: In production, add proper admin role checking
 */
router.get('/users', verifyToken, async (req, res) => {
  try {
    const result = await postgresPool.query(
      `SELECT 
        id, 
        full_name, 
        phone_number, 
        country_code, 
        bio, 
        profile_picture_url, 
        is_online, 
        last_seen, 
        created_at, 
        updated_at
       FROM users 
       ORDER BY created_at DESC`
    );

    res.json({
      success: true,
      data: {
        users: result.rows.map(user => ({
          id: user.id,
          fullName: user.full_name,
          phoneNumber: user.phone_number,
          countryCode: user.country_code,
          bio: user.bio,
          profilePictureUrl: user.profile_picture_url,
          isOnline: user.is_online,
          lastSeen: user.last_seen,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        })),
        total: result.rows.length,
      },
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Get User Count
 * GET /api/admin/users/count
 */
router.get('/users/count', verifyToken, async (req, res) => {
  try {
    const result = await postgresPool.query('SELECT COUNT(*) as count FROM users');
    
    res.json({
      success: true,
      data: {
        totalUsers: parseInt(result.rows[0].count),
      },
    });
  } catch (error) {
    console.error('Get user count error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

export default router;

