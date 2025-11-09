import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

// Get current directory (ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from backend directory or parent
const envPaths = [
  join(__dirname, '..', '..', '.env'),  // backend/.env
  join(__dirname, '..', '..', '..', '.env'),  // root/.env
  '.env',
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

/**
 * MongoDB Connection Configuration
 * Used for: Chat Messages, Attachments, Chat Threads
 */
// Build MongoDB URI - prioritize MONGO_URI, fallback to individual params
let mongoUri = process.env.MONGO_URI;

// Clean up the URI - remove any quotes, whitespace, or variable name if accidentally included
if (mongoUri) {
  mongoUri = mongoUri.trim();
  // Remove quotes if present
  mongoUri = mongoUri.replace(/^["']|["']$/g, '');
  // If somehow the variable name got included, extract just the value
  if (mongoUri.startsWith('MONGO_URI=')) {
    mongoUri = mongoUri.substring('MONGO_URI='.length).trim();
    mongoUri = mongoUri.replace(/^["']|["']$/g, '');
  }
}

if (!mongoUri) {
  // Construct from individual parameters
  const host = process.env.MONGO_HOST || 'localhost';
  const port = process.env.MONGO_PORT || '27017';
  const db = process.env.MONGO_DB || 'axzorachat';
  const user = process.env.MONGO_USER;
  const password = process.env.MONGO_PASSWORD;
  
  if (user && password) {
    // URL-encode username and password to handle special characters like &
    mongoUri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${db}`;
  } else {
    mongoUri = `mongodb://${host}:${port}/${db}`;
  }
} else {
  // MONGO_URI is provided - fix URL encoding for special characters
  const dbName = process.env.MONGO_DB || 'axzorachat';
  
  // First, check if URI has unencoded special characters (like & in password)
  // Extract and properly encode the URI components
  const uriMatch = mongoUri.match(/^(mongodb(\+srv)?):\/\/([^:]+):([^@]+)@(.+)$/);
  
  if (uriMatch) {
    // URI has username:password format - extract and encode
    const [, protocol, srv, user, password, rest] = uriMatch;
    const encodedUser = encodeURIComponent(user);
    const encodedPassword = encodeURIComponent(password);
    
    // Handle database name in rest part
    let dbPart = rest;
    if (!dbPart.includes('/') || dbPart.endsWith('/')) {
      // No database name or ends with /, add it
      dbPart = dbPart.endsWith('/') ? dbPart + dbName : dbPart + '/' + dbName;
    }
    
    // Rebuild URI with properly encoded credentials
    mongoUri = `${protocol}://${encodedUser}:${encodedPassword}@${dbPart}`;
  } else {
    // URI might not have credentials, just ensure database name is present
    if (mongoUri.endsWith('/')) {
      mongoUri = mongoUri + dbName;
    } else if (!mongoUri.match(/\/[^\/\?]+(\?|$)/)) {
      mongoUri = mongoUri + '/' + dbName;
    }
  }
  
  // Final validation - ensure URI starts with correct scheme
  if (!mongoUri.startsWith('mongodb://') && !mongoUri.startsWith('mongodb+srv://')) {
    throw new Error(`Invalid MongoDB URI scheme. URI must start with 'mongodb://' or 'mongodb+srv://'. Got: ${mongoUri.substring(0, 20)}...`);
  }
}

const mongoOptions = {
  maxPoolSize: 50, // Maximum number of connections in the pool
  minPoolSize: 5,
  socketTimeoutMS: 45000,
  serverSelectionTimeoutMS: 5000,
};

let mongoClient = null;
let mongoDb = null;

/**
 * Initialize MongoDB connection
 */
export const connectMongoDB = async () => {
  try {
    if (!mongoClient) {
      // Extract database name from URI or use env variable
      const dbName = process.env.MONGO_DB || 'axzorachat';
      
      // Validate URI format before connecting
      if (!mongoUri.startsWith('mongodb://') && !mongoUri.startsWith('mongodb+srv://')) {
        throw new Error(`Invalid MongoDB URI scheme. Must start with 'mongodb://' or 'mongodb+srv://'. Got: ${mongoUri.substring(0, 30)}...`);
      }
      
      // Debug: Show URI preview (hide password)
      const uriPreview = mongoUri.replace(/:[^:@]+@/, ':****@');
      console.log(`   Connecting to: ${uriPreview.substring(0, 60)}...`);
      
      mongoClient = new MongoClient(mongoUri, mongoOptions);
      await mongoClient.connect();
      mongoDb = mongoClient.db(dbName);
      
      console.log('✅ MongoDB connected successfully');
      console.log(`   Database: ${mongoDb.databaseName}`);
      return mongoDb;
    }
    return mongoDb;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error.message);
    if (error.message.includes('Invalid scheme')) {
      console.error('   💡 Tip: MONGO_URI must start with "mongodb://" or "mongodb+srv://"');
      console.error('   💡 Tip: If your password contains special characters (like &), they must be URL-encoded');
      console.error('   💡 Tip: Example: mongodb+srv://user:pass%26word@cluster.net/db');
    } else if (error.message.includes('ECONNREFUSED')) {
      console.error('   💡 Tip: Check if MONGO_URI is set correctly (not pointing to localhost)');
      console.error(`   Current URI: ${mongoUri.replace(/:[^:@]+@/, ':****@')}`); // Hide password
    } else if (error.message.includes('authentication') || error.message.includes('auth')) {
      console.error('   💡 Tip: Authentication failed. Check:');
      console.error('      - MONGO_USER and MONGO_PASSWORD are correct');
      console.error('      - Special characters in password are URL-encoded (e.g., & becomes %26)');
    }
    throw error;
  }
};

/**
 * Get MongoDB database instance
 */
export const getMongoDB = () => {
  if (!mongoDb) {
    throw new Error('MongoDB not connected. Call connectMongoDB() first.');
  }
  return mongoDb;
};

/**
 * Close MongoDB connection
 */
export const closeMongoDB = async () => {
  if (mongoClient) {
    await mongoClient.close();
    mongoClient = null;
    mongoDb = null;
    console.log('MongoDB connection closed');
  }
};

export default { connectMongoDB, getMongoDB, closeMongoDB };

