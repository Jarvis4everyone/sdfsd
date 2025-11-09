import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('\n🔧 MongoDB URI Encoding Fixer\n');
console.log('=' .repeat(50));

// Find .env file
const envPaths = [
  join(__dirname, '.env'),
  join(__dirname, '..', '.env'),
];

let envPath = null;
for (const path of envPaths) {
  if (existsSync(path)) {
    envPath = path;
    break;
  }
}

if (!envPath) {
  console.error('❌ .env file not found!');
  process.exit(1);
}

console.log(`✅ Found .env at: ${envPath}\n`);

// Read .env file
let envContent = readFileSync(envPath, 'utf-8');
let modified = false;

// Fix MONGO_URI if it contains unencoded special characters
const mongoUriMatch = envContent.match(/^MONGO_URI=(.+)$/m);
if (mongoUriMatch) {
  const originalUri = mongoUriMatch[1].trim();
  
  // Check if URI has unencoded & character in password
  if (originalUri.includes('://') && originalUri.includes('@')) {
    const uriRegex = /^(mongodb(\+srv)?):\/\/([^:]+):([^@]+)@(.+)$/;
    const match = originalUri.match(uriRegex);
    
    if (match) {
      const [, protocol, , user, password, rest] = match;
      
      // Check if password needs encoding
      const decodedPassword = decodeURIComponent(password);
      if (decodedPassword !== password || password.includes('&') || password.includes('@') || password.includes(':')) {
        // Password might need encoding
        const encodedUser = encodeURIComponent(user);
        const encodedPassword = encodeURIComponent(decodedPassword);
        const newUri = `${protocol}://${encodedUser}:${encodedPassword}@${rest}`;
        
        if (newUri !== originalUri) {
          envContent = envContent.replace(
            /^MONGO_URI=.*$/m,
            `MONGO_URI=${newUri}`
          );
          modified = true;
          console.log('✅ Fixed MONGO_URI encoding');
          console.log(`   Old: ${originalUri.substring(0, 50)}...`);
          console.log(`   New: ${newUri.substring(0, 50)}...`);
        }
      }
    }
  }
}

// Fix POSTGRES_URL if it contains unencoded special characters
const postgresUrlMatch = envContent.match(/^POSTGRES_URL=(.+)$/m);
if (postgresUrlMatch) {
  const originalUrl = postgresUrlMatch[1].trim();
  
  if (originalUrl.includes('://') && originalUrl.includes('@')) {
    const urlRegex = /^postgresql:\/\/([^:]+):([^@]+)@(.+)$/;
    const match = originalUrl.match(urlRegex);
    
    if (match) {
      const [, user, password, rest] = match;
      
      // Check if password needs encoding
      const decodedPassword = decodeURIComponent(password);
      if (decodedPassword !== password || password.includes('&') || password.includes('@') || password.includes(':')) {
        const encodedUser = encodeURIComponent(user);
        const encodedPassword = encodeURIComponent(decodedPassword);
        const newUrl = `postgresql://${encodedUser}:${encodedPassword}@${rest}`;
        
        if (newUrl !== originalUrl) {
          envContent = envContent.replace(
            /^POSTGRES_URL=.*$/m,
            `POSTGRES_URL=${newUrl}`
          );
          modified = true;
          console.log('✅ Fixed POSTGRES_URL encoding');
          console.log(`   Old: ${originalUrl.substring(0, 50)}...`);
          console.log(`   New: ${newUrl.substring(0, 50)}...`);
        }
      }
    }
  }
}

if (modified) {
  // Backup original file
  const backupPath = envPath + '.backup';
  writeFileSync(backupPath, readFileSync(envPath, 'utf-8'));
  console.log(`\n📦 Backup created: ${backupPath}`);
  
  // Write fixed content
  writeFileSync(envPath, envContent);
  console.log('✅ .env file updated with properly encoded URLs\n');
} else {
  console.log('✅ No encoding fixes needed - URLs are already properly formatted\n');
}

console.log('=' .repeat(50));
console.log('\n✨ Done! You can now run: npm run test:connections\n');

