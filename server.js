// ============ DARK MODE ============
function toggleDarkMode() {
  document.body.classList.toggle('dark-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem('darkMode', isDark);
  const btn = document.getElementById('headerDarkModeToggle');
  if (btn) btn.innerHTML = isDark ? '<i class="fas fa-sun"></i> Light Mode' : '<i class="fas fa-moon"></i> Dark Mode';
}
if (localStorage.getItem('darkMode') === 'true') toggleDarkMode();

// ============ TOAST ============
function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.background = isError ? '#dc3545' : '#28a745';
  toast.innerHTML = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}

// ============ PROGRESS BARS ============
let activeProgressBars = [];
let progressCounter = 0;

function addProgressBar(filename, totalFiles = 1, currentFileIndex = 1) {
  const id = 'progress_' + Date.now() + '_' + (progressCounter++);
  const displayName = totalFiles > 1 ? `${filename} (${currentFileIndex}/${totalFiles})` : filename;
  
  const progressItem = document.createElement('div');
  progressItem.className = 'progress-item';
  progressItem.id = id;
  progressItem.innerHTML = `
    <div class="progress-header">
      <div class="progress-spinner"></div>
      <div class="progress-info">
        <div class="progress-filename">${escapeHtml(displayName)}</div>
        <div class="progress-status">Processing...</div>
      </div>
      <div class="progress-percent">0%</div>
    </div>
    <div class="progress-bar-container">
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width: 0%"></div>
      </div>
    </div>
  `;
  
  document.getElementById('progressStack').appendChild(progressItem);
  activeProgressBars.push(id);
  return id;
}

function updateProgressBar(id, percent, message) {
  const item = document.getElementById(id);
  if (!item) return;
  const fill = item.querySelector('.progress-bar-fill');
  const status = item.querySelector('.progress-status');
  const percentEl = item.querySelector('.progress-percent');
  if (fill) fill.style.width = percent + '%';
  if (status) status.innerHTML = message;
  if (percentEl) percentEl.innerHTML = percent + '%';
  if (percent >= 100) setTimeout(() => item.remove(), 2000);
}

// ============ IMAGE LINK HANDLING ============
let currentMainImageUrl = '';
let currentGalleryUrls = [];
const MAX_GALLERY_IMAGES = 25;

// Preview main image from link
const mainImageLink = document.getElementById('mainImageLink');
if (mainImageLink) {
  mainImageLink.addEventListener('input', function(e) {
    const url = e.target.value.trim();
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      currentMainImageUrl = url;
      const preview = document.getElementById('mainImagePreview');
      preview.style.display = 'block';
      preview.innerHTML = `<img src="${url}" alt="Preview" style="width: 100px; height: 100px; object-fit: cover; border-radius: 8px;" onerror="this.src='https://via.placeholder.com/100?text=Invalid+URL'"><br><small>✅ Image loaded from URL</small>`;
    } else if (!url) {
      currentMainImageUrl = '';
      document.getElementById('mainImagePreview').style.display = 'none';
    }
  });
}

// Handle gallery links from textarea
const galleryLinks = document.getElementById('galleryLinks');
if (galleryLinks) {
  galleryLinks.addEventListener('input', function(e) {
    const links = e.target.value.split('\n').filter(link => link.trim() && (link.trim().startsWith('http://') || link.trim().startsWith('https://')));
    
    if (links.length > MAX_GALLERY_IMAGES) {
      showToast(`Maximum ${MAX_GALLERY_IMAGES} images allowed`, true);
      return;
    }
    
    currentGalleryUrls = links.map(l => l.trim());
    updateGalleryDisplay();
  });
}

function updateGalleryDisplay() {
  const preview = document.getElementById('galleryPreview');
  if (currentGalleryUrls.length === 0) {
    preview.innerHTML = '';
  } else {
    preview.innerHTML = currentGalleryUrls.map((url, idx) => `
      <div class="gallery-preview-item">
        <img src="${url}" alt="Gallery ${idx+1}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px;" onerror="this.src='https://via.placeholder.com/80?text=Error'">
        <div class="remove-img" onclick="removeGalleryImage(${idx})"><i class="fas fa-times"></i></div>
      </div>
    `).join('');
  }
  document.getElementById('galleryCountDisplay').innerHTML = `${currentGalleryUrls.length} / ${MAX_GALLERY_IMAGES} images added`;
}

function removeGalleryImage(index) {
  currentGalleryUrls.splice(index, 1);
  const textarea = document.getElementById('galleryLinks');
  textarea.value = currentGalleryUrls.join('\n');
  updateGalleryDisplay();
  showToast(`Image removed. (${currentGalleryUrls.length}/${MAX_GALLERY_IMAGES})`);
}

// ============ BULK ZIP UPLOAD TO IMGUR ============
// Imgur API client ID (free, for anonymous uploads)
// Get your own at https://api.imgur.com/oauth2/addclient
const IMGUR_CLIENT_ID = 'YOUR_CLIENT_ID_HERE'; // Replace with your Imgur Client ID

async function uploadToImgur(file, progressId) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('image', file);
    
    const xhr = new XMLHttpRequest();
    xhr.open('POST', 'https://api.imgur.com/3/image', true);
    xhr.setRequestHeader('Authorization', `Client-ID ${IMGUR_CLIENT_ID}`);
    
    xhr.upload.onprogress = (e) => {
      if (progressId && e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        updateProgressBar(progressId, percent, `Uploading to Imgur... ${percent}%`);
      }
    };
    
    xhr.onload = () => {
      if (xhr.status === 200) {
        const response = JSON.parse(xhr.responseText);
        resolve(response.data.link);
      } else {
        reject(new Error('Imgur upload failed'));
      }
    };
    
    xhr.onerror = () => reject(new Error('Network error'));
    xhr.send(formData);
  });
}

async function uploadZipToImgur() {
  const zipFile = document.getElementById('zipFileInput').files[0];
  if (!zipFile) {
    showToast('Please select a ZIP file first', true);
    return;
  }
  
  if (!IMGUR_CLIENT_ID || IMGUR_CLIENT_ID === 'YOUR_CLIENT_ID_HERE') {
    showToast('Please set your Imgur Client ID first. Get one free at https://api.imgur.com/oauth2/addclient', true);
    return;
  }
  
  showToast('Extracting ZIP file...');
  
  try {
    const zip = await JSZip.loadAsync(zipFile);
    const imageFiles = [];
    
    // Extract all image files from ZIP
    for (const [filename, file] of Object.entries(zip.files)) {
      if (file.dir) continue;
      const ext = filename.split('.').pop().toLowerCase();
      if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
        const blob = await file.async('blob');
        const imageFile = new File([blob], filename, { type: `image/${ext}` });
        imageFiles.push(imageFile);
      }
    }
    
    if (imageFiles.length === 0) {
      showToast('No images found in ZIP file', true);
      return;
    }
    
    if (currentGalleryUrls.length + imageFiles.length > MAX_GALLERY_IMAGES) {
      showToast(`You have ${currentGalleryUrls.length} images already. ZIP has ${imageFiles.length}. Max ${MAX_GALLERY_IMAGES}.`, true);
      return;
    }
    
    showToast(`Uploading ${imageFiles.length} images to Imgur...`);
    
    const newUrls = [];
    for (let i = 0; i < imageFiles.length; i++) {
      const file = imageFiles[i];
      const progressId = addProgressBar(file.name, imageFiles.length, i + 1);
      try {
        const url = await uploadToImgur(file, progressId);
        newUrls.push(url);
        updateProgressBar(progressId, 100, 'Complete!');
      } catch (error) {
        updateProgressBar(progressId, 100, 'Failed!');
        showToast(`Failed to upload ${file.name}`, true);
      }
    }
    
    // Add all new URLs to gallery
    currentGalleryUrls.push(...newUrls);
    const textarea = document.getElementById('galleryLinks');
    textarea.value = currentGalleryUrls.join('\n');
    updateGalleryDisplay();
    
    showToast(`✅ Successfully uploaded ${newUrls.length} images from ZIP!`);
    document.getElementById('zipFileInput').value = '';
    
  } catch (error) {
    console.error(error);
    showToast('Error processing ZIP file: ' + error.message, true);
  }
}

// Make function available globally
window.uploadZipToImgur = uploadZipToImgur;

// ============ LOGIN & DASHBOARD ============
async function login() {
  const email = document.getElementById('adminEmail').value;
  const password = document.getElementById('adminPassword').value;
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (res.ok) {
      document.getElementById('loginContainer').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      loadStats();
      loadAllProperties();
      loadInquiries();
      loadHeroImages();
      loadSubscribers();
      loadAlerts();
      showToast('Welcome to Admin Dashboard!');
    } else {
      showToast('Wrong credentials', true);
    }
  } catch(e) {
    showToast('Login failed', true);
  }
}

function logout() {
  document.getElementById('loginContainer').style.display = 'flex';
  document.getElementById('dashboard').style.display = 'none';
}

async function loadStats() {
  try {
    const res = await fetch('/api/admin/stats');
    const stats = await res.json();
    document.getElementById('stats').innerHTML = `
      <div class="stat-card"><h3>Total Properties</h3><div class="number">${stats.totalProperties || 0}</div></div>
      <div class="stat-card"><h3>Available</h3><div class="number">${stats.availableProperties || 0}</div></div>
      <div class="stat-card"><h3>Inquiries</h3><div class="number">${stats.totalInquiries || 0}</div></div>
      <div class="stat-card"><h3>Subscribers</h3><div class="number">${stats.subscribers || 0}</div></div>
      <div class="stat-card"><h3>Active Alerts</h3><div class="number">${stats.activeAlerts || 0}</div></div>
    `;
  } catch(e) { console.error(e); }
}

let allProperties = [];
let selectedProperties = new Set();
let heroImages = [];
let draggedIndex = null;
let subscribers = [];
let alerts = [];

async function loadAllProperties() {
  try {
    const res = await fetch('/api/admin/all-properties');
    allProperties = await res.json();
    displayProperties(allProperties);
    updateStatusSummary();
  } catch(e) { console.error(e); }
}

function updateStatusSummary() {
  const available = allProperties.filter(p => p.status === 'available').length;
  const leased = allProperties.filter(p => p.status === 'leased').length;
  const reserved = allProperties.filter(p => p.status === 'reserved').length;
  const sold = allProperties.filter(p => p.status === 'sold').length;
  const dnp = allProperties.filter(p => p.status === 'do not publish').length;
  document.getElementById('statusSummary').innerHTML = `
    <span class="status-badge status-available">✅ Visible: ${available}</span>
    <span class="status-badge status-leased">📋 Leased: ${leased}</span>
    <span class="status-badge status-reserved">🔒 Reserved: ${reserved}</span>
    <span class="status-badge status-sold">💰 Sold: ${sold}</span>
    <span class="status-badge status-dnp">🚫 Do Not Publish: ${dnp}</span>
  `;
}

function displayProperties(properties) {
  const container = document.getElementById('propertyList');
  if (!properties.length) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-home"></i><p>No properties found</p></div>';
    return;
  }
  container.innerHTML = properties.map(p => {
    let statusClass = p.status === 'available' ? 'status-available' : 
                      p.status === 'leased' ? 'status-leased' :
                      p.status === 'reserved' ? 'status-reserved' :
                      p.status === 'sold' ? 'status-sold' : 'status-dnp';
    const priceDisplay = p.listingType === 'FOR LEASE' ? `₱${(p.monthlyRental || p.price || 0).toLocaleString()}/mo` : `₱${(p.price || 0).toLocaleString()}`;
    const isChecked = selectedProperties.has(p._id);
    return `
      <div class="property-item">
        <div class="property-checkbox">
          <input type="checkbox" class="property-checkbox-input" value="${p._id}" ${isChecked ? 'checked' : ''} onchange="togglePropertySelection('${p._id}', this)">
        </div>
        <div class="property-info">
          <div class="property-title">
            ${escapeHtml(p.title)}
            <span class="status-badge ${statusClass}" style="font-size: 10px; padding: 3px 10px;">${p.status}</span>
          </div>
          <div class="property-details">
            <span><i class="fas fa-map-marker-alt"></i> ${escapeHtml(p.location)}</span>
            <span><i class="fas fa-tag"></i> ${priceDisplay}</span>
            <span><i class="fas fa-bed"></i> ${p.bedrooms} BR</span>
            <span><i class="fas fa-bath"></i> ${p.bathrooms} TB</span>
            <span><i class="fas fa-ruler-combined"></i> ${p.sqm} SQM</span>
          </div>
        </div>
        <div class="property-actions">
          <button onclick="editProperty('${p._id}')"><i class="fas fa-edit"></i> Edit</button>
          <button class="danger" onclick="deleteProperty('${p._id}')"><i class="fas fa-trash"></i> Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function togglePropertySelection(id, checkbox) {
  if (checkbox.checked) selectedProperties.add(id);
  else selectedProperties.delete(id);
  document.getElementById('selectedCount').innerHTML = `${selectedProperties.size} selected`;
}

function toggleSelectAll() {
  const checkboxes = document.querySelectorAll('.property-checkbox-input');
  const isChecked = document.getElementById('selectAllCheckbox').checked;
  checkboxes.forEach(cb => { cb.checked = isChecked; if (isChecked) selectedProperties.add(cb.value); else selectedProperties.delete(cb.value); });
  document.getElementById('selectedCount').innerHTML = `${selectedProperties.size} selected`;
}

async function deleteSelected() {
  if (selectedProperties.size === 0) { showToast('No properties selected', true); return; }
  if (!confirm(`Delete ${selectedProperties.size} properties?`)) return;
  for (const id of selectedProperties) { await fetch(`/api/admin/properties/${id}`, { method: 'DELETE' }); }
  showToast(`Deleted ${selectedProperties.size} properties`);
  selectedProperties.clear();
  loadAllProperties();
  loadStats();
}

async function deleteAllProperties() {
  if (!confirm(`⚠️ Delete ALL ${allProperties.length} properties? This cannot be undone.`)) return;
  for (const prop of allProperties) { await fetch(`/api/admin/properties/${prop._id}`, { method: 'DELETE' }); }
  showToast(`Deleted all properties`);
  loadAllProperties();
  loadStats();
}

async function deleteProperty(id) {
  if (!confirm('Delete this property?')) return;
  await fetch(`/api/admin/properties/${id}`, { method: 'DELETE' });
  showToast('Property deleted');
  loadAllProperties();
  loadStats();
}

function searchProperties() {
  const term = document.getElementById('searchInput').value.toLowerCase();
  const status = document.getElementById('searchStatus').value;
  const type = document.getElementById('searchListingType').value;
  let filtered = [...allProperties];
  if (term) filtered = filtered.filter(p => (p.title || '').toLowerCase().includes(term) || (p.location || '').toLowerCase().includes(term));
  if (status) filtered = filtered.filter(p => p.status === status);
  if (type) filtered = filtered.filter(p => p.listingType === type);
  displayProperties(filtered);
  document.getElementById('searchResults').innerHTML = `Found ${filtered.length} properties`;
}

function clearSearch() {
  document.getElementById('searchInput').value = '';
  document.getElementById('searchStatus').value = '';
  document.getElementById('searchListingType').value = '';
  displayProperties(allProperties);
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`${tabName}Tab`).classList.add('active');
}

// Add Property Submit
const propertyForm = document.getElementById('propertyForm');
if (propertyForm) {
  propertyForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    const submitBtn = document.getElementById('submitPropertyBtn');
    submitBtn.innerHTML = '<span class="loading-spinner"></span> Adding...';
    submitBtn.disabled = true;
    const fd = new FormData(this);
    
    const prop = {
      title: fd.get('title'), 
      location: fd.get('location'), 
      price: parseFloat(fd.get('price')) || 0,
      monthlyRental: parseFloat(fd.get('monthlyRental')) || 0, 
      bedrooms: parseInt(fd.get('bedrooms')) || 0,
      bathrooms: parseInt(fd.get('bathrooms')) || 0, 
      sqm: parseFloat(fd.get('sqm')) || 0,
      landArea: parseFloat(fd.get('landArea')) || 0, 
      description: fd.get('description'),
      featured: fd.get('featured') === 'true', 
      status: fd.get('status'),
      mainImage: currentMainImageUrl,
      gallery: currentGalleryUrls,
      mapLocation: fd.get('mapLocation') || '', 
      listingType: fd.get('listingType'),
      propertyType: fd.get('propertyType'), 
      parking: parseInt(fd.get('parking')) || 0
    };
    
    const progressId = addProgressBar('Saving property...');
    updateProgressBar(progressId, 50, 'Saving property...');
    try {
      const res = await fetch('/api/admin/properties', { 
        method: 'POST', 
        headers: { 'Content-Type': 'application/json' }, 
        body: JSON.stringify(prop) 
      });
      
      if (res.ok) {
        updateProgressBar(progressId, 100, 'Complete!');
        showToast('✅ Property added successfully!');
        this.reset();
        currentMainImageUrl = '';
        currentGalleryUrls = [];
        document.getElementById('mainImagePreview').style.display = 'none';
        document.getElementById('galleryPreview').innerHTML = '';
        document.getElementById('galleryCountDisplay').innerHTML = '0 / 25 images added';
        if (document.getElementById('galleryLinks')) document.getElementById('galleryLinks').value = '';
        loadAllProperties();
        loadStats();
        switchTab('properties');
      } else {
        updateProgressBar(progressId, 100, 'Failed!');
        const error = await res.json();
        showToast('❌ Error: ' + (error.error || 'Unknown error'), true);
      }
    } catch(e) { 
      updateProgressBar(progressId, 100, 'Failed!');
      showToast('❌ Network error: ' + e.message, true);
    } finally { 
      submitBtn.innerHTML = '<i class="fas fa-save"></i> Add Property'; 
      submitBtn.disabled = false;
    }
  });
}

// Inquiries
async function loadInquiries() {
  try {
    const res = await fetch('/api/admin/inquiries');
    const inquiries = await res.json();
    const container = document.getElementById('inquiryList');
    if (!inquiries.length) { container.innerHTML = '<div class="empty-state"><i class="fas fa-envelope"></i><p>No inquiries yet</p></div>'; return; }
    container.innerHTML = inquiries.map(i => `
      <div class="inquiry-item">
        <div>
          <h4>${escapeHtml(i.name)}</h4>
          <p>${escapeHtml(i.email)} | ${escapeHtml(i.phone || 'No phone')}</p>
          <p><strong>${escapeHtml(i.propertyTitle || 'General Inquiry')}</strong></p>
          <p>${escapeHtml((i.message || '').substring(0, 150))}</p>
          <small>${new Date(i.createdAt).toLocaleString()}</small>
        </div>
        <button class="danger" onclick="deleteInquiry('${i._id}')">Delete</button>
      </div>
    `).join('');
  } catch(e) { console.error(e); }
}

async function deleteInquiry(id) {
  if (!confirm('Delete this inquiry?')) return;
  await fetch(`/api/admin/inquiries/${id}`, { method: 'DELETE' });
  loadInquiries();
  loadStats();
}

// Subscribers
async function loadSubscribers() {
  try {
    const res = await fetch('/api/admin/subscribers');
    subscribers = await res.json();
    renderSubscribers();
  } catch(e) { console.error(e); }
}

function renderSubscribers() {
  const searchTerm = document.getElementById('subscriberSearch')?.value.toLowerCase() || '';
  let filtered = subscribers;
  if (searchTerm) {
    filtered = subscribers.filter(s => s.email.toLowerCase().includes(searchTerm));
  }
  const container = document.getElementById('subscribersList');
  if (!filtered.length) { container.innerHTML = '<div class="empty-state">No subscribers found</div>'; return; }
  container.innerHTML = filtered.map(s => `
    <div class="property-item">
      <div><strong>${escapeHtml(s.email)}</strong><br><small>${new Date(s.subscribedAt).toLocaleDateString()}</small></div>
      <button class="danger" onclick="deleteSubscriber('${s._id}')">Delete</button>
    </div>
  `).join('');
}

function filterSubscribers() { renderSubscribers(); }

async function deleteSubscriber(id) {
  if (!confirm('Delete this subscriber?')) return;
  await fetch(`/api/admin/subscribers/${id}`, { method: 'DELETE' });
  loadSubscribers();
  loadStats();
}

function exportSubscribersToCSV() {
  let csv = "Email,Subscribed Date\n";
  subscribers.forEach(s => {
    csv += `"${s.email}","${new Date(s.subscribedAt).toLocaleDateString()}"\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `subscribers_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Subscribers exported!');
}

// Alerts
async function loadAlerts() {
  try {
    const res = await fetch('/api/admin/price-alerts');
    alerts = await res.json();
    renderAlerts();
  } catch(e) { console.error(e); }
}

function renderAlerts() {
  const container = document.getElementById('alertsList');
  if (!alerts.length) { container.innerHTML = '<div class="empty-state">No price alerts</div>'; return; }
  container.innerHTML = alerts.map(a => `
    <div class="property-item">
      <div>
        <strong>${escapeHtml(a.propertyTitle)}</strong><br>
        ${escapeHtml(a.email)}<br>
        ₱${(a.propertyPrice || 0).toLocaleString()}
      </div>
    </div>
  `).join('');
}

// Hero Images
async function compressImage(file, maxWidth = 800, quality = 0.7) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        if (width > maxWidth) {
          height = (height * maxWidth) / width;
          width = maxWidth;
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          resolve(new File([blob], file.name, { type: 'image/jpeg' }));
        }, 'image/jpeg', quality);
      };
    };
  });
}

async function uploadImage(file, type = 'hero') {
  const compressed = await compressImage(file, 800, 0.6);
  const formData = new FormData();
  formData.append('image', compressed);
  const endpoint = type === 'hero' ? '/api/admin/hero-images/upload' : '/api/admin/upload-property-image';
  const res = await fetch(endpoint, { method: 'POST', body: formData });
  return await res.json();
}

document.addEventListener('DOMContentLoaded', function() {
  const heroInput = document.getElementById('heroImageInput');
  const heroArea = document.getElementById('heroUploadArea');
  if (heroArea) heroArea.addEventListener('click', () => heroInput.click());
  if (heroInput) {
    heroInput.addEventListener('change', async function(e) {
      const file = e.target.files[0];
      if (!file) return;
      const progressId = addProgressBar(file.name);
      updateProgressBar(progressId, 30, 'Compressing...');
      try {
        const result = await uploadImage(file, 'hero');
        updateProgressBar(progressId, 100, 'Complete!');
        showToast('✅ Hero image uploaded!');
        loadHeroImages();
      } catch (error) {
        showToast('❌ Upload failed: ' + error.message, true);
      }
      heroInput.value = '';
    });
  }
});

async function loadHeroImages() {
  try {
    const res = await fetch('/api/admin/hero-images');
    heroImages = await res.json();
    displayHeroImages();
  } catch(e) { console.error(e); }
}

function displayHeroImages() {
  const grid = document.getElementById('heroImagesGrid');
  if (!heroImages.length) { grid.innerHTML = '<div class="empty-state"><i class="fas fa-images"></i><p>No hero images yet. Click above to upload.</p></div>'; return; }
  grid.innerHTML = heroImages.map((img, idx) => `
    <div class="image-card" draggable="true" data-index="${idx}" data-id="${img._id}">
      <div class="drag-handle" draggable="true"><i class="fas fa-grip-vertical"></i></div>
      <img src="${img.url}" alt="Hero ${idx+1}">
      <div class="image-card-info">
        <div class="image-card-title">Hero Image ${idx+1}</div>
        <div class="image-card-order">Order: ${img.order + 1}</div>
        <div class="image-card-actions">
          <button class="set-default-btn" onclick="setAsDefault('${img._id}')"><i class="fas fa-star"></i> First</button>
          <button class="danger" onclick="deleteHeroImage('${img._id}')"><i class="fas fa-trash"></i> Delete</button>
        </div>
      </div>
    </div>
  `).join('');
  addDragAndDropListeners();
}

function addDragAndDropListeners() {
  const cards = document.querySelectorAll('.image-card');
  cards.forEach(card => {
    card.addEventListener('dragstart', e => { draggedIndex = parseInt(e.target.closest('.image-card').dataset.index); });
    card.addEventListener('dragover', e => e.preventDefault());
    card.addEventListener('drop', async e => {
      e.preventDefault();
      const targetCard = e.target.closest('.image-card');
      if (!targetCard) return;
      const targetIndex = parseInt(targetCard.dataset.index);
      if (draggedIndex === targetIndex) return;
      const draggedItem = heroImages[draggedIndex];
      heroImages.splice(draggedIndex, 1);
      heroImages.splice(targetIndex, 0, draggedItem);
      heroImages.forEach((img, i) => img.order = i);
      await fetch('/api/admin/hero-images/reorder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ images: heroImages }) });
      loadHeroImages();
      showToast('Order saved!');
    });
  });
}

async function setAsDefault(id) {
  await fetch(`/api/admin/hero-images/${id}/default`, { method: 'PUT' });
  showToast('Set as first slide!');
  loadHeroImages();
}

async function deleteHeroImage(id) {
  if (!confirm('Delete this hero image?')) return;
  await fetch(`/api/admin/hero-images/${id}`, { method: 'DELETE' });
  showToast('Image deleted');
  loadHeroImages();
}

// Edit Property
async function editProperty(id) {
  const prop = allProperties.find(p => p._id === id);
  if (!prop) return;
  document.getElementById('editId').value = prop._id;
  document.getElementById('editTitle').value = prop.title || '';
  document.getElementById('editLocation').value = prop.location || '';
  document.getElementById('editPrice').value = prop.price || 0;
  document.getElementById('editMonthlyRental').value = prop.monthlyRental || 0;
  document.getElementById('editBedrooms').value = prop.bedrooms || 0;
  document.getElementById('editBathrooms').value = prop.bathrooms || 0;
  document.getElementById('editSqm').value = prop.sqm || 0;
  document.getElementById('editLandArea').value = prop.landArea || 0;
  document.getElementById('editParking').value = prop.parking || 0;
  document.getElementById('editDescription').value = prop.description || '';
  document.getElementById('editMapLocation').value = prop.mapLocation || '';
  document.getElementById('editListingType').value = prop.listingType || 'FOR SALE';
  document.getElementById('editPropertyType').value = prop.propertyType || 'Condominium';
  document.getElementById('editFeatured').value = prop.featured ? 'true' : 'false';
  document.getElementById('editStatus').value = prop.status || 'available';
  
  const editMainImageLink = document.getElementById('editMainImageLink');
  if (editMainImageLink) editMainImageLink.value = prop.mainImage || '';
  const editGalleryLinks = document.getElementById('editGalleryLinks');
  if (editGalleryLinks) editGalleryLinks.value = (prop.gallery || []).join('\n');
  
  const editMainImagePreview = document.getElementById('editMainImagePreview');
  if (editMainImagePreview) {
    if (prop.mainImage) {
      editMainImagePreview.innerHTML = `<img src="${prop.mainImage}" style="width: 100px; height: 100px; object-fit: cover; border-radius: 8px;" onerror="this.src='https://via.placeholder.com/100?text=Invalid'">`;
    } else {
      editMainImagePreview.innerHTML = '';
    }
  }
  
  const editGalleryPreview = document.getElementById('editGalleryPreview');
  const editGalleryCountDisplay = document.getElementById('editGalleryCountDisplay');
  if (editGalleryPreview && editGalleryCountDisplay) {
    if (prop.gallery && prop.gallery.length) {
      editGalleryPreview.innerHTML = prop.gallery.map((url, idx) => `
        <div class="gallery-preview-item">
          <img src="${url}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px;" onerror="this.src='https://via.placeholder.com/80?text=Error'">
          <div class="remove-img" onclick="removeEditGalleryImage(${idx})"><i class="fas fa-times"></i></div>
        </div>
      `).join('');
      editGalleryCountDisplay.innerHTML = `${prop.gallery.length} images`;
    } else {
      editGalleryPreview.innerHTML = '';
      editGalleryCountDisplay.innerHTML = '0 images';
    }
  }
  
  document.getElementById('editModal').style.display = 'block';
}

function closeEditModal() { document.getElementById('editModal').style.display = 'none'; }

function removeEditGalleryImage(index) {
  const textarea = document.getElementById('editGalleryLinks');
  const urls = textarea.value.split('\n').filter(u => u.trim());
  urls.splice(index, 1);
  textarea.value = urls.join('\n');
  const event = new Event('input');
  textarea.dispatchEvent(event);
}

const editGalleryLinks = document.getElementById('editGalleryLinks');
if (editGalleryLinks) {
  editGalleryLinks.addEventListener('input', function(e) {
    const urls = e.target.value.split('\n').filter(u => u.trim() && (u.trim().startsWith('http://') || u.trim().startsWith('https://')));
    const preview = document.getElementById('editGalleryPreview');
    const countDisplay = document.getElementById('editGalleryCountDisplay');
    if (urls.length === 0) {
      preview.innerHTML = '';
    } else {
      preview.innerHTML = urls.map((url, idx) => `
        <div class="gallery-preview-item">
          <img src="${url.trim()}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px;" onerror="this.src='https://via.placeholder.com/80?text=Error'">
          <div class="remove-img" onclick="removeEditGalleryImage(${idx})"><i class="fas fa-times"></i></div>
        </div>
      `).join('');
    }
    if (countDisplay) countDisplay.innerHTML = `${urls.length} images`;
  });
}

const editForm = document.getElementById('editForm');
if (editForm) {
  editForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    const id = document.getElementById('editId').value;
    
    const galleryUrls = document.getElementById('editGalleryLinks').value
      .split('\n')
      .filter(u => u.trim() && (u.trim().startsWith('http://') || u.trim().startsWith('https://')))
      .map(u => u.trim());
    
    const property = {
      title: document.getElementById('editTitle').value,
      location: document.getElementById('editLocation').value,
      price: parseFloat(document.getElementById('editPrice').value) || 0,
      monthlyRental: parseFloat(document.getElementById('editMonthlyRental').value) || 0,
      bedrooms: parseInt(document.getElementById('editBedrooms').value) || 0,
      bathrooms: parseInt(document.getElementById('editBathrooms').value) || 0,
      sqm: parseFloat(document.getElementById('editSqm').value) || 0,
      landArea: parseFloat(document.getElementById('editLandArea').value) || 0,
      parking: parseInt(document.getElementById('editParking').value) || 0,
      description: document.getElementById('editDescription').value,
      mapLocation: document.getElementById('editMapLocation').value,
      listingType: document.getElementById('editListingType').value,
      propertyType: document.getElementById('editPropertyType').value,
      featured: document.getElementById('editFeatured').value === 'true',
      status: document.getElementById('editStatus').value,
      mainImage: document.getElementById('editMainImageLink').value.trim(),
      gallery: galleryUrls
    };
    
    const saveBtn = document.getElementById('saveEditBtn');
    saveBtn.innerHTML = '<span class="loading-spinner"></span> Saving...';
    saveBtn.disabled = true;
    const progressId = addProgressBar('Saving property changes...');
    updateProgressBar(progressId, 50, 'Updating property...');
    try {
      const res = await fetch(`/api/admin/properties/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(property) });
      if (res.ok) {
        updateProgressBar(progressId, 100, 'Complete!');
        showToast('✅ Property saved successfully!');
        closeEditModal();
        loadAllProperties();
        loadStats();
      } else {
        updateProgressBar(progressId, 100, 'Failed!');
        showToast('❌ Error saving property', true);
      }
    } catch(e) {
      updateProgressBar(progressId, 100, 'Failed!');
      showToast('❌ Network error', true);
    } finally {
      saveBtn.innerHTML = 'Save Changes';
      saveBtn.disabled = false;
    }
  });
}

// Excel Import
let excelData = [];
async function previewExcel() {
  const file = document.getElementById('excelFile').files[0];
  if (!file) { showToast('Select a file first', true); return; }
  const reader = new FileReader();
  reader.onload = function(e) {
    const workbook = XLSX.read(e.target.result, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);
    excelData = rows.map(row => ({
      title: row['Property'] || row['Title'] || '', location: row['Location'] || '',
      price: parseFloat(row['Price']) || 0, monthlyRental: parseFloat(row['Monthly Rental']) || 0,
      bedrooms: parseInt(row['BR']) || 0, bathrooms: parseInt(row['TB']) || 0,
      sqm: parseFloat(row['Floor Area']) || 0, landArea: parseFloat(row['Land Area']) || 0,
      description: row['Caption'] || '', listingType: (row['Listing Type'] || 'FOR SALE').toUpperCase(),
      propertyType: row['Property Type'] || 'Condominium', parking: parseInt(row['P']) || 0,
      status: 'available', mapLocation: row['MapLocation'] || '',
      mainImage: row['Image URL'] || '', gallery: []
    })).filter(p => p.title);
    const previewDiv = document.getElementById('importPreview');
    previewDiv.innerHTML = `<p><strong>✅ ${excelData.length} properties found</strong></p>`;
    previewDiv.innerHTML += excelData.slice(0, 5).map(p => `<div>📌 ${p.title} - ${p.listingType}</div>`).join('');
    showToast(`Loaded ${excelData.length} properties`);
  };
  reader.readAsArrayBuffer(file);
}

async function startImport() {
  if (!excelData.length) { showToast('Preview first', true); return; }
  const btn = document.getElementById('importBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-spinner"></span> Importing...';
  let success = 0;
  for (let i = 0; i < excelData.length; i++) {
    const progressId = addProgressBar(excelData[i].title, excelData.length, i + 1);
    updateProgressBar(progressId, 50, 'Importing...');
    try {
      const res = await fetch('/api/admin/properties', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(excelData[i]) });
      if (res.ok) { success++; updateProgressBar(progressId, 100, 'Complete!'); }
      else updateProgressBar(progressId, 100, 'Failed!');
    } catch(e) { updateProgressBar(progressId, 100, 'Failed!'); }
  }
  showToast(`Imported ${success} of ${excelData.length} properties`);
  btn.disabled = false;
  btn.innerHTML = 'Import All';
  loadAllProperties();
  loadStats();
  excelData = [];
}
