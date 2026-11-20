/**
 * services/storage.js
 * Switchable image storage: 'local' (default) or 'cloudinary'
 * Control via: STORAGE_PROVIDER=local|cloudinary in .env
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PROVIDER = (process.env.STORAGE_PROVIDER || 'local').toLowerCase();

// ── LOCAL STORAGE ─────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Awalan unik: banyak HP memberi nama file yang sama (mis. "image.jpg"), jadi nama asli saja tidak cukup
const uniq = () => `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

function localUpload(buffer, filename) {
  const safeName = `${uniq()}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const filePath  = path.join(UPLOAD_DIR, safeName);
  fs.writeFileSync(filePath, buffer);
  // Return public URL path (served as /uploads/<filename>)
  return `/uploads/${safeName}`;
}

function localDelete(urlOrPath) {
  try {
    const filename = path.basename(new URL(urlOrPath, 'http://localhost').pathname);
    const filePath = path.join(UPLOAD_DIR, filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.warn('[storage] local delete failed:', e.message);
  }
}

// ── CLOUDINARY ────────────────────────────────────────────────────────────────
let cloudinary;
function getCloudinary() {
  if (!cloudinary) {
    cloudinary = require('cloudinary').v2;
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key:    process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
  }
  return cloudinary;
}

function cloudinaryUpload(buffer, folder = 'pest-control/evidence', filename = '') {
  const cld = getCloudinary();

  // Nama asli tidak boleh jadi public_id apa adanya: dengan overwrite:false, file bernama sama
  // TIDAK diunggah dan Cloudinary mengembalikan foto lama → foto tertukar antar keluhan.
  const base = filename.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  const publicId = base ? `${uniq()}_${base}` : undefined;

  function attemptUpload() {
    return new Promise((resolve, reject) => {
      const stream = cld.uploader.upload_stream(
        {
          folder,
          public_id:     publicId,
          resource_type: 'image',
          overwrite:     false,
          timeout:       120000, // 120 detik timeout
          transformation: [
            { width: 1200, crop: 'limit' },
            { quality: 'auto:good' },
            { fetch_format: 'auto' },
          ],
        },
        (error, result) => {
          if (error) return reject(error);
          resolve(result.secure_url);
        }
      );
      stream.end(buffer);
    });
  }

  // Retry up to 3x on timeout
  return attemptUpload().catch(err => {
    console.warn('[cloudinary] Attempt 1 failed:', err.message, '- retrying...');
    return attemptUpload().catch(err2 => {
      console.warn('[cloudinary] Attempt 2 failed:', err2.message, '- retrying...');
      return attemptUpload();
    });
  });
}

async function cloudinaryDelete(secureUrl) {
  const cld   = getCloudinary();
  const parts = secureUrl.split('/');
  const folderAndFile = parts.slice(-2).join('/');
  const publicId = `pest-control/evidence/${folderAndFile.replace(/\.[^/.]+$/, '').split('/').pop()}`;
  return cld.uploader.destroy(publicId);
}

// ── UNIFIED API ───────────────────────────────────────────────────────────────
async function uploadImage(buffer, folder = 'pest-control/evidence', filename = '') {
  if (PROVIDER === 'cloudinary') {
    return cloudinaryUpload(buffer, folder, filename);
  }
  return localUpload(buffer, filename || 'image.jpg');
}

async function deleteImage(urlOrPublicId) {
  if (PROVIDER === 'cloudinary') {
    return cloudinaryDelete(urlOrPublicId);
  }
  return localDelete(urlOrPublicId);
}

console.log(`[storage] Using provider: ${PROVIDER}`);
// Simpan selalu di server lokal — cadangan foto absensi bila Cloudinary gagal
function uploadImageLocal(buffer, filename = 'image.jpg') {
  return localUpload(buffer, filename);
}

module.exports = { uploadImage, uploadImageLocal, deleteImage, PROVIDER };
