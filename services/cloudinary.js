const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a file buffer to Cloudinary.
 * @param {Buffer} buffer - Image buffer
 * @param {string} folder  - Cloudinary folder name
 * @param {string} filename - Public ID hint
 * @returns {Promise<string>} Public secure_url
 */
function uploadImage(buffer, folder = 'pest-control/evidence', filename = '') {
  return new Promise((resolve, reject) => {
    const uploadOptions = {
      folder,
      public_id: filename || undefined,
      resource_type: 'image',
      overwrite: false,
    };

    const stream = cloudinary.uploader.upload_stream(uploadOptions, (error, result) => {
      if (error) return reject(error);
      resolve(result.secure_url);
    });

    stream.end(buffer);
  });
}

/**
 * Delete an image from Cloudinary by its public_id (extracted from URL).
 * @param {string} secureUrl
 */
async function deleteImage(secureUrl) {
  const parts = secureUrl.split('/');
  const folderAndFile = parts.slice(-2).join('/');
  const publicId = folderAndFile.replace(/\.[^/.]+$/, ''); // strip extension
  const fullPublicId = `pest-control/evidence/${publicId.split('/').pop()}`;
  return cloudinary.uploader.destroy(fullPublicId);
}

module.exports = { uploadImage, deleteImage };
