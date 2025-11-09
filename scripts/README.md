# Reset Scripts

These scripts allow you to clear all data from the application databases.

## ⚠️ Warning

**These scripts will permanently delete all data!** Use with caution.

## Available Scripts

### 1. Reset All Data (`reset-all-data.js`)

Clears all data from PostgreSQL, MongoDB, and Redis.

**Usage:**
```bash
# From backend directory
node scripts/reset-all-data.js

# Or using npm script
npm run reset:all
```

**What it clears:**
- ✅ All users from PostgreSQL
- ✅ All contacts from PostgreSQL
- ✅ All user settings from PostgreSQL
- ✅ All chats from MongoDB
- ✅ All messages from MongoDB
- ✅ All Redis keys (sessions, unread counts, typing status)

### 2. Reset PostgreSQL Only (`reset-database.js`)

Clears only PostgreSQL data (users, contacts, settings).

**Usage:**
```bash
# From backend directory
node scripts/reset-database.js

# Or using npm script
npm run reset:db
```

### 3. Reset MongoDB Only (`reset-mongodb.js`)

Clears only MongoDB data (chats and messages).

**Usage:**
```bash
# From backend directory
node scripts/reset-mongodb.js

# Or using npm script
npm run reset:mongo
```

### 4. Reset Redis Only (`reset-redis.js`)

Clears only Redis data (sessions, unread counts, typing status).

**Usage:**
```bash
# From backend directory
node scripts/reset-redis.js

# Or using npm script
npm run reset:redis
```

## Quick Reset (From Project Root)

### Windows
```bash
reset-app.bat
```

### Linux/Mac
```bash
chmod +x reset-app.sh
./reset-app.sh
```

## What Gets Cleared

### PostgreSQL
- `users` table (all user accounts)
- `contacts` table (all user contacts)
- `user_settings` table (all user settings)

### MongoDB
- `chats` collection (all chat conversations)
- `messages` collection (all chat messages)

### Redis
- All session keys (`session:*`)
- All unread count keys (`unread:*`)
- All typing status keys (`typing:*`)
- Any other cached data

## After Reset

After running the reset script:
1. All user accounts will be deleted
2. All chats and messages will be deleted
3. All sessions will be cleared
4. The application will be in a fresh state

**Note:** You may need to restart your backend server after resetting.

## Troubleshooting

If you encounter errors:
1. Make sure your `.env` file is properly configured
2. Ensure all database connections are working
3. Check that the backend server is not running (or stop it before resetting)
4. Verify you have proper permissions to delete data

