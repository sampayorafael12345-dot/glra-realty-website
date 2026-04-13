const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only images are allowed'));
    }
  }
});

// MongoDB Connection String
const MONGODB_URI = 'mongodb+srv://sampayorafael12345_db_user:o6xXWtciFpaeQjuk@cluster0.sxp5mwy.mongodb.net/glra_realty?retryWrites=true&w=majority';

// ============ SCHEMAS ============

const propertySchema = new mongoose.Schema({
  title: { type: String, default: '' },
  location: { type: String, default: '' },
  price: { type: Number, default: 0 },
  monthlyRental: { type: Number, default: 0 },
  bedrooms: { type: Number, default: 0 },
  bathrooms: { type: Number, default: 0 },
  sqm: { type: Number, default: 0 },
  landArea: { type: Number, default: 0 },
  description: { type: String, default: '' },
  mainImage: { type: String, default: '' },
  gallery: { type: [String], default: [] },
  featured: { type: Boolean, default: false },
  status: { type: String, default: 'available' },
  listingType: { type: String, default: 'FOR SALE' },
  propertyType: { type: String, default: 'Condominium' },
  parking: { type: Number, default: 0 },
  mapLocation: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  previousPrice: { type: Number, default: 0 },
  priceUpdatedAt: { type: Date, default: null }
});

const inquirySchema = new mongoose.Schema({
  name: { type: String, default: '' },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  message: { type: String, default: '' },
  propertyId: { type: String, default: null },
  propertyTitle: { type: String, default: null },
  createdAt: { type: Date, default: Date.now }
});

const heroImageSchema = new mongoose.Schema({
  url: { type: String, required: true },
  order: { type: Number, default: 0 },
  compressedSize: { type: Number, default: 0 },
  originalSize: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

const subscriberSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  phone: { type: String, default: '' },
  source: { type: String, default: 'footer' },
  preferences: { priceDrops: { type: Boolean, default: true } },
  subscribedAt: { type: Date, default: Date.now },
  isActive: { type: Boolean, default: true }
});

const priceAlertSchema = new mongoose.Schema({
  email: { type: String, required: true },
  propertyId: { type: String, required: true },
  propertyTitle: { type: String, default: '' },
  propertyPrice: { type: Number, default: 0 },
  notifiedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  isNotified: { type: Boolean, default: false }
});

const wishlistSchema = new mongoose.Schema({
  email: { type: String, required: true },
  propertyId: { type: String, required: true },
  propertyTitle: { type: String, default: '' },
  propertyPrice: { type: Number, default: 0 },
  propertyLocation: { type: String, default: '' },
  propertyImage: { type: String, default: '' },
  addedAt: { type: Date, default: Date.now }
});

const alertLogSchema = new mongoose.Schema({
  type: { type: String, enum: ['price_drop'], required: true },
  propertyId: { type: String, required: true },
  propertyTitle: { type: String, required: true },
  oldPrice: { type: Number, default: 0 },
  newPrice: { type: Number, default: 0 },
  sentTo: { type: Number, default: 0 },
  sentAt: { type: Date, default: Date.now }
});

const Property = mongoose.model('Property', propertySchema);
const Inquiry = mongoose.model('Inquiry', inquirySchema);
const HeroImage = mongoose.model('HeroImage', heroImageSchema);
const Subscriber = mongoose.model('Subscriber', subscriberSchema);
const PriceAlert = mongoose.model('PriceAlert', priceAlertSchema);
const Wishlist = mongoose.model('Wishlist', wishlistSchema);
const AlertLog = mongoose.model('AlertLog', alertLogSchema);

// ============ COMPRESS IMAGE FUNCTION ============
async function compressImage(buffer, originalSize, quality = 80) {
  try {
    const compressedBuffer = await sharp(buffer)
      .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: quality, progressive: true })
      .toBuffer();
    return { buffer: compressedBuffer, size: compressedBuffer.length, mimeType: 'image/jpeg' };
  } catch (error) {
    return { buffer: buffer, size: originalSize, mimeType: 'image/jpeg' };
  }
}

// ============ CONNECT TO MONGODB ============
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 30000,
  socketTimeoutMS: 45000,
})
.then(() => console.log('✅ MongoDB connected successfully!'))
.catch(err => console.error('❌ MongoDB connection error:', err));

mongoose.connection.on('disconnected', () => {
  console.log('⚠️ MongoDB disconnected! Reconnecting...');
  setTimeout(() => mongoose.connect(MONGODB_URI), 5000);
});

// ============ PUBLIC ROUTES ============
app.get('/api/properties', async (req, res) => {
  try {
    const properties = await Property.find({ status: 'available' }).sort({ createdAt: -1 });
    res.json(properties);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/hero-images', async (req, res) => {
  try {
    const images = await HeroImage.find().sort({ order: 1 });
    res.json(images);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inquiries', async (req, res) => {
  try {
    const inquiry = new Inquiry(req.body);
    await inquiry.save();
    console.log('📧 New inquiry from:', req.body.name);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', async (req, res) => {
  const dbState = mongoose.connection.readyState;
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  res.json({
    status: 'ok',
    mongodb: states[dbState] || 'unknown',
    heroImages: await HeroImage.countDocuments(),
    properties: await Property.countDocuments(),
    subscribers: await Subscriber.countDocuments({ isActive: true }),
    timestamp: new Date().toISOString()
  });
});

// ============ SUBSCRIPTION ROUTES ============
app.post('/api/subscribe', async (req, res) => {
  try {
    const { email, name, source } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    
    let existing = await Subscriber.findOne({ email });
    if (existing) {
      if (name) existing.name = name;
      if (source) existing.source = source;
      existing.isActive = true;
      await existing.save();
    } else {
      await Subscriber.create({ email, name: name || '', source: source || 'footer', preferences: { priceDrops: true } });
    }
    res.json({ success: true, message: existing ? 'Subscription updated!' : 'Subscribed successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/unsubscribe', async (req, res) => {
  try {
    const { email } = req.body;
    await Subscriber.findOneAndUpdate({ email }, { isActive: false });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PRICE ALERT ROUTES ============
app.post('/api/price-alert', async (req, res) => {
  try {
    const { email, propertyId, propertyTitle, propertyPrice } = req.body;
    if (!email || !propertyId) return res.status(400).json({ error: 'Email and property ID required' });
    
    const existing = await PriceAlert.findOne({ email, propertyId });
    if (existing) return res.json({ success: true, message: 'Already subscribed' });
    
    let subscriber = await Subscriber.findOne({ email });
    if (!subscriber) await Subscriber.create({ email, source: 'price_alert', preferences: { priceDrops: true } });
    
    await PriceAlert.create({ email, propertyId, propertyTitle, propertyPrice });
    res.json({ success: true, message: 'You will be notified when price drops!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/price-alert/check/:propertyId', async (req, res) => {
  try {
    const { propertyId } = req.params;
    const alerts = await PriceAlert.find({ propertyId, isNotified: false });
    res.json({ count: alerts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ WISHLIST ROUTES ============
app.post('/api/wishlist', async (req, res) => {
  try {
    const { email, propertyId, propertyTitle, propertyPrice, propertyLocation, propertyImage } = req.body;
    if (!email || !propertyId) return res.status(400).json({ error: 'Email and property ID required' });
    
    let subscriber = await Subscriber.findOne({ email });
    if (!subscriber) await Subscriber.create({ email, source: 'wishlist', preferences: { priceDrops: true } });
    
    const existing = await Wishlist.findOne({ email, propertyId });
    if (existing) return res.json({ success: true, message: 'Already saved' });
    
    await Wishlist.create({ email, propertyId, propertyTitle, propertyPrice, propertyLocation, propertyImage });
    res.json({ success: true, message: 'Property saved to wishlist!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/wishlist/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const wishlist = await Wishlist.find({ email }).sort({ addedAt: -1 });
    res.json(wishlist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/wishlist/:email/:propertyId', async (req, res) => {
  try {
    const { email, propertyId } = req.params;
    await Wishlist.findOneAndDelete({ email, propertyId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ ADMIN ROUTES ============
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  if (email === 'admin@glrarealty.com' && password === 'admin123') {
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/api/admin/stats', async (req, res) => {
  try {
    const totalProperties = await Property.countDocuments();
    const availableProperties = await Property.countDocuments({ status: 'available' });
    const totalInquiries = await Inquiry.countDocuments();
    const heroImages = await HeroImage.countDocuments();
    const subscribers = await Subscriber.countDocuments({ isActive: true });
    const activeAlerts = await PriceAlert.countDocuments({ isNotified: false });
    
    res.json({ totalProperties, availableProperties, totalInquiries, heroImages, subscribers, activeAlerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/subscribers', async (req, res) => {
  try {
    const subscribers = await Subscriber.find().sort({ subscribedAt: -1 });
    res.json(subscribers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/price-alerts', async (req, res) => {
  try {
    const alerts = await PriceAlert.find().sort({ createdAt: -1 });
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/alert-logs', async (req, res) => {
  try {
    const logs = await AlertLog.find().sort({ sentAt: -1 }).limit(50);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/all-properties', async (req, res) => {
  try {
    const properties = await Property.find().sort({ createdAt: -1 });
    res.json(properties);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/inquiries', async (req, res) => {
  try {
    const inquiries = await Inquiry.find().sort({ createdAt: -1 });
    res.json(inquiries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/properties', async (req, res) => {
  try {
    const property = new Property(req.body);
    await property.save();
    console.log('✅ Property added:', property.title);
    res.json(property);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/properties/:id', async (req, res) => {
  try {
    const oldProperty = await Property.findById(req.params.id);
    const updatedData = req.body;
    
    if (oldProperty && oldProperty.price !== updatedData.price && updatedData.price < oldProperty.price) {
      updatedData.previousPrice = oldProperty.price;
      updatedData.priceUpdatedAt = new Date();
      console.log(`💰 Price drop detected for ${oldProperty.title}`);
    }
    
    const property = await Property.findByIdAndUpdate(req.params.id, updatedData, { new: true });
    res.json(property);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/properties/:id', async (req, res) => {
  try {
    await Property.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/inquiries/:id', async (req, res) => {
  try {
    await Inquiry.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/subscribers/:id', async (req, res) => {
  try {
    await Subscriber.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/properties/bulk', async (req, res) => {
  try {
    const properties = req.body;
    let added = 0;
    for (const prop of properties) {
      const existing = await Property.findOne({ title: prop.title, location: prop.location });
      if (!existing) {
        await new Property(prop).save();
        added++;
      }
    }
    res.json({ success: true, added });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ PROPERTY IMAGE UPLOAD ============
app.post('/api/admin/upload-property-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    
    const compressed = await compressImage(req.file.buffer, req.file.size, 75);
    const base64Image = compressed.buffer.toString('base64');
    const imageUrl = `data:${compressed.mimeType};base64,${base64Image}`;
    
    res.json({ url: imageUrl, size: compressed.size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ HERO IMAGES MANAGEMENT ============
app.get('/api/admin/hero-images', async (req, res) => {
  try {
    const images = await HeroImage.find().sort({ order: 1 });
    res.json(images);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/hero-images/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    
    const compressed = await compressImage(req.file.buffer, req.file.size, 80);
    const base64Image = compressed.buffer.toString('base64');
    const imageUrl = `data:${compressed.mimeType};base64,${base64Image}`;
    
    const count = await HeroImage.countDocuments();
    const newImage = new HeroImage({ url: imageUrl, order: count, compressedSize: compressed.size, originalSize: req.file.size });
    await newImage.save();
    
    res.json(newImage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/hero-images/reorder', async (req, res) => {
  try {
    const { images } = req.body;
    for (const img of images) {
      await HeroImage.findByIdAndUpdate(img._id, { order: img.order });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/hero-images/:id/default', async (req, res) => {
  try {
    const images = await HeroImage.find().sort({ order: 1 });
    let newOrder = 0;
    for (const img of images) {
      if (img._id.toString() === req.params.id) {
        img.order = 0;
      } else {
        img.order = newOrder + 1;
        newOrder++;
      }
      await img.save();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/hero-images/:id', async (req, res) => {
  try {
    await HeroImage.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============ SERVE FILES ============
app.get('/sitemap.xml', (req, res) => {
  const sitemapPath = path.join(__dirname, 'sitemap.xml');
  if (fs.existsSync(sitemapPath)) {
    res.sendFile(sitemapPath);
  } else {
    res.status(404).send('Sitemap not found');
  }
});

// ============ START SERVER ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
  ╔═══════════════════════════════════════════════════════════════╗
  ║              🏠 GLRA REALTY WEBSITE IS READY!                ║
  ╠═══════════════════════════════════════════════════════════════╣
  ║   Website: https://glrarealty.com                            ║
  ║   Admin:   https://glrarealty.com/admin.html                 ║
  ║   MongoDB: Connected ✅                                       ║
  ║   Images:  Compressed & stored in MongoDB                    ║
  ╚═══════════════════════════════════════════════════════════════╝
  `);
});
