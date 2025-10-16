const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure Cloudinary storage for multer
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'infinity_craft_products', // Folder in Cloudinary
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'], // Allowed formats
    transformation: [
      { width: 800, height: 600, crop: 'limit' }, // Resize images
      { quality: 'auto' } // Auto optimize quality
    ]
  }
});

// Create multer upload middleware
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit per file
    files: 10 // Maximum 10 files
  },
  fileFilter: (req, file, cb) => {
    // Check file type
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// Upload multiple images from base64 array
const uploadMultipleBase64Images = async (imageArray, options = {}) => {
  try {
    const uploadPromises = imageArray.map(async (imageData, index) => {
      let base64Data = imageData.base64 || imageData;
      
      // Handle both data URL and plain base64 formats
      if (base64Data && !base64Data.includes('data:image')) {
        base64Data = `data:image/jpeg;base64,${base64Data}`;
      }
      
      const uploadOptions = {
        folder: 'infinity_craft_products',
        public_id: `product_${Date.now()}_${index}`,
        transformation: [
          { width: 800, height: 600, crop: 'limit' },
          { quality: 'auto' }
        ],
        ...options
      };

      const result = await cloudinary.uploader.upload(base64Data, uploadOptions);

      return {
        url: result.secure_url,
        publicId: result.public_id,
        originalName: imageData.originalName || imageData.filename || `image_${index + 1}.jpg`,
        isPrimary: index === 0, // First image is primary
        width: result.width,
        height: result.height,
        format: result.format,
        bytes: result.bytes,
        uploadedAt: new Date()
      };
    });

    return await Promise.all(uploadPromises);
  } catch (error) {
    console.error('Multiple images upload error:', error);
    throw new Error(`Multiple images upload failed: ${error.message}`);
  }
};

// Delete multiple images from Cloudinary
const deleteMultipleImages = async (publicIds) => {
  try {
    const deletePromises = publicIds.map(publicId => cloudinary.uploader.destroy(publicId));
    return await Promise.all(deletePromises);
  } catch (error) {
    throw new Error(`Multiple images delete failed: ${error.message}`);
  }
};

// Upload image from base64 string
const uploadBase64Image = async (base64String, options = {}) => {
  try {
    // Handle both data URL and plain base64 formats
    let base64Data = base64String;
    if (base64String.includes('data:image')) {
      base64Data = base64String;
    } else {
      // If it's plain base64, add data URL prefix
      base64Data = `data:image/jpeg;base64,${base64String}`;
    }
    
    const uploadOptions = {
      folder: 'infinity_craft_products',
      transformation: [
        { width: 800, height: 600, crop: 'limit' },
        { quality: 'auto' }
      ],
      ...options
    };

    const result = await cloudinary.uploader.upload(base64Data, uploadOptions);

    return {
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
      format: result.format,
      bytes: result.bytes,
      createdAt: result.created_at
    };
  } catch (error) {
    console.error('Cloudinary upload error:', error);
    throw new Error(`Cloudinary upload failed: ${error.message}`);
  }
};

// Delete image from Cloudinary
const deleteImage = async (publicId) => {
  try {
    const result = await cloudinary.uploader.destroy(publicId);
    return result;
  } catch (error) {
    throw new Error(`Cloudinary delete failed: ${error.message}`);
  }
};

module.exports = {
  cloudinary,
  upload,
  uploadBase64Image,
  uploadMultipleBase64Images,
  deleteImage,
  deleteMultipleImages
};