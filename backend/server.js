const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const { Room, DrawingCommand } = require('./models/Room');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect('mongodb+srv://whiteboreadmahek:whiteboreadmahek988@cluster0.6bjuryx.mongodb.net/collaborative-whiteboard?retryWrites=true&w=majority&appName=Cluster0', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
});

// Store active rooms and users
const activeRooms = new Map();
const userColors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];

// Generate user color
const getUserColor = (userId) => {
  const hash = userId.split('').reduce((a, b) => {
    a = ((a << 5) - a) + b.charCodeAt(0);
    return a & a;
  }, 0);
  return userColors[Math.abs(hash) % userColors.length];
};

// API Routes
app.post('/api/rooms/join', async (req, res) => {
  try {
    const { roomId } = req.body;
    
    if (!roomId || roomId.length < 4 || roomId.length > 8) {
      return res.status(400).json({ error: 'Invalid room ID' });
    }

    let room = await Room.findOne({ roomId: roomId.toUpperCase() });
    
    if (!room) {
      // Create new room
      room = new Room({
        roomId: roomId.toUpperCase(),
        createdAt: new Date(),
        lastActivity: new Date(),
        drawingData: []
      });
      await room.save();
    } else {
      // Update last activity
      room.lastActivity = new Date();
      await room.save();
    }

    res.json({ 
      success: true, 
      roomId: room.roomId,
      drawingData: room.drawingData 
    });
  } catch (error) {
    console.error('Error joining room:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/rooms/:roomId', async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = await Room.findOne({ roomId: roomId.toUpperCase() });
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    res.json({
      roomId: room.roomId,
      createdAt: room.createdAt,
      lastActivity: room.lastActivity,
      drawingData: room.drawingData,
      activeUsers: activeRooms.get(roomId.toUpperCase())?.size || 0
    });
  } catch (error) {
    console.error('Error getting room info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  let currentRoom = null;
  let cursorUpdateThrottle = null;

  // Join room
  socket.on('join-room', async (roomId) => {
    try {
      const upperRoomId = roomId.toUpperCase();
      
      // Leave current room if any
      if (currentRoom) {
        socket.leave(currentRoom);
        if (activeRooms.has(currentRoom)) {
          activeRooms.get(currentRoom).delete(socket.id);
          if (activeRooms.get(currentRoom).size === 0) {
            activeRooms.delete(currentRoom);
          } else {
            socket.to(currentRoom).emit('user-count-updated', activeRooms.get(currentRoom).size);
            socket.to(currentRoom).emit('user-left', socket.id);
          }
        }
      }

      // Join new room
      socket.join(upperRoomId);
      currentRoom = upperRoomId;

      // Track active users
      if (!activeRooms.has(upperRoomId)) {
        activeRooms.set(upperRoomId, new Set());
      }
      activeRooms.get(upperRoomId).add(socket.id);

      // Get or create room in database
      let room = await Room.findOne({ roomId: upperRoomId });
      if (!room) {
        room = new Room({
          roomId: upperRoomId,
          createdAt: new Date(),
          lastActivity: new Date(),
          drawingData: []
        });
        await room.save();
      }

      // Send room data to user
      socket.emit('room-joined', {
        roomId: upperRoomId,
        drawingData: room.drawingData
      });

      // Notify all users in room about user count
      const userCount = activeRooms.get(upperRoomId).size;
      io.to(upperRoomId).emit('user-count-updated', userCount);

      console.log(`User ${socket.id} joined room ${upperRoomId}. Total users: ${userCount}`);
    } catch (error) {
      console.error('Error joining room:', error);
      socket.emit('error', 'Failed to join room');
    }
  });

  // Leave room
  socket.on('leave-room', (roomId) => {
    if (currentRoom) {
      socket.leave(currentRoom);
      if (activeRooms.has(currentRoom)) {
        activeRooms.get(currentRoom).delete(socket.id);
        const userCount = activeRooms.get(currentRoom).size;
        
        if (userCount === 0) {
          activeRooms.delete(currentRoom);
        } else {
          socket.to(currentRoom).emit('user-count-updated', userCount);
          socket.to(currentRoom).emit('user-left', socket.id);
        }
      }
      currentRoom = null;
    }
  });

  // Handle cursor movement
  socket.on('cursor-move', (data) => {
    if (!currentRoom) return;

    // Throttle cursor updates
    if (cursorUpdateThrottle) {
      clearTimeout(cursorUpdateThrottle);
    }

    cursorUpdateThrottle = setTimeout(() => {
      socket.to(currentRoom).emit('cursor-move', {
        userId: socket.id,
        x: data.x,
        y: data.y,
        color: getUserColor(socket.id)
      });
    }, 16); // ~60fps
  });

  // Handle drawing events
  socket.on('draw-start', async (data) => {
    if (!currentRoom) return;

    const drawingData = {
      type: 'draw-start',
      userId: socket.id,
      x: data.x,
      y: data.y,
      color: data.color,
      width: data.width,
      timestamp: new Date()
    };

    // Broadcast to other users
    socket.to(currentRoom).emit('draw-start', drawingData);

    // Save to database
    try {
      await Room.findOneAndUpdate(
        { roomId: currentRoom },
        { 
          $push: { drawingData: drawingData },
          $set: { lastActivity: new Date() }
        }
      );
    } catch (error) {
      console.error('Error saving draw-start:', error);
    }
  });

  socket.on('draw-move', async (data) => {
    if (!currentRoom) return;

    const drawingData = {
      type: 'draw-move',
      userId: socket.id,
      x: data.x,
      y: data.y,
      timestamp: new Date()
    };

    // Broadcast to other users
    socket.to(currentRoom).emit('draw-move', drawingData);

    // Save to database (might want to throttle this for performance)
    try {
      await Room.findOneAndUpdate(
        { roomId: currentRoom },
        { 
          $push: { drawingData: drawingData },
          $set: { lastActivity: new Date() }
        }
      );
    } catch (error) {
      console.error('Error saving draw-move:', error);
    }
  });

  socket.on('draw-end', async (data) => {
    if (!currentRoom) return;

    const drawingData = {
      type: 'draw-end',
      userId: socket.id,
      path: data.path,
      color: data.color,
      width: data.width,
      timestamp: new Date()
    };

    // Broadcast to other users
    socket.to(currentRoom).emit('draw-end', drawingData);

    // Save to database
    try {
      await Room.findOneAndUpdate(
        { roomId: currentRoom },
        { 
          $push: { drawingData: drawingData },
          $set: { lastActivity: new Date() }
        }
      );
    } catch (error) {
      console.error('Error saving draw-end:', error);
    }
  });

  // Handle canvas clear
  socket.on('clear-canvas', async (data) => {
    if (!currentRoom) return;

    const clearData = {
      type: 'clear',
      userId: socket.id,
      timestamp: new Date()
    };

    // Broadcast to other users
    socket.to(currentRoom).emit('clear-canvas', clearData);

    // Clear drawing data in database
    try {
      await Room.findOneAndUpdate(
        { roomId: currentRoom },
        { 
          $set: { 
            drawingData: [clearData],
            lastActivity: new Date()
          }
        }
      );
    } catch (error) {
      console.error('Error clearing canvas:', error);
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (currentRoom && activeRooms.has(currentRoom)) {
      activeRooms.get(currentRoom).delete(socket.id);
      const userCount = activeRooms.get(currentRoom).size;
      
      if (userCount === 0) {
        activeRooms.delete(currentRoom);
      } else {
        socket.to(currentRoom).emit('user-count-updated', userCount);
        socket.to(currentRoom).emit('user-left', socket.id);
      }
    }

    if (cursorUpdateThrottle) {
      clearTimeout(cursorUpdateThrottle);
    }
  });
});

// Clean up old rooms (run every hour)
setInterval(async () => {
  try {
    const cutoffTime = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24 hours ago
    const result = await Room.deleteMany({
      lastActivity: { $lt: cutoffTime }
    });
    if (result.deletedCount > 0) {
      console.log(`Cleaned up ${result.deletedCount} old rooms`);
    }
  } catch (error) {
    console.error('Error cleaning up old rooms:', error);
  }
}, 60 * 60 * 1000); // Run every hour

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});