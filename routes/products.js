const router = require("express").Router();
const Product = require("../models/Product");
const {
  upload,
  uploadBase64Image,
  uploadMultipleBase64Images,
  deleteImage,
  deleteMultipleImages,
} = require("../config/cloudinary");
const { protect, isAdmin } = require("../middlewares/authMiddleware");
const {
  productValidation,
  productUpdateValidation,
  mongoIdValidation,
} = require("../middlewares/validators");

// Get all products
router.get("/", async (req, res) => {
  try {
    const products = await Product.find();
    res.json({
      success: true,
      count: products.length,
      products,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
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
        error: "Product not found",
      });
    }
    res.json({
      success: true,
      product,
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// Add product with multiple images (base64) - Admin only
router.post("/", protect, isAdmin, productValidation, async (req, res) => {
  try {
    const { name, description, price, images, image, category, subCategory } =
      req.body;
    if (!name || !price || !category || !subCategory) {
      return res.status(400).json({
        success: false,
        error:
          "Missing required fields: name, price, category, and subCategory are required",
      });
    }

    let imagesData = [];
    let singleImageData = null;

    // Handle multiple images upload if provided
    if (images && Array.isArray(images) && images.length > 0) {
      try {
        // Filter valid images
        const validImages = images.filter((img) => {
          return (
            img &&
            (img.base64 || img.data) &&
            (img.base64?.length > 100 || img.data?.length > 100)
          );
        });

        if (validImages.length > 0) {
          imagesData = await uploadMultipleBase64Images(validImages);
        }
      } catch (imageError) {
        console.error("Multiple images upload failed:", imageError);
        return res.status(400).json({
          success: false,
          error: `Images upload failed: ${imageError.message}`,
        });
      }
    }
    // Handle single image for backward compatibility
    else if (
      image &&
      typeof image === "object" &&
      Object.keys(image).length > 0
    ) {
      try {
        let imageToUpload = null;

        // Handle different image formats
        if (typeof image === "string") {
          imageToUpload = image;
        } else if (image.base64) {
          imageToUpload = image.base64;
        } else if (image.data) {
          imageToUpload = image.data;
        }

        if (imageToUpload && imageToUpload.length > 100) {
          const cloudinaryResult = await uploadBase64Image(imageToUpload, {
            public_id: `product_${Date.now()}`,
          });

          singleImageData = {
            url: cloudinaryResult.url,
            publicId: cloudinaryResult.publicId,
            originalName: image.originalName || image.filename || `${name}.jpg`,
            uploadedAt: new Date(),
          };

          // Also add to images array for consistency
          imagesData.push({
            ...singleImageData,
            isPrimary: true,
          });
        }
      } catch (imageError) {
        console.error("Single image upload failed:", imageError);
        return res.status(400).json({
          success: false,
          error: `Image upload failed: ${imageError.message}`,
        });
      }
    }

    // Create product
    const productData = {
      name,
      description,
      price: parseFloat(price),
      category,
      subCategory,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    // Add images data
    if (imagesData.length > 0) {
      productData.images = imagesData;

      // Keep backward compatibility - set primary image as main image
      const primaryImage =
        imagesData.find((img) => img.isPrimary) || imagesData[0];
      if (primaryImage) {
        productData.image = {
          url: primaryImage.url,
          publicId: primaryImage.publicId,
          originalName: primaryImage.originalName,
          uploadedAt: primaryImage.uploadedAt,
        };
      }
    } else if (singleImageData) {
      productData.image = singleImageData;
    }

    const product = new Product(productData);
    await product.save();

    res.status(201).json({
      success: true,
      message: "Product created successfully",
      product,
    });
  } catch (err) {
    console.error("Product creation error:", err);
    res.status(400).json({
      success: false,
      error: err.message,
    });
  }
});

// Add product with multiple file uploads (multipart/form-data) - Admin only
router.post(
  "/upload",
  protect,
  isAdmin,
  upload.array("images", 10),
  async (req, res) => {
    try {
      const { name, description, price, category, subCategory } = req.body;

      // Validate required fields
      if (!name || !price || !category || !subCategory) {
        return res.status(400).json({
          success: false,
          error:
            "Missing required fields: name, price, category, and subCategory are required",
        });
      }

      let imagesData = [];
      let singleImageData = null;

      if (req.files && req.files.length > 0) {
        imagesData = req.files.map((file, index) => ({
          url: file.path, // Cloudinary URL
          publicId: file.filename, // Cloudinary public ID
          originalName: file.originalname,
          isPrimary: index === 0, // First image is primary
          uploadedAt: new Date(),
        }));

        // Set primary image for backward compatibility
        singleImageData = {
          url: imagesData[0].url,
          publicId: imagesData[0].publicId,
          originalName: imagesData[0].originalName,
          uploadedAt: imagesData[0].uploadedAt,
        };
      }

      const productData = {
        name,
        description,
        price: parseFloat(price),
        category,
        subCategory,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      if (imagesData.length > 0) {
        productData.images = imagesData;
        productData.image = singleImageData; // Backward compatibility
      }

      const product = new Product(productData);
      await product.save();

      res.status(201).json({
        success: true,
        message: `Product created successfully with ${imagesData.length} image(s)`,
        product,
      });
    } catch (err) {
      console.error("Product upload error:", err);
      res.status(400).json({
        success: false,
        error: err.message,
      });
    }
  },
);

// Add single file upload route for backward compatibility - Admin only
router.post(
  "/upload-single",
  protect,
  isAdmin,
  upload.single("image"),
  async (req, res) => {
    try {
      const { name, description, price, category, subCategory } = req.body;

      // Validate required fields
      if (!name || !price || !category || !subCategory) {
        return res.status(400).json({
          success: false,
          error:
            "Missing required fields: name, price, category, and subCategory are required",
        });
      }

      let imageData = null;
      let imagesData = [];

      if (req.file) {
        imageData = {
          url: req.file.path, // Cloudinary URL
          publicId: req.file.filename, // Cloudinary public ID
          originalName: req.file.originalname,
          uploadedAt: new Date(),
        };

        // Also add to images array
        imagesData.push({
          ...imageData,
          isPrimary: true,
        });
      }

      const productData = {
        name,
        description,
        price: parseFloat(price),
        category,
        subCategory,
        image: imageData,
        images: imagesData,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const product = new Product(productData);
      await product.save();

      res.status(201).json({
        success: true,
        message: "Product created successfully with single file upload",
        product,
      });
    } catch (err) {
      console.error("Single product upload error:", err);
      res.status(400).json({
        success: false,
        error: err.message,
      });
    }
  },
);

// Update product
router.put("/:id", protect, isAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      price,
      images,
      image,
      category,
      subCategory,
      keepExistingImages,
    } = req.body;

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    const updateData = {
      updatedAt: new Date(),
      lastEditedAt: new Date(),
      lastEditedBy: {
        userId: req.user._id,
        name: req.user.name || req.user.email,
        email: req.user.email,
      },
    };

    // Update basic fields
    if (name) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (price) updateData.price = parseFloat(price);
    if (category) updateData.category = category;
    if (subCategory) updateData.subCategory = subCategory;

    // Handle multiple images update
    if (images && Array.isArray(images) && images.length > 0) {
      try {
        // Delete old images if not keeping existing ones
        if (
          !keepExistingImages &&
          product.images &&
          product.images.length > 0
        ) {
          const publicIds = product.images
            .map((img) => img.publicId)
            .filter(Boolean);
          if (publicIds.length > 0) {
            await deleteMultipleImages(publicIds);
          }
        }

        // Also delete old single image for backward compatibility
        if (!keepExistingImages && product.image && product.image.publicId) {
          await deleteImage(product.image.publicId);
        }

        // Upload new images
        const validImages = images.filter((img) => {
          return (
            img &&
            (img.base64 || img.data) &&
            (img.base64?.length > 100 || img.data?.length > 100)
          );
        });

        let newImagesData = [];
        if (validImages.length > 0) {
          newImagesData = await uploadMultipleBase64Images(validImages);
        }

        // Combine with existing images if keeping them
        if (keepExistingImages && product.images) {
          updateData.images = [...product.images, ...newImagesData];
        } else {
          updateData.images = newImagesData;
        }

        // Update primary image for backward compatibility
        if (updateData.images.length > 0) {
          const primaryImage =
            updateData.images.find((img) => img.isPrimary) ||
            updateData.images[0];
          updateData.image = {
            url: primaryImage.url,
            publicId: primaryImage.publicId,
            originalName: primaryImage.originalName,
            uploadedAt: primaryImage.uploadedAt,
          };
        }
      } catch (imageError) {
        console.error("Multiple images update failed:", imageError);
        return res.status(400).json({
          success: false,
          error: `Images update failed: ${imageError.message}`,
        });
      }
    }
    // Handle single image update for backward compatibility
    else if (image) {
      try {
        // Delete old images
        if (product.images && product.images.length > 0) {
          const publicIds = product.images
            .map((img) => img.publicId)
            .filter(Boolean);
          if (publicIds.length > 0) {
            await deleteMultipleImages(publicIds);
          }
        }

        // Delete old single image
        if (product.image && product.image.publicId) {
          await deleteImage(product.image.publicId);
        }

        // Upload new single image
        let imageToUpload = null;
        if (typeof image === "string") {
          imageToUpload = image;
        } else if (image.base64) {
          imageToUpload = image.base64;
        } else if (image.data) {
          imageToUpload = image.data;
        }

        if (imageToUpload) {
          const cloudinaryResult = await uploadBase64Image(imageToUpload, {
            public_id: `product_${Date.now()}`,
          });

          const newImageData = {
            url: cloudinaryResult.url,
            publicId: cloudinaryResult.publicId,
            originalName:
              image.originalName ||
              image.filename ||
              `${name || product.name}.jpg`,
            uploadedAt: new Date(),
          };

          updateData.image = newImageData;
          updateData.images = [
            {
              ...newImageData,
              isPrimary: true,
            },
          ];
        }
      } catch (imageError) {
        console.error("Single image update failed:", imageError);
        return res.status(400).json({
          success: false,
          error: `Image update failed: ${imageError.message}`,
        });
      }
    }

    const updated = await Product.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
    });

    res.json({
      success: true,
      message: "Product updated successfully",
      product: updated,
    });
  } catch (err) {
    console.error("Product update error:", err);
    res.status(400).json({
      success: false,
      error: err.message,
    });
  }
});

// Delete product - Admin only
router.delete("/:id", protect, isAdmin, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({
        success: false,
        error: "Product not found",
      });
    }

    // Delete all images from Cloudinary if they exist
    const imagesToDelete = [];

    // Collect multiple images
    if (product.images && product.images.length > 0) {
      const publicIds = product.images
        .map((img) => img.publicId)
        .filter(Boolean);
      imagesToDelete.push(...publicIds);
    }

    // Collect single image for backward compatibility
    if (product.image && product.image.publicId) {
      // Only add if not already in the images array
      const alreadyIncluded = imagesToDelete.includes(product.image.publicId);
      if (!alreadyIncluded) {
        imagesToDelete.push(product.image.publicId);
      }
    }

    // Delete images from Cloudinary
    if (imagesToDelete.length > 0) {
      try {
        await deleteMultipleImages(imagesToDelete);
        console.log("Images deleted from Cloudinary:", imagesToDelete);
      } catch (imageError) {
        console.error("Failed to delete images from Cloudinary:", imageError);
        // Continue with product deletion even if image deletion fails
      }
    }

    await Product.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: "Product and associated images deleted successfully",
    });
  } catch (err) {
    console.error("Product deletion error:", err);
    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;
