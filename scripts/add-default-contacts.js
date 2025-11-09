import postgresPool, { queryWithRetry } from '../src/config/postgres.config.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from backend directory
dotenv.config({ path: join(__dirname, '..', '.env') });

// Demo accounts to create
const DEMO_ACCOUNTS = [
  { phoneNumber: '9000000001', countryCode: '+91', fullName: 'Demo User 1' },
  { phoneNumber: '9000000002', countryCode: '+91', fullName: 'Demo User 2' },
  { phoneNumber: '9000000003', countryCode: '+91', fullName: 'Demo User 3' },
  { phoneNumber: '9000000004', countryCode: '+91', fullName: 'Demo User 4' },
  { phoneNumber: '9000000005', countryCode: '+91', fullName: 'Demo User 5' },
];

async function createDemoAccountsAndContacts() {
  try {
    console.log('🔄 Starting to create demo accounts and contacts...');

    const createdUsers = [];
    const userIds = [];

    // Step 1: Create 5 demo accounts
    console.log('\n📝 Step 1: Creating demo accounts...');
    for (const account of DEMO_ACCOUNTS) {
      try {
        // Check if user already exists
        const existingUser = await queryWithRetry(
          'SELECT id FROM users WHERE phone_number = $1 AND country_code = $2',
          [account.phoneNumber, account.countryCode],
          2,
          10000
        );

        if (existingUser.rows.length > 0) {
          console.log(`   ⚠️  User ${account.phoneNumber} already exists, skipping...`);
          userIds.push(existingUser.rows[0].id);
          continue;
        }

        // Create user
        const result = await queryWithRetry(
          `INSERT INTO users (phone_number, country_code, full_name, is_online, timezone, is_verified)
           VALUES ($1, $2, $3, false, 'Asia/Kolkata', true)
           RETURNING id, phone_number, country_code, full_name`,
          [account.phoneNumber, account.countryCode, account.fullName],
          2,
          10000
        );

        const user = result.rows[0];
        createdUsers.push(user);
        userIds.push(user.id);

        // Create default settings for new user
        try {
          await queryWithRetry(
            'INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
            [user.id],
            2,
            10000
          );
        } catch (error) {
          console.warn(`   ⚠️  Could not create settings for user ${user.id}:`, error.message);
        }

        console.log(`   ✅ Created user: ${user.full_name} (${user.country_code} ${user.phone_number})`);
      } catch (error) {
        console.error(`   ❌ Error creating user ${account.phoneNumber}:`, error.message);
      }
    }

    console.log(`\n📋 Created/Found ${userIds.length} users`);

    // Step 2: Add all 5 contacts to each user's contact list
    console.log('\n📝 Step 2: Adding contacts to each user...');
    let totalContactsAdded = 0;
    let totalContactsSkipped = 0;

    for (const userId of userIds) {
      // Get user info for logging
      const userInfo = await queryWithRetry(
        'SELECT phone_number, country_code, full_name FROM users WHERE id = $1',
        [userId],
        2,
        10000
      );
      const user = userInfo.rows[0];

      console.log(`\n   👤 Processing user: ${user.full_name} (${user.country_code} ${user.phone_number})`);

      for (const contactAccount of DEMO_ACCOUNTS) {
        try {
          // Skip adding self as contact
          if (contactAccount.phoneNumber === user.phone_number) {
            continue;
          }

          // Get contact user ID if they exist
          const contactUserResult = await queryWithRetry(
            'SELECT id FROM users WHERE phone_number = $1 AND country_code = $2',
            [contactAccount.phoneNumber, contactAccount.countryCode],
            2,
            10000
          );

          const contactUserId = contactUserResult.rows.length > 0 ? contactUserResult.rows[0].id : null;

          // Check if contact already exists
          const existing = await queryWithRetry(
            `SELECT id FROM contacts 
             WHERE user_id = $1 AND contact_phone_number = $2 AND contact_country_code = $3`,
            [userId, contactAccount.phoneNumber, contactAccount.countryCode],
            2,
            10000
          );

          if (existing.rows.length > 0) {
            // Update contact_user_id if it's null and contact user exists
            if (contactUserId) {
              await queryWithRetry(
                `UPDATE contacts 
                 SET contact_user_id = $1, updated_at = CURRENT_TIMESTAMP
                 WHERE user_id = $2 AND contact_phone_number = $3 AND contact_country_code = $4 AND contact_user_id IS NULL`,
                [contactUserId, userId, contactAccount.phoneNumber, contactAccount.countryCode],
                2,
                10000
              );
            }
            totalContactsSkipped++;
            continue;
          }

          // Add contact
          await queryWithRetry(
            `INSERT INTO contacts (user_id, contact_phone_number, contact_country_code, contact_name, contact_user_id)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (user_id, contact_phone_number, contact_country_code) 
             DO UPDATE SET contact_user_id = EXCLUDED.contact_user_id, updated_at = CURRENT_TIMESTAMP`,
            [userId, contactAccount.phoneNumber, contactAccount.countryCode, contactAccount.fullName, contactUserId],
            2,
            10000
          );

          totalContactsAdded++;
          console.log(`      ✅ Added contact: ${contactAccount.fullName} (${contactAccount.country_code} ${contactAccount.phoneNumber})`);
        } catch (error) {
          console.error(`      ❌ Error adding contact ${contactAccount.phoneNumber}:`, error.message);
          totalContactsSkipped++;
        }
      }
    }

    console.log(`\n✅ Completed!`);
    console.log(`   - Users created/found: ${userIds.length}`);
    console.log(`   - Contacts added: ${totalContactsAdded}`);
    console.log(`   - Contacts skipped: ${totalContactsSkipped} (already exist)`);
    console.log(`\n📱 Demo Accounts:`);
    DEMO_ACCOUNTS.forEach((account, index) => {
      console.log(`   ${index + 1}. ${account.fullName} - ${account.country_code} ${account.phoneNumber}`);
    });

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

// Run the script
createDemoAccountsAndContacts();

