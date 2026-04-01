const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Create SQLite database (file-based, no installation needed!)
const db = new sqlite3.Database('./realty.db');

// Create tables if they don't exist
db.run(`
  CREATE TABLE IF NOT EXISTS properties (
    _id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    location TEXT,
    price REAL,
    bedrooms INTEGER,
    bathrooms INTEGER,
    sqm INTEGER,
    description TEXT,
    mainImage TEXT,
    gallery TEXT,
    featured INTEGER DEFAULT 0,
    status TEXT DEFAULT 'available',
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS inquiries (
    _id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    phone TEXT,
    message TEXT,
    propertyId TEXT,
    propertyTitle TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

console.log('✅ SQLite database ready');

// ============ PUBLIC ROUTES ============

// Get all properties
app.get('/api/properties', (req, res) => {
  db.all('SELECT * FROM properties ORDER BY createdAt DESC', (err, properties) => {
    if (err) {
      console.error('Error loading properties:', err);
      res.status(500).json({ error: err.message });
      return;
    }
    // Parse gallery JSON for each property
    properties = properties.map(p => ({
      ...p,
      gallery: p.gallery ? JSON.parse(p.gallery) : []
    }));
    res.json(properties);
  });
});

// Submit inquiry
app.post('/api/inquiries', (req, res) => {
  const { name, email, phone, message, propertyId, propertyTitle } = req.body;
  db.run(
    'INSERT INTO inquiries (name, email, phone, message, propertyId, propertyTitle) VALUES (?, ?, ?, ?, ?, ?)',
    [name, email, phone, message, propertyId, propertyTitle],
    function(err) {
      if (err) {
        console.error('Error saving inquiry:', err);
        res.status(500).json({ error: err.message });
        return;
      }
      console.log('📧 New inquiry from:', name);
      res.json({ success: true, message: 'Inquiry sent!' });
    }
  );
});

// ============ ADMIN ROUTES ============

// Admin login (simple check)
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (email === 'admin@glrarealty.com' && password === 'admin123') {
    res.json({ success: true, message: 'Logged in!' });
  } else {
    res.status(401).json({ error: 'Wrong email or password' });
  }
});

// Add new property
app.post('/api/admin/properties', (req, res) => {
  const { title, location, price, bedrooms, bathrooms, sqm, description, mainImage, gallery, featured, status } = req.body;
  const galleryJson = JSON.stringify(gallery || []);
  const featuredInt = featured ? 1 : 0;
  
  db.run(
    `INSERT INTO properties (title, location, price, bedrooms, bathrooms, sqm, description, mainImage, gallery, featured, status) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [title, location, price, bedrooms, bathrooms, sqm, description, mainImage, galleryJson, featuredInt, status],
    function(err) {
      if (err) {
        console.error('Error adding property:', err);
        res.status(500).json({ error: err.message });
        return;
      }
      console.log('✅ Property added:', title);
      res.json({ _id: this.lastID, ...req.body });
    }
  );
});

// Delete property
app.delete('/api/admin/properties/:id', (req, res) => {
  db.run('DELETE FROM properties WHERE _id = ?', req.params.id, function(err) {
    if (err) {
      console.error('Error deleting property:', err);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: true });
  });
});

// Get all inquiries
app.get('/api/admin/inquiries', (req, res) => {
  db.all('SELECT * FROM inquiries ORDER BY createdAt DESC', (err, inquiries) => {
    if (err) {
      console.error('Error loading inquiries:', err);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json(inquiries);
  });
});

// Delete inquiry
app.delete('/api/admin/inquiries/:id', (req, res) => {
  db.run('DELETE FROM inquiries WHERE _id = ?', req.params.id, function(err) {
    if (err) {
      console.error('Error deleting inquiry:', err);
      res.status(500).json({ error: err.message });
      return;
    }
    res.json({ success: true });
  });
});

// Get stats
app.get('/api/admin/stats', (req, res) => {
  db.get('SELECT COUNT(*) as totalProperties FROM properties', [], (err, propCount) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    db.get('SELECT COUNT(*) as availableProperties FROM properties WHERE status = "available"', [], (err, availCount) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      db.get('SELECT COUNT(*) as totalInquiries FROM inquiries', [], (err, inquiryCount) => {
        if (err) {
          res.status(500).json({ error: err.message });
          return;
        }
        res.json({
          totalProperties: propCount.totalProperties,
          availableProperties: availCount.availableProperties,
          totalInquiries: inquiryCount.totalInquiries
        });
      });
    });
  });
});

// Start the server
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   🏠 GLRA REALTY WEBSITE IS READY!   ║
  ╠═══════════════════════════════════════╣
  ║   Website: http://localhost:3000     ║
  ║   Admin:   http://localhost:3000/admin.html ║
  ╚═══════════════════════════════════════╝
  `);
});