/**
 * Backend server for secure audio streaming from Cloudflare R2
 * 
 * This server provides signed URLs for audio files stored in a private
 * Cloudflare R2 bucket, preventing direct downloads and enabling
 * time-limited streaming access.
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS configuration - allow requests from frontend
app.use(cors({
    origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Serve static files (index.html)
app.use(express.static(path.join(__dirname)));

// Cloudflare R2 configuration
const R2_ENDPOINT = process.env.R2_ENDPOINT;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'podcasts';

// URL expiration time in seconds (5-10 minutes as requested)
const URL_EXPIRATION_SECONDS = parseInt(process.env.URL_EXPIRATION_SECONDS) || 600; // 10 minutes

// Initialize S3 client for Cloudflare R2
let s3Client = null;

function initializeR2Client() {
    if (!R2_ENDPOINT || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
        console.warn('⚠️  R2 credentials not configured. Set environment variables:');
        console.warn('   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
        return null;
    }

    return new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY
        }
    });
}

s3Client = initializeR2Client();

// Allowed media file extensions for security
const ALLOWED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm', '.mp4', '.MP4', '.webm', '.mov'];

// Validate filename to prevent path traversal attacks
function isValidFilename(filename) {
    if (!filename || typeof filename !== 'string') {
        return false;
    }
    
    // Prevent path traversal (but allow forward slashes for subfolders)
    if (filename.includes('..') || filename.includes('\\')) {
        return false;
    }
    
    // Check for allowed extensions
    const ext = path.extname(filename).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return false;
    }
    
    return true;
}

/**
 * GET /audio-url
 * 
 * Generates a signed URL for streaming audio from Cloudflare R2.
 * 
 * Query Parameters:
 *   - filename: Name of the audio file (required)
 * 
 * Response:
 *   - url: Signed URL valid for streaming (expires in 5-10 minutes)
 *   - expiresIn: Time until URL expires (in seconds)
 * 
 * The signed URL includes:
 *   - Content-Disposition: inline (forces streaming, not download)
 *   - Time-limited access
 */
app.get('/audio-url', async (req, res) => {
    try {
        const { filename } = req.query;
        
        // Validate filename
        if (!filename) {
            return res.status(400).json({
                error: 'Missing filename parameter',
                message: 'Please provide a filename query parameter'
            });
        }

        if (!isValidFilename(filename)) {
            return res.status(400).json({
                error: 'Invalid filename',
                message: 'Filename must be a valid audio file without path separators'
            });
        }

        // Check if R2 is configured
        if (!s3Client) {
            return res.status(503).json({
                error: 'Storage not configured',
                message: 'Cloudflare R2 credentials are not configured. Please set environment variables.'
            });
        }

        // Create the GetObject command with response headers
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: filename,
            // Force inline display (streaming) instead of attachment (download)
            ResponseContentDisposition: 'inline',
            // Set appropriate content type based on extension
            ResponseContentType: getContentType(filename)
        });

        // Generate signed URL
        const signedUrl = await getSignedUrl(s3Client, command, {
            expiresIn: URL_EXPIRATION_SECONDS
        });

        console.log(`✅ Generated signed URL for: ${filename} (expires in ${URL_EXPIRATION_SECONDS}s)`);

        res.json({
            success: true,
            url: signedUrl,
            expiresIn: URL_EXPIRATION_SECONDS,
            filename: filename
        });

    } catch (error) {
        console.error('❌ Error generating signed URL:', error.message);
        
        // Handle specific errors
        if (error.name === 'NoSuchKey') {
            return res.status(404).json({
                error: 'File not found',
                message: 'The requested audio file does not exist'
            });
        }

        res.status(500).json({
            error: 'Internal server error',
            message: 'Failed to generate audio URL. Please try again later.'
        });
    }
});

/**
 * POST /audio-url (alternative endpoint)
 * Accepts filename in request body for more security
 */
app.post('/audio-url', async (req, res) => {
    try {
        const { filename } = req.body;
        
        if (!filename) {
            return res.status(400).json({
                error: 'Missing filename',
                message: 'Please provide a filename in the request body'
            });
        }

        if (!isValidFilename(filename)) {
            return res.status(400).json({
                error: 'Invalid filename',
                message: 'Filename must be a valid audio file without path separators'
            });
        }

        if (!s3Client) {
            return res.status(503).json({
                error: 'Storage not configured',
                message: 'Cloudflare R2 credentials are not configured'
            });
        }

        const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: filename,
            ResponseContentDisposition: 'inline',
            ResponseContentType: getContentType(filename)
        });

        const signedUrl = await getSignedUrl(s3Client, command, {
            expiresIn: URL_EXPIRATION_SECONDS
        });

        console.log(`✅ Generated signed URL for: ${filename} (expires in ${URL_EXPIRATION_SECONDS}s)`);

        res.json({
            success: true,
            url: signedUrl,
            expiresIn: URL_EXPIRATION_SECONDS,
            filename: filename
        });

    } catch (error) {
        console.error('❌ Error generating signed URL:', error.message);
        
        if (error.name === 'NoSuchKey') {
            return res.status(404).json({
                error: 'File not found',
                message: 'The requested audio file does not exist'
            });
        }

        res.status(500).json({
            error: 'Internal server error',
            message: 'Failed to generate audio URL'
        });
    }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        r2Configured: !!s3Client,
        bucket: R2_BUCKET_NAME,
        urlExpirationSeconds: URL_EXPIRATION_SECONDS
    });
});

/**
 * Get content type based on file extension
 */
function getContentType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const contentTypes = {
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
        '.webm': 'audio/webm',
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime'
    };
    return contentTypes[ext] || 'application/octet-stream';
}

// Start server
app.listen(PORT, () => {
    console.log(`\n🎵 NWN Archetypes Audio Server`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📡 Server running on port ${PORT}`);
    console.log(`🪣 R2 Bucket: ${R2_BUCKET_NAME}`);
    console.log(`⏱️  URL Expiration: ${URL_EXPIRATION_SECONDS} seconds`);
    console.log(`✅ R2 Client: ${s3Client ? 'Configured' : 'Not configured (set env vars)'}`);
    console.log(`\n📌 Endpoints:`);
    console.log(`   GET  /audio-url?filename=<name>  - Get signed URL`);
    console.log(`   POST /audio-url                  - Get signed URL (body)`);
    console.log(`   GET  /health                     - Health check`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
