import express from 'express';
import postgresPool, { queryWithRetry } from '../config/postgres.config.js';
import { verifyToken } from './auth.routes.js';
import { getUserPresenceData } from '../utils/presence.utils.js';
import { filterBlockedUsers } from '../utils/block.utils.js';

const router = express.Router();

/**
 * Get User's Contacts
 * GET /api/contacts
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    // CRITICAL: Convert last_seen to UTC to ensure consistent timezone handling
    const result = await postgresPool.query(
      `SELECT 
        c.id,
        c.contact_phone_number,
        c.contact_country_code,
        c.contact_name,
        c.is_blocked,
        c.created_at,
        u.id as user_id,
        u.full_name,
        u.profile_picture_url,
        u.is_online,
        (u.last_seen AT TIME ZONE 'UTC')::timestamp as last_seen
      FROM contacts c
      LEFT JOIN users u ON u.phone_number = c.contact_phone_number 
        AND u.country_code = c.contact_country_code
      WHERE c.user_id = $1
      ORDER BY c.contact_name ASC, c.created_at DESC`,
      [req.userId]
    );

    // Get blocked users list
    const blockedUserIds = await queryWithRetry(
      `SELECT blocked_id FROM blocked_users WHERE blocker_id = $1
       UNION
       SELECT blocker_id FROM blocked_users WHERE blocked_id = $1`,
      [req.userId],
      3,
      20000
    );
    const blockedIds = new Set(blockedUserIds.rows.map(row => row.blocked_id));

    const contacts = result.rows
      .filter((row) => {
        // Filter out blocked users (either direction)
        if (row.user_id && blockedIds.has(row.user_id)) {
          return false;
        }
        return true;
      })
      .map((row) => {
        // Use centralized presence utility for consistent online status calculation
        let userPresenceData = null;
        if (row.user_id) {
          // Create user object from row data
          const user = {
            id: row.user_id,
            full_name: row.full_name,
            phone_number: null, // Not needed for presence
            country_code: null, // Not needed for presence
            bio: null, // Not needed for presence
            profile_picture_url: row.profile_picture_url,
            is_online: row.is_online,
            last_seen: row.last_seen,
            timezone: null, // Not needed for presence
          };
          userPresenceData = getUserPresenceData(user);
        }
        
        return {
          id: row.id,
          phoneNumber: row.contact_phone_number,
          countryCode: row.contact_country_code,
          name: row.contact_name,
          isBlocked: row.is_blocked,
          isOnAxzora: row.user_id !== null,
          user: userPresenceData
            ? {
                id: userPresenceData.id,
                fullName: userPresenceData.fullName,
                profilePictureUrl: userPresenceData.profilePictureUrl,
                isOnline: userPresenceData.isOnline,
                lastSeen: userPresenceData.lastSeen, // Already serialized as ISO string
              }
            : null,
          createdAt: row.created_at,
        };
      });

    res.json({
      success: true,
      data: {
        contacts,
        total: contacts.length,
        onAxzora: contacts.filter((c) => c.isOnAxzora).length,
      },
    });
  } catch (error) {
    console.error('Get contacts error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Add Contact
 * POST /api/contacts
 */
router.post('/', verifyToken, async (req, res) => {
  try {
    const { phoneNumber, countryCode, name } = req.body;

    if (!phoneNumber || !countryCode) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and country code are required',
      });
    }

    // Check if contact already exists
    const existing = await postgresPool.query(
      `SELECT id FROM contacts 
       WHERE user_id = $1 AND contact_phone_number = $2 AND contact_country_code = $3`,
      [req.userId, phoneNumber, countryCode]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Contact already exists',
      });
    }

    // Add contact
    const result = await postgresPool.query(
      `INSERT INTO contacts (user_id, contact_phone_number, contact_country_code, contact_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, contact_phone_number, contact_country_code, contact_name, created_at`,
      [req.userId, phoneNumber, countryCode, name || null]
    );

    // Check if this contact is on AXZORA
    // CRITICAL: Convert last_seen to UTC to ensure consistent timezone handling
    const userResult = await postgresPool.query(
      `SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_seen, timezone 
       FROM users 
       WHERE phone_number = $1 AND country_code = $2`,
      [phoneNumber, countryCode]
    );

    const contact = result.rows[0];
    
    // Use centralized presence utility for consistent online status calculation
    let userPresenceData = null;
    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];
      userPresenceData = getUserPresenceData(user);
    }
    
    const contactData = {
      id: contact.id,
      phoneNumber: contact.contact_phone_number,
      countryCode: contact.contact_country_code,
      name: contact.contact_name,
      isBlocked: false,
      isOnAxzora: userResult.rows.length > 0,
      user: userPresenceData
        ? {
            id: userPresenceData.id,
            fullName: userPresenceData.fullName,
            profilePictureUrl: userPresenceData.profilePictureUrl,
            isOnline: userPresenceData.isOnline,
            lastSeen: userPresenceData.lastSeen, // Already serialized as ISO string
          }
        : null,
      createdAt: contact.created_at,
    };

    res.status(201).json({
      success: true,
      message: 'Contact added successfully',
      data: contactData,
    });
  } catch (error) {
    console.error('Add contact error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Sync Contacts (Bulk Add)
 * POST /api/contacts/sync
 */
router.post('/sync', verifyToken, async (req, res) => {
  try {
    const { contacts } = req.body; // Array of {phoneNumber, countryCode, name}

    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Contacts array is required',
      });
    }

    const added = [];
    const skipped = [];

    for (const contact of contacts) {
      const { phoneNumber, countryCode, name } = contact;

      if (!phoneNumber || !countryCode) {
        skipped.push({ contact, reason: 'Missing phone number or country code' });
        continue;
      }

      try {
        // Check if already exists
        const existing = await postgresPool.query(
          `SELECT id FROM contacts 
           WHERE user_id = $1 AND contact_phone_number = $2 AND contact_country_code = $3`,
          [req.userId, phoneNumber, countryCode]
        );

        if (existing.rows.length > 0) {
          skipped.push({ contact, reason: 'Already exists' });
          continue;
        }

        // Insert contact
        await postgresPool.query(
          `INSERT INTO contacts (user_id, contact_phone_number, contact_country_code, contact_name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, contact_phone_number, contact_country_code) DO NOTHING`,
          [req.userId, phoneNumber, countryCode, name || null]
        );

        added.push({ phoneNumber, countryCode, name });
      } catch (error) {
        skipped.push({ contact, reason: error.message });
      }
    }

    res.json({
      success: true,
      message: `Synced ${added.length} contacts`,
      data: {
        added: added.length,
        skipped: skipped.length,
        details: {
          added,
          skipped,
        },
      },
    });
  } catch (error) {
    console.error('Sync contacts error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Search Users by Phone Number
 * GET /api/contacts/search?phoneNumber=...&countryCode=...
 */
router.get('/search', verifyToken, async (req, res) => {
  try {
    let { phoneNumber, countryCode } = req.query;

    if (!phoneNumber || !countryCode) {
      return res.status(400).json({
        success: false,
        message: 'Phone number and country code are required',
      });
    }

    // Normalize phone number (remove spaces, dashes, parentheses)
    phoneNumber = phoneNumber.replace(/[\s\-\(\)]/g, '');
    
    // Normalize country code (ensure it starts with +)
    countryCode = countryCode.trim();
    if (!countryCode.startsWith('+')) {
      countryCode = '+' + countryCode;
    }

    console.log(`Searching for user: phoneNumber="${phoneNumber}", countryCode="${countryCode}"`);

    // Search for user - try exact match first
    // CRITICAL: Convert last_seen to UTC to ensure consistent timezone handling
    let result = await postgresPool.query(
      `SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_seen, timezone
       FROM users
       WHERE phone_number = $1 AND country_code = $2`,
      [phoneNumber, countryCode]
    );

    // If not found, try with normalized phone (remove leading zeros, etc.)
    if (result.rows.length === 0) {
      // Try removing leading zeros from phone number
      const normalizedPhone = phoneNumber.replace(/^0+/, '');
      if (normalizedPhone !== phoneNumber) {
        result = await postgresPool.query(
          `SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_seen, timezone
           FROM users
           WHERE phone_number = $1 AND country_code = $2`,
          [normalizedPhone, countryCode]
        );
      }
    }

    // If still not found, try with phone number that might have leading zeros
    if (result.rows.length === 0) {
      const withLeadingZero = '0' + phoneNumber;
      result = await postgresPool.query(
        `SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_seen, timezone
         FROM users
         WHERE phone_number = $1 AND country_code = $2`,
        [withLeadingZero, countryCode]
      );
    }

    // Also try case-insensitive country code matching
    if (result.rows.length === 0) {
      result = await postgresPool.query(
        `SELECT id, full_name, phone_number, country_code, bio, profile_picture_url, is_online, to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as last_seen, timezone
         FROM users
         WHERE phone_number = $1 AND LOWER(country_code) = LOWER($2)`,
        [phoneNumber, countryCode]
      );
    }

    console.log(`Search result: ${result.rows.length} user(s) found`);

    if (result.rows.length === 0) {
      // Debug: Show what we searched for
      console.log(`No user found with phoneNumber="${phoneNumber}", countryCode="${countryCode}"`);
      
      // Let's also check what users exist in the database (for debugging)
      const allUsers = await postgresPool.query(
        'SELECT phone_number, country_code FROM users LIMIT 5'
      );
      console.log('Sample users in database:', allUsers.rows);
      
      return res.json({
        success: true,
        data: {
          found: false,
          message: 'User not found on AXZORA CHAT',
          searched: {
            phoneNumber,
            countryCode,
          },
        },
      });
    }

    const user = result.rows[0];
    
    // Check if user is blocked (either direction)
    const { isBlocked } = await import('../utils/block.utils.js');
    const blocked = await isBlocked(req.userId, user.id);
    if (blocked) {
      return res.json({
        success: true,
        data: {
          found: false,
          message: 'User not found on AXZORA CHAT',
          searched: {
            phoneNumber,
            countryCode,
          },
        },
      });
    }
    
    // Use centralized presence utility for consistent online status calculation
    const userPresenceData = getUserPresenceData(user);
    
    if (!userPresenceData) {
      return res.status(404).json({
        success: false,
        message: 'User not found',
      });
    }
    
    res.json({
      success: true,
      data: {
        found: true,
        user: {
          id: userPresenceData.id,
          fullName: userPresenceData.fullName,
          phoneNumber: userPresenceData.phoneNumber,
          countryCode: userPresenceData.countryCode,
          bio: userPresenceData.bio,
          profilePictureUrl: userPresenceData.profilePictureUrl,
          isOnline: userPresenceData.isOnline,
          lastSeen: userPresenceData.lastSeen, // Already serialized as ISO string
          timezone: userPresenceData.timezone,
        },
      },
    });
  } catch (error) {
    console.error('Search user error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

/**
 * Delete Contact
 * DELETE /api/contacts/:contactId
 */
router.delete('/:contactId', verifyToken, async (req, res) => {
  try {
    const { contactId } = req.params;

    const result = await postgresPool.query(
      `DELETE FROM contacts WHERE id = $1 AND user_id = $2 RETURNING id`,
      [contactId, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Contact not found',
      });
    }

    res.json({
      success: true,
      message: 'Contact deleted successfully',
    });
  } catch (error) {
    console.error('Delete contact error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
});

export default router;

