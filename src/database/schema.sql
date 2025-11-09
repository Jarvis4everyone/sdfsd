-- ============================================
-- COMPREHENSIVE DATABASE SCHEMA
-- Optimized for 10k+ daily users with full monitoring
-- ============================================

-- ============================================
-- USERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number VARCHAR(20) UNIQUE NOT NULL,
    country_code VARCHAR(10) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    bio TEXT,
    profile_picture_url TEXT,
    is_online BOOLEAN DEFAULT false,
    last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP,
    last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT true,
    is_verified BOOLEAN DEFAULT false,
    verification_code VARCHAR(10),
    verification_expires_at TIMESTAMP,
    device_info JSONB, -- Store device information
    metadata JSONB -- Additional user metadata
);

-- ============================================
-- USER SETTINGS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS user_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE NOT NULL,
    theme VARCHAR(20) DEFAULT 'light', -- light, dark, system
    notifications_enabled BOOLEAN DEFAULT true,
    sound_enabled BOOLEAN DEFAULT true,
    read_receipts_enabled BOOLEAN DEFAULT true,
    show_online_status BOOLEAN DEFAULT true,
    language VARCHAR(10) DEFAULT 'en',
    wallpaper_url TEXT,
    chat_background_color VARCHAR(20),
    font_size VARCHAR(20) DEFAULT 'medium', -- small, medium, large
    auto_download_media BOOLEAN DEFAULT true,
    auto_download_on_wifi BOOLEAN DEFAULT true,
    status_privacy VARCHAR(20) DEFAULT 'contacts', -- everyone, contacts, nobody
    last_seen_privacy VARCHAR(20) DEFAULT 'contacts', -- everyone, contacts, nobody
    profile_photo_privacy VARCHAR(20) DEFAULT 'everyone', -- everyone, contacts, nobody
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- CONTACTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS contacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    contact_phone_number VARCHAR(20) NOT NULL,
    contact_country_code VARCHAR(10) NOT NULL,
    contact_name VARCHAR(255),
    contact_user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- If contact is also a user
    is_blocked BOOLEAN DEFAULT false,
    is_favorite BOOLEAN DEFAULT false,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, contact_phone_number, contact_country_code)
);

-- ============================================
-- AUTHENTICATION & SESSIONS
-- ============================================
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    token_hash VARCHAR(255) NOT NULL, -- Hashed JWT token
    device_id VARCHAR(255), -- Unique device identifier
    device_name VARCHAR(255), -- Device name (e.g., "iPhone 13", "Chrome Browser")
    device_type VARCHAR(50), -- mobile, web, desktop
    ip_address INET,
    user_agent TEXT,
    is_active BOOLEAN DEFAULT true,
    last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, device_id)
);

-- ============================================
-- LOGIN LOGS (Authentication Tracking)
-- ============================================
CREATE TABLE IF NOT EXISTS login_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    phone_number VARCHAR(20),
    country_code VARCHAR(10),
    action VARCHAR(50) NOT NULL, -- login, logout, login_failed, token_refresh
    status VARCHAR(20) NOT NULL, -- success, failed, blocked
    ip_address INET,
    user_agent TEXT,
    device_id VARCHAR(255),
    device_type VARCHAR(50),
    failure_reason TEXT, -- If status is 'failed'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- USER ACTIVITY LOGS
-- ============================================
CREATE TABLE IF NOT EXISTS user_activity_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    activity_type VARCHAR(50) NOT NULL, -- message_sent, call_initiated, call_answered, profile_updated, etc.
    activity_data JSONB, -- Store activity-specific data
    ip_address INET,
    device_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- STATUS UPDATES (Prepared for future feature)
-- ============================================
CREATE TABLE IF NOT EXISTS status_updates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    type VARCHAR(20) NOT NULL, -- text, image, video
    content TEXT, -- Text status or media URL
    media_url TEXT, -- For image/video statuses
    media_type VARCHAR(50), -- image/jpeg, video/mp4, etc.
    thumbnail_url TEXT, -- For video statuses
    caption TEXT,
    views_count INTEGER DEFAULT 0,
    expires_at TIMESTAMP, -- Status expires after 24 hours
    privacy VARCHAR(20) DEFAULT 'contacts', -- everyone, contacts, selected
    selected_contacts UUID[], -- If privacy is 'selected'
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- STATUS VIEWS (Who viewed the status)
-- ============================================
CREATE TABLE IF NOT EXISTS status_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    status_id UUID REFERENCES status_updates(id) ON DELETE CASCADE NOT NULL,
    viewer_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(status_id, viewer_id)
);

-- ============================================
-- BLOCKED USERS
-- ============================================
CREATE TABLE IF NOT EXISTS blocked_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    blocker_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    blocked_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(blocker_id, blocked_id)
);

-- ============================================
-- MIGRATIONS (Add missing columns to existing tables)
-- ============================================

-- Add missing columns to users table if they don't exist
DO $$ 
BEGIN
    -- Add last_login_at if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='users' AND column_name='last_login_at') THEN
        ALTER TABLE users ADD COLUMN last_login_at TIMESTAMP;
    END IF;
    
    -- Add last_activity_at if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='users' AND column_name='last_activity_at') THEN
        ALTER TABLE users ADD COLUMN last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    END IF;
    
    -- Add is_active if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='users' AND column_name='is_active') THEN
        ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT true;
    END IF;
    
    -- Add is_verified if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='users' AND column_name='is_verified') THEN
        ALTER TABLE users ADD COLUMN is_verified BOOLEAN DEFAULT false;
    END IF;
    
    -- Add verification_code if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='users' AND column_name='verification_code') THEN
        ALTER TABLE users ADD COLUMN verification_code VARCHAR(10);
    END IF;
    
    -- Add verification_expires_at if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='users' AND column_name='verification_expires_at') THEN
        ALTER TABLE users ADD COLUMN verification_expires_at TIMESTAMP;
    END IF;
    
    -- Add device_info if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='users' AND column_name='device_info') THEN
        ALTER TABLE users ADD COLUMN device_info JSONB;
    END IF;
    
    -- Add metadata if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='users' AND column_name='metadata') THEN
        ALTER TABLE users ADD COLUMN metadata JSONB;
    END IF;
END $$;

-- Add missing columns to user_settings table if they don't exist
DO $$ 
BEGIN
    -- Add wallpaper_url if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='user_settings' AND column_name='wallpaper_url') THEN
        ALTER TABLE user_settings ADD COLUMN wallpaper_url TEXT;
    END IF;
    
    -- Add chat_background_color if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='user_settings' AND column_name='chat_background_color') THEN
        ALTER TABLE user_settings ADD COLUMN chat_background_color VARCHAR(20);
    END IF;
    
    -- Add font_size if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='user_settings' AND column_name='font_size') THEN
        ALTER TABLE user_settings ADD COLUMN font_size VARCHAR(20) DEFAULT 'medium';
    END IF;
    
    -- Add auto_download_media if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='user_settings' AND column_name='auto_download_media') THEN
        ALTER TABLE user_settings ADD COLUMN auto_download_media BOOLEAN DEFAULT true;
    END IF;
    
    -- Add auto_download_on_wifi if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='user_settings' AND column_name='auto_download_on_wifi') THEN
        ALTER TABLE user_settings ADD COLUMN auto_download_on_wifi BOOLEAN DEFAULT true;
    END IF;
    
    -- Add status_privacy if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='user_settings' AND column_name='status_privacy') THEN
        ALTER TABLE user_settings ADD COLUMN status_privacy VARCHAR(20) DEFAULT 'contacts';
    END IF;
    
    -- Add last_seen_privacy if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='user_settings' AND column_name='last_seen_privacy') THEN
        ALTER TABLE user_settings ADD COLUMN last_seen_privacy VARCHAR(20) DEFAULT 'contacts';
    END IF;
    
    -- Add profile_photo_privacy if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='user_settings' AND column_name='profile_photo_privacy') THEN
        ALTER TABLE user_settings ADD COLUMN profile_photo_privacy VARCHAR(20) DEFAULT 'everyone';
    END IF;
END $$;

-- Add missing columns to contacts table if they don't exist
DO $$ 
BEGIN
    -- Add contact_user_id if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='contacts' AND column_name='contact_user_id') THEN
        ALTER TABLE contacts ADD COLUMN contact_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
    END IF;
    
    -- Add is_favorite if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='contacts' AND column_name='is_favorite') THEN
        ALTER TABLE contacts ADD COLUMN is_favorite BOOLEAN DEFAULT false;
    END IF;
    
    -- Add notes if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='contacts' AND column_name='notes') THEN
        ALTER TABLE contacts ADD COLUMN notes TEXT;
    END IF;
END $$;

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

-- Users indexes
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number, country_code);
CREATE INDEX IF NOT EXISTS idx_users_online ON users(is_online);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_users_last_activity ON users(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active = true;

-- User settings indexes
CREATE INDEX IF NOT EXISTS idx_settings_user ON user_settings(user_id);

-- Contacts indexes
CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_blocked ON contacts(user_id, is_blocked) WHERE is_blocked = true;
CREATE INDEX IF NOT EXISTS idx_contacts_favorite ON contacts(user_id, is_favorite) WHERE is_favorite = true;
CREATE INDEX IF NOT EXISTS idx_contacts_user_id ON contacts(contact_user_id) WHERE contact_user_id IS NOT NULL;

-- Sessions indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON user_sessions(user_id, is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_sessions_device ON user_sessions(device_id);
-- Note: Partial index on expires_at cannot use CURRENT_TIMESTAMP in predicate
-- Instead, we'll create a regular index and filter in queries
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions(expires_at);

-- Login logs indexes
CREATE INDEX IF NOT EXISTS idx_login_logs_user ON login_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_login_logs_phone ON login_logs(phone_number, country_code);
CREATE INDEX IF NOT EXISTS idx_login_logs_action ON login_logs(action);
CREATE INDEX IF NOT EXISTS idx_login_logs_status ON login_logs(status);
CREATE INDEX IF NOT EXISTS idx_login_logs_created ON login_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_logs_user_created ON login_logs(user_id, created_at DESC);

-- Activity logs indexes
CREATE INDEX IF NOT EXISTS idx_activity_logs_user ON user_activity_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_type ON user_activity_logs(activity_type);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created ON user_activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_created ON user_activity_logs(user_id, created_at DESC);

-- Status indexes
CREATE INDEX IF NOT EXISTS idx_status_user ON status_updates(user_id);
CREATE INDEX IF NOT EXISTS idx_status_created ON status_updates(created_at DESC);
-- Note: Partial index on expires_at cannot use CURRENT_TIMESTAMP in predicate
-- Instead, we'll create a regular index and filter in queries
CREATE INDEX IF NOT EXISTS idx_status_expires ON status_updates(expires_at);
CREATE INDEX IF NOT EXISTS idx_status_user_created ON status_updates(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_status_type ON status_updates(type);

-- Status views indexes
CREATE INDEX IF NOT EXISTS idx_status_views_status ON status_views(status_id);
CREATE INDEX IF NOT EXISTS idx_status_views_viewer ON status_views(viewer_id);
CREATE INDEX IF NOT EXISTS idx_status_views_created ON status_views(viewed_at DESC);

-- Blocked users indexes
CREATE INDEX IF NOT EXISTS idx_blocked_blocker ON blocked_users(blocker_id);
CREATE INDEX IF NOT EXISTS idx_blocked_blocked ON blocked_users(blocked_id);
CREATE INDEX IF NOT EXISTS idx_blocked_both ON blocked_users(blocker_id, blocked_id);

-- ============================================
-- FUNCTIONS
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Function to update last_activity_at
CREATE OR REPLACE FUNCTION update_last_activity_at()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE users 
    SET last_activity_at = CURRENT_TIMESTAMP 
    WHERE id = NEW.user_id;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Function to log user activity
CREATE OR REPLACE FUNCTION log_user_activity()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO user_activity_logs (user_id, activity_type, activity_data)
    VALUES (
        NEW.user_id,
        TG_ARGV[0],
        jsonb_build_object(
            'table', TG_TABLE_NAME,
            'action', TG_OP,
            'data', row_to_json(NEW)
        )
    );
    RETURN NEW;
END;
$$ language 'plpgsql';

-- ============================================
-- TRIGGERS
-- ============================================

-- Auto-update updated_at for users
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at 
    BEFORE UPDATE ON users
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at for user_settings
DROP TRIGGER IF EXISTS update_user_settings_updated_at ON user_settings;
CREATE TRIGGER update_user_settings_updated_at 
    BEFORE UPDATE ON user_settings
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at for contacts
DROP TRIGGER IF EXISTS update_contacts_updated_at ON contacts;
CREATE TRIGGER update_contacts_updated_at 
    BEFORE UPDATE ON contacts
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Auto-update updated_at for status_updates
DROP TRIGGER IF EXISTS update_status_updated_at ON status_updates;
CREATE TRIGGER update_status_updated_at 
    BEFORE UPDATE ON status_updates
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Update last_activity_at when user logs in
DROP TRIGGER IF EXISTS update_activity_on_login ON login_logs;
CREATE TRIGGER update_activity_on_login
    AFTER INSERT ON login_logs
    FOR EACH ROW
    WHEN (NEW.status = 'success' AND NEW.action = 'login')
    EXECUTE FUNCTION update_last_activity_at();

-- ============================================
-- VIEWS FOR ANALYTICS
-- ============================================

-- Active users view
CREATE OR REPLACE VIEW active_users AS
SELECT 
    id,
    full_name,
    phone_number,
    is_online,
    last_seen,
    last_activity_at,
    EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - last_activity_at)) / 60 as minutes_since_activity
FROM users
WHERE is_active = true;

-- User statistics view
CREATE OR REPLACE VIEW user_statistics AS
SELECT 
    u.id,
    u.full_name,
    u.created_at,
    u.last_login_at,
    u.last_activity_at,
    COUNT(DISTINCT s.id) as total_sessions,
    COUNT(DISTINCT CASE WHEN s.is_active = true THEN s.id END) as active_sessions,
    COUNT(DISTINCT ll.id) FILTER (WHERE ll.action = 'login' AND ll.status = 'success') as login_count,
    MAX(ll.created_at) FILTER (WHERE ll.action = 'login' AND ll.status = 'success') as last_successful_login
FROM users u
LEFT JOIN user_sessions s ON u.id = s.user_id
LEFT JOIN login_logs ll ON u.id = ll.user_id
GROUP BY u.id, u.full_name, u.created_at, u.last_login_at, u.last_activity_at;

-- Daily activity summary view
CREATE OR REPLACE VIEW daily_activity_summary AS
SELECT 
    DATE(created_at) as activity_date,
    activity_type,
    COUNT(*) as activity_count,
    COUNT(DISTINCT user_id) as unique_users
FROM user_activity_logs
GROUP BY DATE(created_at), activity_type
ORDER BY activity_date DESC, activity_count DESC;

-- ============================================
-- COMMENTS FOR DOCUMENTATION
-- ============================================

COMMENT ON TABLE users IS 'Main user accounts table with profile and presence data';
COMMENT ON TABLE user_settings IS 'User preferences and privacy settings';
COMMENT ON TABLE contacts IS 'User contact list with blocking and favorites';
COMMENT ON TABLE user_sessions IS 'Active user sessions for multi-device support';
COMMENT ON TABLE login_logs IS 'Authentication and login attempt logs for security';
COMMENT ON TABLE user_activity_logs IS 'Comprehensive activity tracking for analytics';
COMMENT ON TABLE status_updates IS 'User status updates (text, image, video)';
COMMENT ON TABLE status_views IS 'Track who viewed each status update';
COMMENT ON TABLE blocked_users IS 'User blocking relationships';

COMMENT ON COLUMN users.device_info IS 'JSON object storing device information from login';
COMMENT ON COLUMN users.metadata IS 'Additional user metadata in JSON format';
COMMENT ON COLUMN user_activity_logs.activity_data IS 'JSON object with activity-specific details';
COMMENT ON TABLE status_updates IS 'Status updates expire after 24 hours';
