import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import https from 'https';

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

console.log('\n🔍 Verifying Supabase Configuration...\n');
console.log('=' .repeat(50));

// Extract Supabase project reference from hostname
let hostname = null;
let projectRef = null;

if (process.env.POSTGRES_URL) {
  try {
    const url = new URL(process.env.POSTGRES_URL);
    hostname = url.hostname;
  } catch (e) {
    const match = process.env.POSTGRES_URL.match(/@([^:]+):/);
    if (match) hostname = match[1];
  }
} else {
  hostname = process.env.POSTGRES_HOST;
}

if (hostname) {
  // Extract project reference (the part before .supabase.co)
  const match = hostname.match(/db\.([^.]+)\.supabase\.co/);
  if (match) {
    projectRef = match[1];
  }
}

console.log(`Hostname: ${hostname || 'not found'}`);
if (projectRef) {
  console.log(`Project Reference: ${projectRef}`);
}
console.log('');

// Test if Supabase API is accessible
console.log('1️⃣ Testing Supabase API connectivity...');
const testSupabaseAPI = () => {
  return new Promise((resolve, reject) => {
    https.get('https://api.supabase.com', (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 404); // 404 is fine, means API is reachable
    }).on('error', (err) => {
      reject(err);
    });
  });
};

try {
  await testSupabaseAPI();
  console.log('✅ Supabase API is reachable\n');
} catch (error) {
  console.error(`❌ Cannot reach Supabase API: ${error.message}\n`);
}

// Check hostname format
console.log('2️⃣ Validating hostname format...');
if (hostname) {
  if (hostname.includes('supabase.co')) {
    console.log('✅ Hostname format looks correct (contains supabase.co)');
  } else {
    console.error('❌ Hostname does not contain supabase.co');
    console.error('   Expected format: db.xxxxx.supabase.co');
  }
  
  if (hostname.startsWith('db.')) {
    console.log('✅ Hostname starts with "db." (correct format)');
  } else {
    console.error('❌ Hostname should start with "db."');
  }
} else {
  console.error('❌ No hostname found in environment variables');
}

console.log('\n3️⃣ Recommendations:\n');
console.log('   📋 Check your Supabase Dashboard:');
console.log('      1. Go to https://supabase.com/dashboard');
console.log('      2. Select your project');
console.log('      3. Go to Settings → Database');
console.log('      4. Copy the exact connection string or hostname');
console.log('');
console.log('   🔍 Verify the hostname:');
if (hostname) {
  console.log(`      Current: ${hostname}`);
  console.log(`      Expected format: db.xxxxx.supabase.co`);
  console.log(`      Your format: ${hostname.match(/^db\.[^.]+\.supabase\.co$/) ? '✅ Correct' : '❌ Incorrect'}`);
}
console.log('');
console.log('   💡 Common issues:');
console.log('      - Project might be paused (check dashboard)');
console.log('      - Hostname might be incorrect (copy from dashboard)');
console.log('      - Using wrong connection type (try Connection Pooling)');
console.log('      - DNS cache issue (try: ipconfig /flushdns on Windows)');
console.log('');

// Try alternative DNS resolution
console.log('4️⃣ Testing with Google DNS (8.8.8.8)...');
import { lookup } from 'dns';
import { promisify } from 'util';

const lookupAsync = promisify(lookup);

if (hostname) {
  try {
    // Try with custom DNS (this is a simplified test)
    const result = await lookupAsync(hostname, { family: 4 });
    console.log(`✅ DNS resolution successful with default DNS!`);
    console.log(`   IP: ${result.address}\n`);
  } catch (error) {
    console.error(`❌ DNS resolution failed: ${error.message}\n`);
    console.log('   💡 Try these steps:');
    console.log('      1. Flush DNS cache: ipconfig /flushdns');
    console.log('      2. Check Supabase dashboard for correct hostname');
    console.log('      3. Verify project is not paused');
    console.log('      4. Try using Connection Pooling URL from Supabase');
    console.log('');
  }
}

console.log('=' .repeat(50));
console.log('\n✨ Verification complete!\n');
console.log('📝 Next steps:');
console.log('   1. Double-check the hostname in Supabase dashboard');
console.log('   2. Try using the "Connection Pooling" connection string');
console.log('   3. Ensure your Supabase project is active (not paused)');
console.log('   4. If using a VPN, try disconnecting it');
console.log('');

