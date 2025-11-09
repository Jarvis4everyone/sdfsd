import { lookup } from 'dns';
import { promisify } from 'util';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const lookupAsync = promisify(lookup);

// Load .env
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envPaths = [
  join(__dirname, '.env'),
  join(__dirname, '..', '.env'),
];

for (const envPath of envPaths) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

console.log('\n🔍 Testing PostgreSQL DNS Resolution...\n');
console.log('=' .repeat(50));

// Extract hostname from POSTGRES_URL or POSTGRES_HOST
let hostname = null;

if (process.env.POSTGRES_URL) {
  try {
    const url = new URL(process.env.POSTGRES_URL);
    hostname = url.hostname;
  } catch (e) {
    // If URL parsing fails, try to extract manually
    const match = process.env.POSTGRES_URL.match(/@([^:]+):/);
    if (match) {
      hostname = match[1];
    }
  }
} else {
  hostname = process.env.POSTGRES_HOST;
}

if (!hostname) {
  console.error('❌ Could not extract PostgreSQL hostname from environment variables');
  process.exit(1);
}

console.log(`Hostname: ${hostname}\n`);

// Test DNS lookup
console.log('1️⃣ Testing DNS resolution...');
try {
  const result = await lookupAsync(hostname);
  console.log(`✅ DNS resolution successful!`);
  console.log(`   IP Address: ${result.address}`);
  console.log(`   Family: IPv${result.family}\n`);
} catch (error) {
  console.error(`❌ DNS resolution failed: ${error.message}`);
  console.error('\n💡 Possible solutions:');
  console.error('   1. Check your internet connection');
  console.error('   2. Verify the hostname is correct');
  console.error('   3. Try pinging the hostname:');
  console.error(`      ping ${hostname}`);
  console.error('   4. Check if you\'re behind a firewall/proxy');
  console.error('   5. Try using a different DNS server (e.g., 8.8.8.8)');
  console.error('\n');
  process.exit(1);
}

// Test if we can reach the port
console.log('2️⃣ Testing port connectivity...');
import net from 'net';

const testPort = (host, port, timeout = 5000) => {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let resolved = false;

    socket.setTimeout(timeout);
    
    socket.once('connect', () => {
      resolved = true;
      socket.destroy();
      resolve(true);
    });

    socket.once('timeout', () => {
      resolved = true;
      socket.destroy();
      reject(new Error('Connection timeout'));
    });

    socket.once('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    socket.connect(port, host);
  });
};

const port = process.env.POSTGRES_PORT || 5432;

try {
  await testPort(hostname, port);
  console.log(`✅ Port ${port} is reachable!\n`);
} catch (error) {
  console.error(`❌ Cannot reach port ${port}: ${error.message}`);
  console.error('\n💡 Possible solutions:');
  console.error('   1. Check if the database server is running');
  console.error('   2. Verify the port number is correct');
  console.error('   3. Check firewall rules');
  console.error('   4. For Supabase, ensure your IP is whitelisted\n');
}

console.log('=' .repeat(50));
console.log('\n✨ DNS test complete!\n');

