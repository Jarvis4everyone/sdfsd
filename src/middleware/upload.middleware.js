import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename: timestamp-userId-originalname
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `profile-${req.userId}-${uniqueSuffix}${ext}`);
  },
});

// File filter - only images
const fileFilter = (req, file, cb) => {
  // Check MIME type first (more reliable)
  const allowedMimeTypes = /^image\/(jpeg|jpg|png|gif|webp)$/i;
  const allowedExtensions = /\.(jpeg|jpg|png|gif|webp)$/i;
  
  // Check if MIME type is valid
  const isValidMimeType = file.mimetype && allowedMimeTypes.test(file.mimetype);
  
  // Check if extension is valid (fallback if MIME type is missing)
  const isValidExtension = file.originalname && allowedExtensions.test(file.originalname);
  
  // Accept if either MIME type or extension is valid
  if (isValidMimeType || isValidExtension) {
    return cb(null, true);
  } else {
    // Log for debugging
    console.log('File rejected:', {
      originalname: file.originalname,
      mimetype: file.mimetype,
      fieldname: file.fieldname,
    });
    cb(new Error(`Only image files are allowed (jpeg, jpg, png, gif, webp). Received: ${file.mimetype || 'unknown type'}`));
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760'), // 10MB default
  },
  fileFilter: fileFilter,
});

// Error handling middleware for multer
export const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File too large. Maximum size is 10MB.',
      });
    }
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }
  if (err) {
    // This is the fileFilter error
    req.fileValidationError = err.message;
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }
  next();
};

// Middleware for single file upload (profile picture)
export const uploadSingle = upload.single('profilePicture');

// Middleware for message file upload (any file type)
const messageStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename: timestamp-userId-originalname
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    const fileType = req.body.messageType || 'file';
    cb(null, `${fileType}-${req.userId}-${uniqueSuffix}${ext}`);
  },
});

// File filter for messages - allow all file types
const messageFileFilter = (req, file, cb) => {
  // Allow all file types for messages
  cb(null, true);
};

const messageUpload = multer({
  storage: messageStorage,
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '52428800'), // 50MB default for messages
  },
  fileFilter: messageFileFilter,
});

// Middleware for message file upload
export const uploadMessageFile = messageUpload.single('file');

// Helper to get file URL
export const getFileUrl = (req, filename) => {
  if (!filename) return null;
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  return `${baseUrl}/uploads/${filename}`;
};

// Helper to delete old file
export const deleteFile = (filename) => {
  if (!filename) return;
  const filePath = path.join(uploadsDir, filename);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
};

