import express from 'express';
import postgresPool from '../config/postgres.config.js';
import { verifyToken } from './auth.routes.js';

const router = express.Router();

/**
 * Get User Settings
 * GET /api/settings
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const result = await postgresPool.query(
      `SELECT theme, notifications_enabled, sound_enabled, read_receipts_enabled, 
              show_online_status, language, updated_at
       FROM user_settings WHERE user_id = $1`,
      [req.userId]
    );

    if (result.rows.length === 0) {
      // Create default settings if they don't exist
      await postgresPool.query(
        'INSERT INTO user_settings (user_id) VALUES ($1)',
        [req.userId]
      );
      
      // Return default settings
      return res.json({
        success: true,
        data: {
          theme: 'light',
          notificationsEnabled: true,
          soundEnabled: true,
          readReceiptsEnabled: true,
          showOnlineStatus: true,
          language: 'en',
        },
      });
    }

    const settings = result.rows[0];

    res.json({
      success: true,
      data: {
        theme: settings.theme,
        notificationsEnabled: settings.notifications_enabled,
        soundEnabled: settings.sound_enabled,
        readReceiptsEnabled: settings.read_receipts_enabled,
        showOnlineStatus: settings.show_online_status,
        language: settings.language,
        updatedAt: settings.updated_at,
      },
    });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Update User Settings
 * PUT /api/settings
 */
router.put('/', verifyToken, async (req, res) => {
  try {
    const {
      theme,
      notificationsEnabled,
      soundEnabled,
      readReceiptsEnabled,
      showOnlineStatus,
      language,
    } = req.body;

    // Build update query dynamically
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (theme !== undefined) {
      if (!['light', 'dark', 'system'].includes(theme)) {
        return res.status(400).json({
          success: false,
          message: 'Invalid theme. Must be: light, dark, or system',
        });
      }
      updates.push(`theme = $${paramCount++}`);
      values.push(theme);
    }

    if (notificationsEnabled !== undefined) {
      updates.push(`notifications_enabled = $${paramCount++}`);
      values.push(notificationsEnabled);
    }

    if (soundEnabled !== undefined) {
      updates.push(`sound_enabled = $${paramCount++}`);
      values.push(soundEnabled);
    }

    if (readReceiptsEnabled !== undefined) {
      updates.push(`read_receipts_enabled = $${paramCount++}`);
      values.push(readReceiptsEnabled);
    }

    if (showOnlineStatus !== undefined) {
      updates.push(`show_online_status = $${paramCount++}`);
      values.push(showOnlineStatus);
    }

    if (language !== undefined) {
      updates.push(`language = $${paramCount++}`);
      values.push(language);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No settings to update',
      });
    }

    values.push(req.userId);

    // Ensure settings exist
    await postgresPool.query(
      `INSERT INTO user_settings (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO NOTHING`,
      [req.userId]
    );

    const query = `
      UPDATE user_settings 
      SET ${updates.join(', ')}
      WHERE user_id = $${paramCount}
      RETURNING theme, notifications_enabled, sound_enabled, read_receipts_enabled, 
                show_online_status, language, updated_at
    `;

    const result = await postgresPool.query(query, values);
    const settings = result.rows[0];

    res.json({
      success: true,
      message: 'Settings updated successfully',
      data: {
        theme: settings.theme,
        notificationsEnabled: settings.notifications_enabled,
        soundEnabled: settings.sound_enabled,
        readReceiptsEnabled: settings.read_receipts_enabled,
        showOnlineStatus: settings.show_online_status,
        language: settings.language,
        updatedAt: settings.updated_at,
      },
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

export default router;

