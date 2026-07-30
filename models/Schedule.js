const mongoose = require("mongoose");

const slotSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      maxlength: 150,
      default: ""
    },
    notes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: ""
    }
  },
  {
    _id: true,
    versionKey: false
  }
);

const scheduleSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: "main"
    },
    slots: {
      type: [slotSchema],
      required: true,
      validate: {
        validator(slots) {
          return Array.isArray(slots) && slots.length === 12;
        },
        message: "The schedule must contain exactly 12 slots."
      }
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

module.exports = mongoose.model("Schedule", scheduleSchema);
