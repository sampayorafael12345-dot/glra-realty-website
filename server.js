const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cloudinary = require('cloudinary').v2;
const brevo = require('@getbrevo/brevo');

const app = express();

// ============ BREVO EMAIL CONFIGURATION ============
let brevoApiInstance = null;

function initBrevo() {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.log('⚠️ BREVO_API_KEY not set. Email sending will be disabled.');
    return false;
  }
  
  let defaultClient = brevo.ApiClient.instance;
  let apiKeyAuth = defaultClient.authentications['api-key'];
  apiKeyAuth.apiKey = apiKey;
  brevoApiInstance = new brevo.TransactionalEmailsApi();
  console.log('✅ Brevo email service initialized');
  return true;
}

async function sendEmail(to, subject, htmlContent, fromName = 'GLRA Realty') {
  if (!brevoApiInstance) {
    const initialized = initBrevo();
    if (!initialized) {
      console.error('❌ Brevo not configured. Cannot send email to:', to);
      return { success: false, error: 'Email service not configured' };
    }
  }
  
  try {
    const sendSmtpEmail = new brevo.SendSmtpEmail();
    sendSmtpEmail.to = [{ email: to }];
    sendSmtpEmail.sender = { email: 'hello@glrarealty.com', name: fromName };
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = htmlContent;
    
    const response = await brevoApiInstance.sendTransacEmail(sendSmtpEmail);
    console.log(`✅ Email sent to ${to}: ${subject}`);
    return { success: true, data: response };
  } catch (error) {
    console.error('Email send failed:', error.response?.body || error.message);
    return { success: false, error };
  }
}

// Initialize Brevo on startup
initBrevo();

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
const MONGODB_URI = process.env.MONGODB_URL || 'mongodb+srv://sampayorafael12345_db_user:o6xXWtciFpaeQjuk@cluster0.sxp5mwy.mongodb.net/glra_realty?retryWrites=true&w=majority';

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

// ============ PROFESSIONAL EMAIL TEMPLATES ============

function getEmailHeader() {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <title>GLRA Realty</title>
    </head>
    <body style="margin: 0; padding: 0; background-color: #f5f5f0; font-family: Arial, sans-serif;">
      <div style="max-width: 550px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.05);">
        <div style="background-color: #1a1a2e; padding: 30px 25px; text-align: center;">
          <h1 style="color: #c5a059; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 28px; margin: 0; letter-spacing: 2px;">GLRA REALTY</h1>
          <p style="color: #a0a0a0; margin: 8px 0 0 0; font-size: 12px;">Licensed Real Estate Agent | Metro Manila & Luzon</p>
        </div>
        <div style="padding: 35px 30px;">
  `;
}

function getEmailFooter() {
  return `
        </div>
        <div style="background-color: #f9f9f5; padding: 20px 30px; text-align: center; border-top: 1px solid #e8e8e0;">
          <p style="margin: 0 0 5px 0; color: #888888; font-size: 12px;">GLRA Realty Group</p>
          <p style="margin: 0; color: #888888; font-size: 11px;">17th Floor, 252 Senator Gil J. Puyat Avenue, Makati City, Philippines 1200</p>
          <p style="margin: 10px 0 0 0; color: #888888; font-size: 11px;">
            <a href="tel:+639171774572" style="color: #c5a059; text-decoration: none;">+63 917 177 4572</a> | 
            <a href="mailto:glrarealty@gmail.com" style="color: #c5a059; text-decoration: none;">glrarealty@gmail.com</a>
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
}

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
      const userEmailHtml = getEmailHeader() + `
        <h2 style="color: #1a1a2e; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 22px; margin: 0 0 8px 0;">Dear ${req.body.name},</h2>
        <p style="color: #555555; line-height: 1.6; font-size: 14px;">Thank you for reaching out to GLRA Realty. We have received your inquiry and our team will respond within 24 hours.</p>
        
        <div style="background-color: #f9f9f5; border-left: 3px solid #c5a059; padding: 18px 20px; margin: 25px 0; border-radius: 4px;">
          <p style="margin: 0 0 8px 0; font-weight: 600; color: #1a1a2e;">Your Message:</p>
          <p style="margin: 0; color: #555555; font-size: 14px; line-height: 1.5;">${req.body.message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
          ${req.body.propertyTitle ? `<p style="margin: 12px 0 0 0; color: #555555; font-size: 13px;"><strong>Property of Interest:</strong> ${req.body.propertyTitle}</p>` : ''}
        </div>
        
        <p style="color: #555555; line-height: 1.6; font-size: 14px;">We look forward to assisting you with your real estate needs.</p>
        
        <p style="color: #555555; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
      ` + getEmailFooter();
      await sendEmail(req.body.email, 'Thank you for contacting GLRA Realty', userEmailHtml);
    }
    
    // Send notification to admin
    const adminEmailHtml = getEmailHeader() + `
      <h2 style="color: #c5a059; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 20px; margin: 0 0 15px 0;">New Inquiry Received</h2>
      
      <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
        <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600; width: 100px;">Name</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${req.body.name}</td></tr>
        <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Email</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${req.body.email}</td></tr>
        <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Phone</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${req.body.phone || 'Not provided'}</td></tr>
        ${req.body.propertyTitle ? `<tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Property</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${req.body.propertyTitle}</td></tr>` : ''}
        <tr><td style="padding: 8px 0; font-weight: 600; vertical-align: top;">Message</td><td style="padding: 8px 0;">${req.body.message.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td></tr>
      </table>
      
      <p><a href="https://glrarealty.com/admin.html" style="background-color: #c5a059; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">View in Admin Dashboard</a></p>
    ` + getEmailFooter();
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
      
      // Send welcome email for new subscribers (not from calculator print)
      if (source !== 'calculator_print') {
        const welcomeHtml = getEmailHeader() + `
          <h2 style="color: #1a1a2e; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 22px; margin: 0 0 8px 0;">Welcome to GLRA Realty</h2>
          <p style="color: #555555; line-height: 1.6; font-size: 14px;">Dear ${name || 'Valued Subscriber'},</p>
          <p style="color: #555555; line-height: 1.6; font-size: 14px;">Thank you for subscribing to our newsletter. You will now receive updates on new property listings, price drops, and real estate market insights.</p>
          
          <div style="background-color: #f9f9f5; padding: 15px 20px; margin: 25px 0; border-radius: 4px;">
            <p style="margin: 0 0 5px 0; font-weight: 600; color: #1a1a2e;">What to expect:</p>
            <p style="margin: 0; color: #555555; font-size: 13px;">New property listings • Price drop alerts • Real estate guides • Market updates</p>
          </div>
          
          <p style="color: #555555; line-height: 1.6; font-size: 14px;">We're honored to be part of your real estate journey.</p>
          <p style="color: #555555; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
        ` + getEmailFooter();
        await sendEmail(email, 'Welcome to GLRA Realty', welcomeHtml);
      }
    }
    
    // Send admin notification for new subscribers
    if (isNew) {
      const adminSubHtml = getEmailHeader() + `
        <h2 style="color: #c5a059; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 20px; margin: 0 0 15px 0;">New Subscriber</h2>
        <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600; width: 100px;">Email</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${email}</td></tr>
          <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Name</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${name || 'Not provided'}</td></tr>
          <tr><td style="padding: 8px 0; font-weight: 600;">Source</td><td style="padding: 8px 0;">${source || 'footer'}</td></tr>
        </table>
        <p><a href="https://glrarealty.com/admin.html" style="background-color: #c5a059; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">View All Subscribers</a></p>
      ` + getEmailFooter();
      await sendEmail('glrarealty@gmail.com', 'New Subscriber - GLRA Realty', adminSubHtml);
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
    
    // Send confirmation email to user
    const userWishlistHtml = getEmailHeader() + `
      <h2 style="color: #1a1a2e; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 22px; margin: 0 0 8px 0;">Property Saved to Wishlist</h2>
      <p style="color: #555555; line-height: 1.6; font-size: 14px;">Dear Valued Client,</p>
      <p style="color: #555555; line-height: 1.6; font-size: 14px;">You have successfully saved the following property to your wishlist:</p>
      
      <div style="background-color: #f9f9f5; border-left: 3px solid #c5a059; padding: 18px 20px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0 0 8px 0; font-weight: 600; color: #1a1a2e;">${propertyTitle}</p>
        <p style="margin: 0 0 5px 0; color: #555555; font-size: 13px;">📍 ${propertyLocation}</p>
        <p style="margin: 0; color: #c5a059; font-weight: 600; font-size: 16px;">₱${propertyPrice.toLocaleString()}</p>
      </div>
      
      <p style="color: #555555; line-height: 1.6; font-size: 14px;">You can view all your saved properties in the <a href="https://glrarealty.com/properties.html" style="color: #c5a059;">properties page</a>.</p>
      <p style="color: #555555; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
    ` + getEmailFooter();
    await sendEmail(email, `Saved to Wishlist: ${propertyTitle}`, userWishlistHtml);
    
    // Send admin notification
    const adminWishlistHtml = getEmailHeader() + `
      <h2 style="color: #c5a059; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 20px; margin: 0 0 15px 0;">New Wishlist Item</h2>
      <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
        <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600; width: 100px;">Customer</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${email}</td></tr>
        <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Property</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${propertyTitle}</td></tr>
        <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Location</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${propertyLocation}</td></tr>
        <tr><td style="padding: 8px 0; font-weight: 600;">Price</td><td style="padding: 8px 0;">₱${propertyPrice.toLocaleString()}</td></tr>
      </table>
      <p><a href="https://glrarealty.com/admin.html" style="background-color: #c5a059; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">View in Admin Dashboard</a></p>
    ` + getEmailFooter();
    await sendEmail('glrarealty@gmail.com', `Wishlist Alert: ${propertyTitle}`, adminWishlistHtml);
    
    console.log(`📋 ${email} saved ${propertyTitle} to wishlist`);
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
    
    // Send confirmation email to user
    const userAlertHtml = getEmailHeader() + `
      <h2 style="color: #1a1a2e; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 22px; margin: 0 0 8px 0;">Price Alert Confirmation</h2>
      <p style="color: #555555; line-height: 1.6; font-size: 14px;">Dear Valued Client,</p>
      <p style="color: #555555; line-height: 1.6; font-size: 14px;">You have successfully set a price alert for the following property:</p>
      
      <div style="background-color: #f9f9f5; border-left: 3px solid #c5a059; padding: 18px 20px; margin: 25px 0; border-radius: 4px;">
        <p style="margin: 0 0 8px 0; font-weight: 600; color: #1a1a2e;">${propertyTitle}</p>
        <p style="margin: 0; color: #c5a059; font-weight: 600; font-size: 16px;">Current Price: ₱${propertyPrice.toLocaleString()}</p>
      </div>
      
      <p style="color: #555555; line-height: 1.6; font-size: 14px;">You will receive an email notification immediately if the price drops.</p>
      <p style="color: #555555; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
    ` + getEmailFooter();
    await sendEmail(email, `Price Alert Set: ${propertyTitle}`, userAlertHtml);
    
    // Send admin notification
    const adminAlertHtml = getEmailHeader() + `
      <h2 style="color: #c5a059; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 20px; margin: 0 0 15px 0;">New Price Alert Request</h2>
      <table style="width: 100%; border-collapse: collapse; margin: 15px 0;">
        <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600; width: 100px;">Customer</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${email}</td></tr>
        <tr><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0; font-weight: 600;">Property</td><td style="padding: 8px 0; border-bottom: 1px solid #e8e8e0;">${propertyTitle}</td></tr>
        <tr><td style="padding: 8px 0; font-weight: 600;">Current Price</td><td style="padding: 8px 0;">₱${propertyPrice.toLocaleString()}</td></tr>
      </table>
      <p><a href="https://glrarealty.com/admin.html" style="background-color: #c5a059; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">View in Admin Dashboard</a></p>
    ` + getEmailFooter();
    await sendEmail('glrarealty@gmail.com', `Price Alert Request: ${propertyTitle}`, adminAlertHtml);
    
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
          const priceDropHtml = getEmailHeader() + `
            <h2 style="color: #1a1a2e; font-family: Georgia, 'Times New Roman', Times, serif; font-size: 22px; margin: 0 0 8px 0;">Price Drop Alert</h2>
            <p style="color: #555555; line-height: 1.6; font-size: 14px;">Dear Valued Client,</p>
            <p style="color: #555555; line-height: 1.6; font-size: 14px;">Good news! The price has dropped for a property you are watching:</p>
            
            <div style="background-color: #f9f9f5; border-left: 3px solid #c5a059; padding: 18px 20px; margin: 25px 0; border-radius: 4px;">
              <p style="margin: 0 0 8px 0; font-weight: 600; color: #1a1a2e;">${oldProperty.title}</p>
              <p style="margin: 0 0 5px 0; color: #555555; font-size: 13px;">📍 ${oldProperty.location}</p>
              <p style="margin: 0 0 5px 0; color: #888888; font-size: 14px; text-decoration: line-through;">Previous Price: ₱${oldProperty.price.toLocaleString()}</p>
              <p style="margin: 0; color: #10b981; font-weight: 700; font-size: 18px;">New Price: ₱${updatedData.price.toLocaleString()}</p>
              <p style="margin: 10px 0 0 0; color: #555555; font-size: 13px;">Savings: ₱${(oldProperty.price - updatedData.price).toLocaleString()}</p>
            </div>
            
            <p><a href="https://glrarealty.com/properties.html?property=${req.params.id}" style="background-color: #c5a059; color: #ffffff; padding: 10px 20px; text-decoration: none; border-radius: 4px; display: inline-block;">View Property Details</a></p>
            <p style="color: #555555; line-height: 1.6; font-size: 14px; margin-top: 25px;">Sincerely,<br><strong>GLRA Realty Team</strong></p>
          ` + getEmailFooter();
          await sendEmail(alert.email, `Price Drop Alert: ${oldProperty.title}`, priceDropHtml);
          
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
  ║   Brevo Email: Connected ✅ (300 free emails/day)             ║
  ║   Features: Properties | Inquiries | Wishlist | Alerts       ║
  ╚═══════════════════════════════════════════════════════════════╝
  `);
});
