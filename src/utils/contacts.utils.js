/**
 * Contacts Utility Functions
 * Helper functions for managing contacts automatically
 */

import { queryWithRetry } from '../config/postgres.config.js';

/**
 * Automatically add a user to contacts if not already present
 * This is called when a user chats with someone for the first time
 * @param {string} userId - The user who should have the contact added
 * @param {string} contactUserId - The user to add as a contact
 * @returns {Promise<boolean>} - True if contact was added, false if already exists or error
 */
export async function autoAddContact(userId, contactUserId) {
  try {
    // Get contact user's phone number and country code
    const contactUserResult = await queryWithRetry(
      'SELECT phone_number, country_code, full_name FROM users WHERE id = $1',
      [contactUserId],
      2,
      10000
    );

    if (contactUserResult.rows.length === 0) {
      // Contact user doesn't exist, can't add
      return false;
    }

    const contactUser = contactUserResult.rows[0];
    const phoneNumber = contactUser.phone_number;
    const countryCode = contactUser.country_code;
    const fullName = contactUser.full_name;

    // Check if contact already exists
    const existingContact = await queryWithRetry(
      'SELECT id FROM contacts WHERE user_id = $1 AND contact_phone_number = $2 AND contact_country_code = $3',
      [userId, phoneNumber, countryCode],
      2,
      10000
    );

    if (existingContact.rows.length > 0) {
      // Contact already exists, update contact_user_id if it's null
      await queryWithRetry(
        'UPDATE contacts SET contact_user_id = $1, updated_at = CURRENT_TIMESTAMP WHERE user_id = $2 AND contact_phone_number = $3 AND contact_country_code = $4 AND contact_user_id IS NULL',
        [contactUserId, userId, phoneNumber, countryCode],
        2,
        10000
      );
      return false; // Already exists
    }

    // Add contact
    await queryWithRetry(
      `INSERT INTO contacts (user_id, contact_phone_number, contact_country_code, contact_name, contact_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, contact_phone_number, contact_country_code) 
       DO UPDATE SET contact_user_id = EXCLUDED.contact_user_id, updated_at = CURRENT_TIMESTAMP`,
      [userId, phoneNumber, countryCode, fullName || null, contactUserId],
      2,
      10000
    );

    return true; // Successfully added
  } catch (error) {
    // Log error but don't throw - this is a convenience feature
    console.warn(`⚠️  Error auto-adding contact for user ${userId}:`, error.message);
    return false;
  }
}

