import pg from 'pg';
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

const { Pool } = pg;

/**
 * PostgreSQL Connection Pool Configuration
 * Used for: Users, Authentication, Contact Lists, User Metadata
 * 
 * PROTECTIONS IMPLEMENTED:
 * - Large connection pool (50 connections)
 * - Extended timeouts for cloud connections
 * - Connection health monitoring
 * - Automatic connection recovery
 * - Connection leak detection
 * - Graceful error handling
 */
// Support both connection string and individual parameters
let postgresConfig;

// Detect if we're using Supabase (has strict connection limits)
const isSupabase = process.env.POSTGRES_URL && (
  process.env.POSTGRES_URL.includes('supabase.co') || 
  process.env.POSTGRES_URL.includes('supabase.com')
);

// Determine pool size based on database type
// Supabase has strict limits: Free tier = 4 connections, Pro = 60 connections
// For Supabase, we use much smaller pool to avoid "MaxClientsInSessionMode" errors
let POOL_SIZE, MIN_POOL_SIZE;

if (isSupabase) {
  // Supabase connection limits are VERY strict:
  // - Free tier: MAX 4 concurrent connections (we use 2 to leave buffer)
  // - Pro tier: MAX 60 concurrent connections
  // Using 2 instead of 4 leaves room for other connections
  POOL_SIZE = parseInt(process.env.POSTGRES_POOL_SIZE || '2', 10); // Reduced to 2 for free tier
  MIN_POOL_SIZE = parseInt(process.env.POSTGRES_MIN_POOL_SIZE || '0', 10); // Don't keep idle connections
  console.log('🔵 Detected Supabase - Using ULTRA-CONSERVATIVE pool size:', POOL_SIZE, '(Free tier limit: 4)');
  console.log('   💡 TIP: If you upgrade to Supabase Pro, set POSTGRES_POOL_SIZE=10 in .env');
} else {
  // For other databases, use larger pool
  POOL_SIZE = parseInt(process.env.POSTGRES_POOL_SIZE || '20', 10);
  MIN_POOL_SIZE = parseInt(process.env.POSTGRES_MIN_POOL_SIZE || '2', 10);
}

if (process.env.POSTGRES_URL) {
  // Use connection string if provided (for Supabase, etc.)
  // Clean up the URL - remove any quotes, whitespace, or variable name if accidentally included
  let connectionString = process.env.POSTGRES_URL.trim();
  connectionString = connectionString.replace(/^["']|["']$/g, ''); // Remove quotes
  // If somehow the variable name got included, extract just the value
  if (connectionString.startsWith('POSTGRES_URL=')) {
    connectionString = connectionString.substring('POSTGRES_URL='.length).trim();
    connectionString = connectionString.replace(/^["']|["']$/g, '');
  }
  
  // For Supabase, try to use connection pooler port (6543) if available
  // This allows more connections through pgBouncer
  if (isSupabase && !connectionString.includes(':6543') && !connectionString.includes('pooler')) {
    // Try to replace port 5432 with 6543 (Supabase pooler port)
    connectionString = connectionString.replace(/:5432\//, ':6543/');
    // Or add pooler mode if not present
    if (!connectionString.includes('?')) {
      connectionString += '?pgbouncer=true';
    } else if (!connectionString.includes('pgbouncer')) {
      connectionString += '&pgbouncer=true';
    }
    console.log('🔵 Using Supabase connection pooler for better connection management');
  }
  
  postgresConfig = {
    connectionString: connectionString,
    ssl: process.env.POSTGRES_SSL === 'false' ? false : { rejectUnauthorized: false },
    max: POOL_SIZE, // Adjusted for database type
    min: MIN_POOL_SIZE, // Minimum connections to maintain
    idleTimeoutMillis: isSupabase ? 10000 : 30000, // 10 seconds for Supabase - VERY aggressive cleanup
    connectionTimeoutMillis: 20000, // 20 seconds - shorter timeout for Supabase
    query_timeout: 20000, // 20 second query timeout for Supabase
    statement_timeout: 20000, // 20 second statement timeout
    allowExitOnIdle: isSupabase ? true : false, // Allow Supabase connections to close when idle
  };
} else {
  // Use individual parameters
  const isCloud = process.env.POSTGRES_HOST && !process.env.POSTGRES_HOST.includes('localhost');
  const isSupabaseHost = process.env.POSTGRES_HOST && (
    process.env.POSTGRES_HOST.includes('supabase.co') || 
    process.env.POSTGRES_HOST.includes('supabase.com')
  );
  
  // Adjust pool size if Supabase detected via host
  let effectivePoolSize = POOL_SIZE;
  let effectiveMinPoolSize = MIN_POOL_SIZE;
  
  if (isSupabaseHost) {
    effectivePoolSize = parseInt(process.env.POSTGRES_POOL_SIZE || '2', 10); // Reduced to 2
    effectiveMinPoolSize = parseInt(process.env.POSTGRES_MIN_POOL_SIZE || '0', 10); // No idle connections
    console.log('🔵 Detected Supabase via host - Using ULTRA-CONSERVATIVE pool size:', effectivePoolSize);
  }
  
  postgresConfig = {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    // Enable SSL for cloud databases (Supabase, etc.)
    ssl: isCloud || process.env.POSTGRES_SSL === 'true' 
      ? { rejectUnauthorized: false } 
      : false,
    max: effectivePoolSize, // Adjusted for database type
    min: effectiveMinPoolSize, // Minimum connections to maintain
    idleTimeoutMillis: isSupabaseHost ? 30000 : 60000, // Shorter for Supabase
    connectionTimeoutMillis: isSupabaseHost ? 30000 : 60000, // Shorter for Supabase
    query_timeout: isSupabaseHost ? 30000 : 45000, // Shorter for Supabase
    statement_timeout: isSupabaseHost ? 30000 : 45000, // Shorter for Supabase
    allowExitOnIdle: isSupabaseHost ? true : false, // Allow Supabase connections to close when idle
  };
}

const postgresPool = new Pool(postgresConfig);

// Connection pool statistics tracking
let poolStats = {
  totalConnections: 0,
  idleConnections: 0,
  activeConnections: 0,
  waitingClients: 0,
  errors: 0,
  lastError: null,
  lastHealthCheck: null,
  isHealthy: true,
};

// Update pool statistics
const updatePoolStats = () => {
  poolStats = {
    totalConnections: postgresPool.totalCount,
    idleConnections: postgresPool.idleCount,
    activeConnections: postgresPool.totalCount - postgresPool.idleCount,
    waitingClients: postgresPool.waitingCount,
    errors: poolStats.errors,
    lastError: poolStats.lastError,
    lastHealthCheck: new Date(),
    isHealthy: postgresPool.totalCount > 0 && postgresPool.idleCount >= MIN_POOL_SIZE,
  };
};

// Health check interval - every 30 seconds
setInterval(() => {
  updatePoolStats();
  if (!poolStats.isHealthy && poolStats.totalConnections === 0) {
    console.warn('⚠️  PostgreSQL pool health check: No connections available');
  }
  // For Supabase: Log connection stats to help debug
  if (isSupabase && poolStats.totalConnections > 0) {
    if (poolStats.totalConnections >= POOL_SIZE) {
      console.log(`🔵 Supabase pool: ${poolStats.totalConnections}/${POOL_SIZE} connections (${poolStats.idleCount} idle, ${poolStats.activeConnections} active)`);
    }
  }
}, 30000);

// CRITICAL: Set timezone to UTC for all connections to ensure consistent timestamp handling
// This ensures all timestamps are stored and retrieved in UTC regardless of server timezone
postgresPool.on('connect', async (client) => {
  try {
    await client.query("SET timezone = 'UTC'");
    updatePoolStats();
    // Only log on first few connections to avoid spam
    if (postgresPool.totalCount <= 3) {
      console.log('   ✅ PostgreSQL connection timezone set to UTC');
    }
  } catch (error) {
    console.error('   ⚠️  Warning: Could not set PostgreSQL timezone to UTC:', error.message);
    poolStats.lastError = error;
    poolStats.errors++;
  }
});

// Handle pool errors gracefully (don't crash the app)
postgresPool.on('error', (err) => {
  poolStats.lastError = err;
  poolStats.errors++;
  
  // Log error but don't crash
  const errorCode = err.code || 'UNKNOWN';
  const isConnectionError = 
    errorCode === 'ECONNRESET' || 
    errorCode === 'ETIMEDOUT' || 
    errorCode === 'ECONNREFUSED' ||
    err.message?.includes('Connection terminated') ||
    err.message?.includes('timeout') ||
    err.message?.includes('MaxClientsInSessionMode');
  
  if (isConnectionError) {
    console.warn(`⚠️  PostgreSQL pool connection error (${errorCode}):`, err.message);
  } else {
    console.error('❌ Unexpected error on idle PostgreSQL client:', err.message);
  }
  
  // Try to recover by updating stats
  updatePoolStats();
  
  // Don't exit - let the app continue and try to reconnect
  // The pool will handle reconnection automatically
});

// Monitor connection acquisition
postgresPool.on('acquire', () => {
  updatePoolStats();
});

// Monitor connection release
postgresPool.on('remove', () => {
  updatePoolStats();
});

// Connection queue to prevent too many simultaneous connections (especially for Supabase)
let connectionQueue = [];
let activeQueries = 0;
// For Supabase free tier: Only 1-2 concurrent queries max to stay under 4 connection limit
const MAX_CONCURRENT_QUERIES = isSupabase ? 1 : 10; // ULTRA-CONSERVATIVE: Only 1 at a time for Supabase

// Enhanced connection retry wrapper with many protections
export const queryWithRetry = async (queryText, params = [], retries = 3, timeout = 30000) => {
  let lastError = null;
  let timeoutId = null;
  
  // For Supabase, use fewer retries and shorter timeout
  if (isSupabase) {
    retries = Math.min(retries, 3);
    timeout = Math.min(timeout, 30000);
  }
  
  // Queue management for Supabase to prevent connection exhaustion
  if (isSupabase && activeQueries >= MAX_CONCURRENT_QUERIES) {
    // Wait in queue if too many active queries
    await new Promise((resolve) => {
      connectionQueue.push(resolve);
    });
  }
  
  for (let i = 0; i < retries; i++) {
    try {
      // Check pool health before attempting query
      updatePoolStats();
      
      // For Supabase, check if we're at connection limit - be VERY conservative
      if (isSupabase) {
        // If we have ANY active connections and no idle ones, wait longer
        if (postgresPool.totalCount > 0 && postgresPool.idleCount === 0) {
          // Wait longer to ensure connections are released
          await new Promise(resolve => setTimeout(resolve, 500 + (i * 200)));
        }
        // If we're at max pool size, wait even longer
        if (postgresPool.totalCount >= POOL_SIZE) {
          await new Promise(resolve => setTimeout(resolve, 1000 + (i * 300)));
        }
      }
      
      if (postgresPool.totalCount === 0 && i === 0) {
        // Wait a bit if pool is empty
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // Increment active queries counter
      activeQueries++;
      
      try {
        // Use Promise.race to implement query timeout
        const queryPromise = postgresPool.query(queryText, params);
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(new Error('Query timeout'));
          }, timeout);
        });
        
        try {
          const result = await Promise.race([queryPromise, timeoutPromise]);
          // Clear timeout if query succeeded
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          return result;
        } catch (raceError) {
          // Clear timeout on error
          if (timeoutId) {
            clearTimeout(timeoutId);
            timeoutId = null;
          }
          throw raceError;
        }
      } finally {
        // Decrement active queries counter
        activeQueries--;
        // Process queue if there's space
        if (connectionQueue.length > 0 && activeQueries < MAX_CONCURRENT_QUERIES) {
          const next = connectionQueue.shift();
          if (next) next();
        }
      }
      
    } catch (error) {
      lastError = error;
      const isLastAttempt = i === retries - 1;
      
      // Determine if this is a connection-related error that should be retried
      const errorCode = error.code || '';
      const errorMessage = error.message || '';
      
      const isConnectionError = 
        errorCode === 'ECONNRESET' || 
        errorCode === 'ETIMEDOUT' || 
        errorCode === 'ECONNREFUSED' ||
        errorCode === 'XX000' || // Internal error (like MaxClientsInSessionMode)
        errorMessage.includes('Connection terminated') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('MaxClientsInSessionMode') ||
        errorMessage.includes('max clients reached') ||
        errorMessage.includes('Query timeout');
      
      if (isConnectionError && !isLastAttempt) {
        // For Supabase MaxClients errors, wait longer before retry
        const baseWaitTime = errorMessage.includes('MaxClients') ? 3000 : 1000;
        const waitTime = Math.min(baseWaitTime * Math.pow(2, i), 15000); // Max 15s for Supabase
        console.warn(`⚠️  PostgreSQL query failed (attempt ${i + 1}/${retries}), retrying in ${waitTime}ms...`, 
          errorMessage.substring(0, 100));
        
        // Wait before retrying (exponential backoff)
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Update stats after error
        poolStats.errors++;
        poolStats.lastError = error;
        updatePoolStats();
        
        continue;
      }
      
      // If it's the last attempt or not a connection error, throw
      poolStats.errors++;
      poolStats.lastError = error;
      throw error;
    }
  }
  
  // Should never reach here, but just in case
  throw lastError || new Error('Query failed after all retries');
};

// Get pool statistics for monitoring
export const getPoolStats = () => {
  updatePoolStats();
  return { ...poolStats };
};

// Health check function
export const checkPoolHealth = async () => {
  try {
    updatePoolStats();
    const result = await queryWithRetry('SELECT NOW()', [], 2, 10000);
    return {
      healthy: true,
      stats: poolStats,
      timestamp: result.rows[0]?.now,
    };
  } catch (error) {
    return {
      healthy: false,
      stats: poolStats,
      error: error.message,
    };
  }
};

// Test connection
export const testPostgresConnection = async () => {
  try {
    // Debug: Show which config is being used
    const usingUrl = !!process.env.POSTGRES_URL;
    if (usingUrl) {
      const urlPreview = process.env.POSTGRES_URL.replace(/:[^:@]+@/, ':****@');
      console.log(`   Using POSTGRES_URL: ${urlPreview.substring(0, 60)}...`);
    } else {
      console.log(`   Using individual params: ${process.env.POSTGRES_HOST}:${process.env.POSTGRES_PORT}`);
    }
    
    const client = await postgresPool.connect();
    const result = await client.query('SELECT NOW()');
    console.log('✅ PostgreSQL connected successfully at:', result.rows[0].now);
    client.release();
    return true;
  } catch (error) {
    console.error('❌ PostgreSQL connection error:', error.message);
    if (error.code === 'ENOTFOUND') {
      console.error('   💡 Tip: DNS lookup failed. Check:');
      console.error('      - Is POSTGRES_URL set correctly?');
      console.error('      - Is the hostname correct?');
      console.error('      - Do you have internet connection?');
    } else if (error.code === '28P01') {
      console.error('   💡 Tip: Authentication failed. Check your POSTGRES_USER and POSTGRES_PASSWORD');
    } else if (error.message.includes('SSL')) {
      console.error('   💡 Tip: For Supabase/cloud databases, set POSTGRES_SSL=true or use POSTGRES_URL');
    } else if (error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
      console.error('   💡 Tip: Connection timeout. Check:');
      console.error('      - Is the database server running?');
      console.error('      - Is the hostname and port correct?');
      console.error('      - Are firewall rules allowing the connection?');
    }
    return false;
  }
};

export default postgresPool;

