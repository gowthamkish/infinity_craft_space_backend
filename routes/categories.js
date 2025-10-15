const express = require('express');
const Category = require('../models/Category');
const { protect, isAdmin } = require('../middlewares/authMiddleware');

const router = express.Router();

// @desc    Get categories for public use (products page)
// @route   GET /api/categories/public/list
// @access  Public
router.get('/public/list', async (req, res) => {
  try {
    const categories = await Category.getCategoriesWithActiveSubcategories();

    res.json({
      success: true,
      count: categories.length,
      categories
    });
  } catch (error) {
    console.error('Error fetching public categories:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch categories',
      error: error.message
    });
  }
});

// Apply authentication and admin middleware to all routes below
router.use(protect);
router.use(isAdmin);

// @desc    Get all categories
// @route   GET /api/categories
// @access  Private/Admin
router.get('/', async (req, res) => {
  try {
    const { includeInactive = false } = req.query;
    
    let query = {};
    if (!includeInactive || includeInactive === 'false') {
      query.isActive = true;
    }

    const categories = await Category.find(query)
      .populate('createdBy', 'username email')
      .sort({ name: 1 });

    res.json({
      success: true,
      count: categories.length,
      categories
    });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch categories',
      error: error.message
    });
  }
});

// @desc    Get single category by ID
// @route   GET /api/admin/categories/:id
// @access  Private/Admin
router.get('/:id', async (req, res) => {
  try {
    const category = await Category.findById(req.params.id)
      .populate('createdBy', 'username email');

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.json({
      success: true,
      category
    });
  } catch (error) {
    console.error('Error fetching category:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch category',
      error: error.message
    });
  }
});

// @desc    Create new category
// @route   POST /api/admin/categories
// @access  Private/Admin
router.post('/', async (req, res) => {
  try {
    const { name, description, subcategories = [] } = req.body;

    // Check if category already exists
    const existingCategory = await Category.findOne({ 
      name: { $regex: new RegExp(`^${name}$`, 'i') }
    });

    if (existingCategory) {
      return res.status(400).json({
        success: false,
        message: 'Category with this name already exists'
      });
    }

    const categoryData = {
      name,
      description,
      subcategories,
      createdBy: req.user._id
    };

    const category = new Category(categoryData);
    await category.save();

    // Populate the createdBy field for response
    await category.populate('createdBy', 'username email');

    res.status(201).json({
      success: true,
      message: 'Category created successfully',
      category
    });
  } catch (error) {
    console.error('Error creating category:', error);
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to create category',
      error: error.message
    });
  }
});

// @desc    Update category
// @route   PUT /api/admin/categories/:id
// @access  Private/Admin
router.put('/:id', async (req, res) => {
  try {
    const { name, description, isActive } = req.body;

    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Check if new name conflicts with existing category (excluding current one)
    if (name && name !== category.name) {
      const existingCategory = await Category.findOne({ 
        name: { $regex: new RegExp(`^${name}$`, 'i') },
        _id: { $ne: req.params.id }
      });

      if (existingCategory) {
        return res.status(400).json({
          success: false,
          message: 'Category with this name already exists'
        });
      }
    }

    // Update fields
    if (name !== undefined) category.name = name;
    if (description !== undefined) category.description = description;
    if (isActive !== undefined) category.isActive = isActive;

    await category.save();
    await category.populate('createdBy', 'username email');

    res.json({
      success: true,
      message: 'Category updated successfully',
      category
    });
  } catch (error) {
    console.error('Error updating category:', error);
    
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to update category',
      error: error.message
    });
  }
});

// @desc    Delete category (soft delete)
// @route   DELETE /api/admin/categories/:id
// @access  Private/Admin
router.delete('/:id', async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Soft delete by setting isActive to false
    category.isActive = false;
    await category.save();

    res.json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete category',
      error: error.message
    });
  }
});

// @desc    Add subcategory to category
// @route   POST /api/admin/categories/:id/subcategories
// @access  Private/Admin
router.post('/:id/subcategories', async (req, res) => {
  try {
    const { name, description } = req.body;

    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Check if subcategory already exists in this category
    const existingSubcategory = category.subcategories.find(
      sub => sub.name.toLowerCase() === name.toLowerCase()
    );

    if (existingSubcategory) {
      return res.status(400).json({
        success: false,
        message: 'Subcategory with this name already exists in this category'
      });
    }

    const subcategory = { name, description };
    await category.addSubcategory(subcategory);

    res.status(201).json({
      success: true,
      message: 'Subcategory added successfully',
      category
    });
  } catch (error) {
    console.error('Error adding subcategory:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add subcategory',
      error: error.message
    });
  }
});

// @desc    Update subcategory
// @route   PUT /api/admin/categories/:id/subcategories/:subId
// @access  Private/Admin
router.put('/:id/subcategories/:subId', async (req, res) => {
  try {
    const { name, description, isActive } = req.body;

    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    const subcategory = category.subcategories.id(req.params.subId);

    if (!subcategory) {
      return res.status(404).json({
        success: false,
        message: 'Subcategory not found'
      });
    }

    // Update subcategory fields
    if (name !== undefined) subcategory.name = name;
    if (description !== undefined) subcategory.description = description;
    if (isActive !== undefined) subcategory.isActive = isActive;

    await category.save();

    res.json({
      success: true,
      message: 'Subcategory updated successfully',
      category
    });
  } catch (error) {
    console.error('Error updating subcategory:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update subcategory',
      error: error.message
    });
  }
});

// @desc    Delete subcategory
// @route   DELETE /api/admin/categories/:id/subcategories/:subId
// @access  Private/Admin
router.delete('/:id/subcategories/:subId', async (req, res) => {
  try {
    const category = await Category.findById(req.params.id);

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    const subcategory = category.subcategories.id(req.params.subId);

    if (!subcategory) {
      return res.status(404).json({
        success: false,
        message: 'Subcategory not found'
      });
    }

    await category.removeSubcategory(req.params.subId);

    res.json({
      success: true,
      message: 'Subcategory deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting subcategory:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete subcategory',
      error: error.message
    });
  }
});

module.exports = router;