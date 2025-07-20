const mongoose = require('mongoose');

// Drawing Command Schema
const drawingCommandSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    enum: ['draw-start', 'draw-move', 'draw-end', 'clear']
  },
  userId: {
    type: String,
    required: true
  },
  x: {
    type: Number,
    required: function() {
      return this.type !== 'clear';
    }
  },
  y: {
    type: Number,
    required: function() {
      return this.type !== 'clear';
    }
  },
  color: {
    type: String,
    required: function() {
      return this.type === 'draw-start' || this.type === 'draw-end';
    }
  },
  width: {
    type: Number,
    required: function() {
      return this.type === 'draw-start' || this.type === 'draw-end';
    }
  },
  path: {
    type: [{
      x: Number,
      y: Number
    }],
    required: function() {
      return this.type === 'draw-end';
    }
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
});

// Room Schema
const roomSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    minlength: 4,
    maxlength: 8
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  lastActivity: {
    type: Date,
    default: Date.now
  },
  drawingData: [drawingCommandSchema]
});

roomSchema.index({ roomId: 1 });
roomSchema.index({ lastActivity: 1 });

const Room = mongoose.model('Room', roomSchema);
const DrawingCommand = mongoose.model('DrawingCommand', drawingCommandSchema);

module.exports = {
  Room,
  DrawingCommand
};