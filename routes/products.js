const router = require('express').Router();
const Product = require('../models/Product');
const { upload, uploadBase64Image, deleteImage } = require('../config/cloudinary');

// Get all products
router.get("/", async (req, res) => {
  try {
    const products = await Product.find();
    res.json({
      success: true,
      count: products.length,
      products
    });
  } catch (err) {
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

// Get single product
router.get("/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ 
        success: false,
        error: "Product not found" 
      });
    }
    res.json({
      success: true,
      product
    });
  } catch (err) {
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

// Add product with base64 image
router.post("/", async (req, res) => {
  try {
    const { name, description, price, image, category, subCategory } = req.body;
        
    // Validate required fields
    if (!name || !price || !category || !subCategory) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: name, price, category, and subCategory are required"
      });
    }

    let imageData = null;

    // Handle image upload if provided
    if (image && typeof image === 'object' && Object.keys(image).length > 0) {
      try {
        let imageToUpload = null;
        
        // Handle different image formats
        if (typeof image === 'string') {
          // Direct base64 string
          imageToUpload = image;
        } else if (image.base64) {
          // Object with base64 property
          imageToUpload = image.base64;
        } else if (image.data) {
          // Object with data property
          imageToUpload = image.data;
        }

        if (imageToUpload && imageToUpload.length > 100) { // Basic validation
          const cloudinaryResult = await uploadBase64Image(imageToUpload, {
            public_id: `product_${Date.now()}`
          });
          
          imageData = {
            url: cloudinaryResult.url,
            publicId: cloudinaryResult.publicId,
            originalName: image.originalName || image.filename || `${name}.jpg`,
            uploadedAt: new Date()
          };
          
        } else {
          console.log('No valid image data found, skipping image upload');
        }
      } catch (imageError) {
        console.error('Image upload failed:', imageError);
        return res.status(400).json({
          success: false,
          error: `Image upload failed: ${imageError.message}`
        });
      }
    } else if (image) {
      console.log('Invalid image object received, skipping image upload');
    }

    // Create product
    const productData = {
      name,
      description,
      price: parseFloat(price),
      category,
      subCategory,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    if (imageData) {
      productData.image = imageData;
    }

    const product = new Product(productData);
    await product.save();

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      product
    });

  } catch (err) {
    console.error('Product creation error:', err);
    res.status(400).json({ 
      success: false,
      error: err.message 
    });
  }
});

// Add product with file upload (multipart/form-data)
router.post("/upload", upload.single('image'), async (req, res) => {
  try {
    const { name, description, price, category, subCategory } = req.body;
    
    // Validate required fields
    if (!name || !price || !category || !subCategory) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: name, price, category, and subCategory are required"
      });
    }

    let imageData = null;
    if (req.file) {
      imageData = {
        url: req.file.path, // Cloudinary URL
        publicId: req.file.filename, // Cloudinary public ID
        originalName: req.file.originalname,
        uploadedAt: new Date()
      };
    }

    const productData = {
      name,
      description,
      price: parseFloat(price),
      category,
      subCategory,
      image: imageData,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const product = new Product(productData);
    await product.save();

    res.status(201).json({
      success: true,
      message: "Product created successfully with file upload",
      product
    });

  } catch (err) {
    console.error('Product upload error:', err);
    res.status(400).json({ 
      success: false,
      error: err.message 
    });
  }
});

// Update product
router.put("/:id", async (req, res) => {
  try {
    const { name, description, price, image, category, subCategory } = req.body;
    
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ 
        success: false,
        error: "Product not found" 
      });
    }

    const updateData = {
      updatedAt: new Date()
    };

    // Update basic fields
    if (name) updateData.name = name;
    if (description) updateData.description = description;
    if (price) updateData.price = parseFloat(price);
    if (category) updateData.category = category;
    if (subCategory) updateData.subCategory = subCategory;

    // Handle image update
    if (image) {
      try {
        // Delete old image if exists
        if (product.image && product.image.publicId) {
          await deleteImage(product.image.publicId);
        }

        // Upload new image
        let imageToUpload = null;
        if (typeof image === 'string') {
          imageToUpload = image;
        } else if (image.base64) {
          imageToUpload = image.base64;
        } else if (image.data) {
          imageToUpload = image.data;
        }

        if (imageToUpload) {
          const cloudinaryResult = await uploadBase64Image(imageToUpload, {
            public_id: `product_${Date.now()}`
          });
          
          updateData.image = {
            url: cloudinaryResult.url,
            publicId: cloudinaryResult.publicId,
            originalName: image.originalname || image.filename || `${name}.jpg`,
            uploadedAt: new Date()
          };
        }
      } catch (imageError) {
        console.error('Image update failed:', imageError);
        return res.status(400).json({
          success: false,
          error: `Image update failed: ${imageError.message}`
        });
      }
    }

    const updated = await Product.findByIdAndUpdate(
      req.params.id, 
      updateData, 
      { new: true }
    );

    res.json({
      success: true,
      message: "Product updated successfully",
      product: updated
    });

  } catch (err) {
    console.error('Product update error:', err);
    res.status(400).json({ 
      success: false,
      error: err.message 
    });
  }
});

// Delete product
router.delete("/:id", async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({ 
        success: false,
        error: "Product not found" 
      });
    }

    // Delete image from Cloudinary if exists
    if (product.image && product.image.publicId) {
      try {
        await deleteImage(product.image.publicId);
        console.log('Image deleted from Cloudinary:', product.image.publicId);
      } catch (imageError) {
        console.error('Failed to delete image from Cloudinary:', imageError);
        // Continue with product deletion even if image deletion fails
      }
    }

    await Product.findByIdAndDelete(req.params.id);
    
    res.json({ 
      success: true,
      message: "Product deleted successfully" 
    });
  } catch (err) {
    console.error('Product deletion error:', err);
    res.status(500).json({ 
      success: false,
      error: err.message 
    });
  }
});

module.exports = router;
