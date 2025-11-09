import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('\n🔍 Validating .env file format...\n');
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

// Read and validate .env file
const envContent = readFileSync(envPath, 'utf-8');
const lines = envContent.split('\n');
let issues = [];

console.log('Checking key variables:\n');

lines.forEach((line, index) => {
  const lineNum = index + 1;
  const trimmed = line.trim();
  
  // Skip empty lines and comments
  if (!trimmed || trimmed.startsWith('#')) {
    return;
  }
  
  // Check for common issues
  if (trimmed.includes('=')) {
    const [key, ...valueParts] = trimmed.split('=');
    const value = valueParts.join('='); // Rejoin in case value contains =
    
    // Check for spaces around =
    if (trimmed.includes(' = ') || trimmed.startsWith('=') || trimmed.endsWith('=')) {
      issues.push(`Line ${lineNum}: Spaces around '=' in "${key.trim()}"`);
    }
    
    // Check for quotes (sometimes needed, but let's flag them)
    if (value.startsWith('"') && value.endsWith('"')) {
      // This is okay, but let's note it
    } else if (value.startsWith("'") && value.endsWith("'")) {
      // This is okay too
    }
    
    // Check specific variables
    if (key.trim() === 'MONGO_URI') {
      const uriValue = value.trim().replace(/^["']|["']$/g, '');
      if (!uriValue.startsWith('mongodb://') && !uriValue.startsWith('mongodb+srv://')) {
        issues.push(`Line ${lineNum}: MONGO_URI doesn't start with mongodb:// or mongodb+srv://`);
      }
      if (uriValue.includes('MONGO_URI=')) {
        issues.push(`Line ${lineNum}: MONGO_URI value seems to include the variable name itself`);
      }
    }
    
    if (key.trim() === 'POSTGRES_URL') {
      const urlValue = value.trim().replace(/^["']|["']$/g, '');
      if (!urlValue.startsWith('postgresql://') && !urlValue.startsWith('postgres://')) {
        issues.push(`Line ${lineNum}: POSTGRES_URL doesn't start with postgresql:// or postgres://`);
      }
      if (urlValue.includes('POSTGRES_URL=')) {
        issues.push(`Line ${lineNum}: POSTGRES_URL value seems to include the variable name itself`);
      }
    }
    
    if (key.trim() === 'REDIS_URL') {
      const urlValue = value.trim().replace(/^["']|["']$/g, '');
      if (!urlValue.startsWith('redis://') && !urlValue.startsWith('rediss://')) {
        issues.push(`Line ${lineNum}: REDIS_URL doesn't start with redis:// or rediss://`);
      }
      if (urlValue.includes('REDIS_URL=')) {
        issues.push(`Line ${lineNum}: REDIS_URL value seems to include the variable name itself`);
      }
    }
  } else {
    // Line doesn't have =, might be malformed
    if (trimmed.length > 0) {
      issues.push(`Line ${lineNum}: No '=' found in line: "${trimmed.substring(0, 50)}"`);
    }
  }
});

if (issues.length > 0) {
  console.log('⚠️  Issues found:\n');
  issues.forEach(issue => console.log(`   ${issue}`));
  console.log('\n💡 Tips:');
  console.log('   - Ensure no spaces around the = sign');
  console.log('   - Values should not include the variable name');
  console.log('   - Example: MONGO_URI=mongodb+srv://user:pass@host/db');
  console.log('   - NOT: MONGO_URI=MONGO_URI=mongodb+srv://...');
} else {
  console.log('✅ No formatting issues found!');
}

console.log('\n' + '=' .repeat(50));
console.log('\n✨ Validation complete!\n');

