const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const { Resend } = require('resend');
const app = express();

// ============ RESEND EMAIL CONFIGURATION ============
const resend = new Resend(process.env.RESEND_API_KEY);

// Email sending function
async function sendEmail(to, subject, htmlContent) {
  try {
    const { data, error } = await resend.emails.send({
      from: 'GLRA Realty <hello@glrarealty.com>',
      to: [to],
      subject: subject,
      html: htmlContent
    });
    if (error) {
      console.error('Email error:', error);
      return { success: false, error };
    }
    console.log(`✅ Email sent to ${to}: ${subject}`);
    return { success: true, data };
  } catch (error) {
    console.error('Email send failed:', error);
    return { success: false, error };
  }
}

// ============ CLOUDINARY CONFIGURATION ============
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dskocmib9',
  api_key: process.env.CLOUDINARY_API_KEY || '593914479525749',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'knfdQ0hM_uQFBr-DtL6K1-yAlRk'
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ limit: '200mb', extended: true }));
app.use(express.static('public'));

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for temporary file upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'public/uploads/');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 20 * 1024 * 1024 },
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
  pricePerSqm: { type: String, default: '' },
  commission: { type: Number, default: 0 },
  fixedAmount: { type: Number, default: 0 },
  totalCommission: { type: Number, default: 0 },
  parkingPrice: { type: Number, default: 0 },
  additionalParkingStatus: { type: String, default: '' },
  developer: { type: String, default: '' },
  notes: { type: String, default: '' },
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
  createdAt: { type: Date, default: Date.now }
});

const subscriberSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  name: { type: String, default: '' },
  phone: { type: String, default: '' },
  source: { type: String, default: 'footer' },
  preferences: {
    priceDrops: { type: Boolean, default: true }
  },
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
    
    // Send confirmation email to user
    if (req.body.email) {
      const userEmailHtml = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
          <div style="text-align: center; margin-bottom: 20px;">
            <h1 style="color: #f97316;">GLRA Realty</h1>
          </div>
          <h2 style="color: #333;">Thank you for your inquiry, ${req.body.name}!</h2>
          <p>We have received your message and will get back to you within 24 hours.</p>
          <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Your message:</strong></p>
            <p>${req.body.message}</p>
            ${req.body.propertyTitle ? `<p><strong>Property of interest:</strong> ${req.body.propertyTitle}</p>` : ''}
          </div>
          <p>Best regards,<br><strong>GLRA Realty Team</strong></p>
          <p style="font-size: 12px; color: #888; margin-top: 20px;">📍 17th Floor, 252 Senator Gil J. Puyat Avenue, Makati City</p>
        </div>
      `;
      await sendEmail(req.body.email, 'Thank you for contacting GLRA Realty', userEmailHtml);
    }
    
    // Send notification to admin
    const adminEmailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <h2 style="color: #f97316;">New Inquiry Received!</h2>
        <p><strong>Name:</strong> ${req.body.name}</p>
        <p><strong>Email:</strong> ${req.body.email}</p>
        <p><strong>Phone:</strong> ${req.body.phone || 'Not provided'}</p>
        <p><strong>Message:</strong> ${req.body.message}</p>
        ${req.body.propertyTitle ? `<p><strong>Property:</strong> ${req.body.propertyTitle}</p>` : ''}
        <hr>
        <p><a href="https://glrarealty.com/admin.html" style="background: #f97316; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View in Admin</a></p>
      </div>
    `;
    await sendEmail('glrarealty@gmail.com', 'New Property Inquiry - GLRA Realty', adminEmailHtml);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Inquiry error:', err);
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
    subscribers: await Subscriber.countDocuments(),
    timestamp: new Date().toISOString()
  });
});

// ============ SUBSCRIPTION ROUTES ============

app.post('/api/subscribe', async (req, res) => {
  try {
    const { email, name, source } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    let existing = await Subscriber.findOne({ email });
    let isNew = false;
    
    if (existing) {
      if (name) existing.name = name;
      if (source) existing.source = source;
      existing.isActive = true;
      await existing.save();
    } else {
      await Subscriber.create({ 
        email, 
        name: name || '', 
        source: source || 'footer',
        preferences: { priceDrops: true }
      });
      isNew = true;
      
      // Send welcome email for new subscribers
      if (source !== 'calculator_print') {
        const welcomeHtml = `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
            <div style="text-align: center; margin-bottom: 20px;">
              <h1 style="color: #f97316;">GLRA Realty</h1>
            </div>
            <h2>Welcome to GLRA Realty, ${name || 'Valued Customer'}!</h2>
            <p>Thank you for subscribing to our newsletter. You'll receive updates on:</p>
            <ul>
              <li>New property listings</li>
              <li>Price drop alerts on properties you're interested in</li>
              <li>Real estate tips and guides</li>
              <li>Market updates</li>
            </ul>
            <p>Best regards,<br><strong>GLRA Realty Team</strong></p>
          </div>
        `;
        await sendEmail(email, 'Welcome to GLRA Realty!', welcomeHtml);
      }
    }
    
    console.log(`📧 ${isNew ? 'New' : 'Updated'} subscriber:`, email);
    res.json({ success: true, message: isNew ? 'Subscribed successfully!' : 'Subscription updated!', isNew });
  } catch (err) {
    console.error('Subscribe error:', err);
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

// ============ WISHLIST ROUTES ============

app.post('/api/wishlist', async (req, res) => {
  try {
    const { email, propertyId, propertyTitle, propertyPrice, propertyLocation, propertyImage } = req.body;
    
    if (!email || !propertyId) {
      return res.status(400).json({ error: 'Email and property ID required' });
    }
    
    // Check if already exists
    const existing = await Wishlist.findOne({ email, propertyId });
    if (existing) {
      return res.json({ success: true, message: 'Already saved to wishlist' });
    }
    
    // Create wishlist item
    const wishlistItem = new Wishlist({
      email,
      propertyId,
      propertyTitle,
      propertyPrice,
      propertyLocation,
      propertyImage
    });
    
    await wishlistItem.save();
    
    // Also add as subscriber if not exists
    const existingSubscriber = await Subscriber.findOne({ email });
    if (!existingSubscriber) {
      await Subscriber.create({ email, source: 'wishlist', preferences: { priceDrops: true } });
    }
    
    console.log(`❤️ ${email} saved ${propertyTitle} to wishlist`);
    res.json({ success: true, message: 'Property saved to wishlist!' });
  } catch (err) {
    console.error('Wishlist error:', err);
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

// ============ PRICE ALERT ROUTES ============

app.post('/api/price-alert', async (req, res) => {
  try {
    const { email, propertyId, propertyTitle, propertyPrice } = req.body;
    
    if (!email || !propertyId) {
      return res.status(400).json({ error: 'Email and property ID required' });
    }
    
    // Check if already subscribed
    const existing = await PriceAlert.findOne({ email, propertyId });
    if (existing) {
      return res.json({ success: true, message: 'Already subscribed to price alerts for this property' });
    }
    
    // Create price alert
    const alert = new PriceAlert({
      email,
      propertyId,
      propertyTitle,
      propertyPrice
    });
    
    await alert.save();
    
    // Also add as subscriber if not exists
    const existingSubscriber = await Subscriber.findOne({ email });
    if (!existingSubscriber) {
      await Subscriber.create({ email, source: 'price_alert', preferences: { priceDrops: true } });
    }
    
    // Send confirmation email
    const confirmationHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #f97316;">GLRA Realty</h1>
        </div>
        <h2>Price Drop Alert Set!</h2>
        <p>You will be notified when the price drops for:</p>
        <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <p><strong>${propertyTitle}</strong></p>
          <p>Current Price: ₱${propertyPrice.toLocaleString()}</p>
        </div>
        <p>We'll email you immediately when the price changes.</p>
        <p>Best regards,<br><strong>GLRA Realty Team</strong></p>
      </div>
    `;
    await sendEmail(email, `Price Alert Set for ${propertyTitle}`, confirmationHtml);
    
    console.log(`🔔 Price alert set for ${email} on ${propertyTitle}`);
    res.json({ success: true, message: 'You will be notified when price drops!' });
  } catch (err) {
    console.error('Price alert error:', err);
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
    const wishlistCount = await Wishlist.countDocuments();
    
    res.json({ 
      totalProperties, 
      availableProperties, 
      totalInquiries,
      heroImages,
      subscribers,
      activeAlerts,
      wishlistCount
    });
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

app.get('/api/admin/wishlist', async (req, res) => {
  try {
    const wishlist = await Wishlist.find().sort({ addedAt: -1 });
    res.json(wishlist);
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
    console.log('📝 Received property:', req.body.title);
    const property = new Property(req.body);
    await property.save();
    console.log('✅ Property added:', property.title);
    res.json(property);
  } catch (err) {
    console.error('❌ Error adding property:', err);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/properties/:id', async (req, res) => {
  try {
    const oldProperty = await Property.findById(req.params.id);
    const updatedData = req.body;
    
    // Check for price drop
    if (oldProperty && oldProperty.price !== updatedData.price && updatedData.price < oldProperty.price) {
      updatedData.previousPrice = oldProperty.price;
      updatedData.priceUpdatedAt = new Date();
      console.log(`💰 Price drop detected for ${oldProperty.title}: ₱${oldProperty.price.toLocaleString()} → ₱${updatedData.price.toLocaleString()}`);
      
      // Find all users who requested alerts for this property
      const alerts = await PriceAlert.find({ 
        propertyId: req.params.id, 
        isNotified: false 
      });
      
      if (alerts.length > 0) {
        // Send email to each user
        for (const alert of alerts) {
          const priceDropHtml = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
              <div style="text-align: center; margin-bottom: 20px;">
                <h1 style="color: #f97316;">GLRA Realty</h1>
              </div>
              <h2 style="color: #10b981;">💰 Price Drop Alert!</h2>
              <p>Great news! The price has dropped for a property you're watching:</p>
              <div style="background: #f5f5f5; padding: 15px; border-radius: 8px; margin: 20px 0;">
                <p><strong>${oldProperty.title}</strong></p>
                <p>📍 ${oldProperty.location}</p>
                <p><span style="text-decoration: line-through; color: #888;">Old Price: ₱${oldProperty.price.toLocaleString()}</span></p>
                <p><strong style="color: #10b981;">New Price: ₱${updatedData.price.toLocaleString()}</strong></p>
                <p>💵 Savings: ₱${(oldProperty.price - updatedData.price).toLocaleString()}</p>
              </div>
              <a href="https://glrarealty.com/properties.html?property=${req.params.id}" style="background: #f97316; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">View Property</a>
              <p style="margin-top: 20px;">Best regards,<br><strong>GLRA Realty Team</strong></p>
            </div>
          `;
          await sendEmail(alert.email, `💰 Price Drop: ${oldProperty.title}`, priceDropHtml);
          
          // Mark alert as notified
          alert.isNotified = true;
          alert.notifiedAt = new Date();
          await alert.save();
        }
        
        // Log the alert
        await AlertLog.create({
          type: 'price_drop',
          propertyId: req.params.id,
          propertyTitle: oldProperty.title,
          oldPrice: oldProperty.price,
          newPrice: updatedData.price,
          sentTo: alerts.length
        });
        
        console.log(`📧 Sent price drop alerts to ${alerts.length} subscribers`);
      }
    }
    
    const property = await Property.findByIdAndUpdate(req.params.id, updatedData, { new: true });
    res.json(property);
  } catch (err) {
    console.error('Error updating property:', err);
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
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'glra_realty/properties',
      transformation: [
        { width: 1200, height: 800, crop: 'limit' },
        { quality: 'auto' }
      ]
    });
    
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    console.log(`🖼️ Property image uploaded to Cloudinary: ${result.secure_url}`);
    res.json({ url: result.secure_url, size: result.bytes });
  } catch (err) {
    console.error('Error uploading property image:', err);
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
    if (!req.file) {
      return res.status(400).json({ error: 'No image file provided' });
    }
    
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'glra_realty/hero',
      transformation: [
        { width: 1920, height: 1080, crop: 'fill' },
        { quality: 'auto' }
      ]
    });
    
    if (fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    const count = await HeroImage.countDocuments();
    const newImage = new HeroImage({ url: result.secure_url, order: count });
    await newImage.save();
    
    console.log(`🖼️ Hero image saved to Cloudinary: ${result.secure_url}`);
    res.json(newImage);
  } catch (err) {
    console.error('Error uploading hero image:', err);
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
  ║   Cloudinary: Connected ✅                                    ║
  ║   Resend Email: Ready ✅                                      ║
  ║   Features: Properties | Inquiries | Wishlist | Alerts       ║
  ╚═══════════════════════════════════════════════════════════════╝
  `);
});
