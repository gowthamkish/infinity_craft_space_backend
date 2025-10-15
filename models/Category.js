const mongoose = require('mongoose');

const subcategorySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, { _id: true });

const categorySchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Category name is required'],
    unique: true,
    trim: true,
    maxlength: [100, 'Category name cannot exceed 100 characters']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [200, 'Description cannot exceed 200 characters']
  },
  subcategories: [subcategorySchema],
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt field before saving
categorySchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

//   ],
// });

// Indexes for performance (name index is created automatically by unique: true)
categorySchema.index({ isActive: 1 });
categorySchema.index({ createdBy: 1 });
categorySchema.index({ createdAt: -1 });

// Instance methods
categorySchema.methods.addSubcategory = function(subcategoryData) {
  this.subcategories.push(subcategoryData);
  return this.save();
};

categorySchema.methods.removeSubcategory = function(subcategoryId) {
  this.subcategories.id(subcategoryId).remove();
  return this.save();
};

categorySchema.methods.updateSubcategory = function(subcategoryId, updateData) {
  const subcategory = this.subcategories.id(subcategoryId);
  if (subcategory) {
    Object.assign(subcategory, updateData);
  }
  return this.save();
};

// Static methods
categorySchema.statics.getActiveCategories = function() {
  return this.find({ isActive: true })
    .populate('createdBy', 'username email')
    .sort({ name: 1 });
};

categorySchema.statics.getCategoriesWithActiveSubcategories = function() {
  return this.aggregate([
    { $match: { isActive: true } },
    {
      $addFields: {
        subcategories: {
          $filter: {
            input: '$subcategories',
            cond: { $eq: ['$$this.isActive', true] }
          }
        }
      }
    },
    { $sort: { name: 1 } }
  ]);
};

module.exports = mongoose.model('Category', categorySchema);