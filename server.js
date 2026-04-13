// ============ DARK MODE ============
function toggleDarkMode() {
  document.body.classList.toggle('dark-mode');
  const isDarkMode = document.body.classList.contains('dark-mode');
  localStorage.setItem('darkMode', isDarkMode);
  
  // Update both buttons
  const floatingBtn = document.getElementById('floatingDarkModeToggle');
  const headerBtn = document.getElementById('headerDarkModeToggle');
  
  if (isDarkMode) {
    if (floatingBtn) {
      floatingBtn.innerHTML = '<i class="fas fa-sun"></i>';
      floatingBtn.style.background = '#2a2a3a';
      floatingBtn.style.color = '#f97316';
    }
    if (headerBtn) {
      headerBtn.innerHTML = '<i class="fas fa-sun"></i> Light Mode';
      headerBtn.style.background = '#2a2a3a';
      headerBtn.style.color = '#f97316';
    }
  } else {
    if (floatingBtn) {
      floatingBtn.innerHTML = '<i class="fas fa-moon"></i>';
      floatingBtn.style.background = '#1e1e2e';
      floatingBtn.style.color = 'white';
    }
    if (headerBtn) {
      headerBtn.innerHTML = '<i class="fas fa-moon"></i> Dark Mode';
      headerBtn.style.background = '#1e1e2e';
      headerBtn.style.color = 'white';
    }
  }
}

if (localStorage.getItem('darkMode') === 'true') {
  document.body.classList.add('dark-mode');
  const headerBtn = document.getElementById('headerDarkModeToggle');
  if (headerBtn) {
    headerBtn.innerHTML = '<i class="fas fa-sun"></i> Light Mode';
    headerBtn.style.background = '#2a2a3a';
    headerBtn.style.color = '#f97316';
  }
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
    <div class="progress-header" onclick="toggleProgressBody('${id}')">
      <div class="progress-spinner"></div>
      <div class="progress-info">
        <div class="progress-filename">${escapeHtml(displayName)}</div>
        <div class="progress-status">Starting...</div>
      </div>
      <div class="progress-percent">0%</div>
      <div class="progress-close" onclick="event.stopPropagation(); removeProgressBar('${id}')">
        <i class="fas fa-times"></i>
      </div>
    </div>
    <div class="progress-bar-container">
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" style="width: 0%"></div>
      </div>
    </div>
  `;
  
  document.getElementById('progressStack').appendChild(progressItem);
  activeProgressBars.push(id);
  updateCollapseAllButton();
  return id;
}

function updateProgressBar(id, percent, message) {
  const item = document.getElementById(id);
  if (!item) return;
  
  const fill = item.querySelector('.progress-bar-fill');
  const text = item.querySelector('.progress-status');
  const percentEl = item.querySelector('.progress-percent');
  
  if (fill) fill.style.width = percent + '%';
  if (text) text.innerHTML = message;
  if (percentEl) percentEl.innerHTML = percent + '%';
  
  if (percent >= 100) {
    setTimeout(() => removeProgressBar(id), 2000);
  }
}

function removeProgressBar(id) {
  const item = document.getElementById(id);
  if (item) {
    item.style.animation = 'slideInRight 0.3s reverse';
    setTimeout(() => {
      if (item && item.parentNode) {
        item.remove();
        activeProgressBars = activeProgressBars.filter(barId => barId !== id);
        updateCollapseAllButton();
      }
    }, 300);
  }
}

function toggleProgressBody(id) {
  const item = document.getElementById(id);
  if (!item) return;
  const barContainer = item.querySelector('.progress-bar-container');
  if (barContainer.style.display === 'none') {
    barContainer.style.display = 'block';
  } else {
    barContainer.style.display = 'none';
  }
}

function toggleAllProgressBars() {
  const allHidden = document.querySelectorAll('.progress-bar-container[style*="display: none"]').length === activeProgressBars.length;
  activeProgressBars.forEach(id => {
    const item = document.getElementById(id);
    if (!item) return;
    const barContainer = item.querySelector('.progress-bar-container');
    if (allHidden) {
      barContainer.style.display = 'block';
    } else {
      barContainer.style.display = 'none';
    }
  });
  const btn = document.getElementById('collapseAllBtn');
  if (btn) {
    if (allHidden) {
      btn.innerHTML = '<i class="fas fa-compress-alt"></i> Collapse All';
    } else {
      btn.innerHTML = '<i class="fas fa-expand-alt"></i> Expand All';
    }
  }
}

function updateCollapseAllButton() {
  let stack = document.getElementById('progressStack');
  let existingBtn = document.getElementById('collapseAllBtn');
  if (activeProgressBars.length > 1) {
    if (!existingBtn) {
      const btn = document.createElement('div');
      btn.id = 'collapseAllBtn';
      btn.className = 'progress-stack-collapse-btn';
      btn.innerHTML = '<i class="fas fa-compress-alt"></i> Collapse All';
      btn.onclick = toggleAllProgressBars;
      stack.insertBefore(btn, stack.firstChild);
    }
  } else {
    if (existingBtn) existingBtn.remove();
  }
}

function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.style.background = isError ? 'var(--danger)' : 'var(--success)';
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

// ============ IMAGE UPLOAD FUNCTIONS ============
async function uploadImage(file, type = 'hero', progressId = null) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append('image', file);
    const xhr = new XMLHttpRequest();
    const endpoint = type === 'hero' ? '/api/admin/hero-images/upload' : '/api/admin/upload-property-image';
    xhr.open('POST', endpoint, true);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && progressId) {
        const percent = Math.round((e.loaded / e.total) * 100);
        updateProgressBar(progressId, percent, `Uploading... ${percent}%`);
      }
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        const response = JSON.parse(xhr.responseText);
        if (progressId) updateProgressBar(progressId, 100, 'Complete!');
        resolve(response);
      } else {
        if (progressId) updateProgressBar(progressId, 100, 'Failed!');
        reject(new Error('Upload failed'));
      }
    };
    xhr.onerror = () => {
      if (progressId) updateProgressBar(progressId, 100, 'Network Error!');
      reject(new Error('Network error'));
    };
    xhr.send(formData);
  });
}

// Hero Image Upload
document.addEventListener('DOMContentLoaded', function() {
  const heroInput = document.getElementById('heroImageInput');
  const heroArea = document.getElementById('heroUploadArea');
  if (heroArea) heroArea.addEventListener('click', () => heroInput.click());
  if (heroInput) {
    heroInput.addEventListener('change', async function(e) {
      const file = e.target.files[0];
      if (!file) return;
      const progressId = addProgressBar(file.name);
      try {
        await uploadImage(file, 'hero', progressId);
        showToast('✅ Hero image uploaded!');
        loadHeroImages();
      } catch (error) {
        showToast('❌ Upload failed: ' + error.message, true);
      }
      heroInput.value = '';
    });
  }
});

// ============ PROPERTY IMAGE UPLOAD ============
let currentMainImageUrl = '';
let currentGalleryUrls = [];
const MAX_GALLERY_IMAGES = 25;

// Main Image Upload
document.getElementById('uploadMainImageBtn')?.addEventListener('click', () => document.getElementById('mainImageFile').click());
document.getElementById('mainImageFile')?.addEventListener('change', async function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const btn = document.getElementById('uploadMainImageBtn');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="loading-spinner"></span> Uploading...';
  btn.disabled = true;
  const progressId = addProgressBar(file.name);
  try {
    const result = await uploadImage(file, 'property', progressId);
    currentMainImageUrl = result.url;
    document.getElementById('mainImageUrl').value = result.url;
    const preview = document.getElementById('mainImagePreview');
    preview.style.display = 'block';
    preview.innerHTML = `<img src="${result.url}" alt="Preview" style="width: 100px; height: 100px; object-fit: cover;"><br><small>✅ Uploaded (${(result.size/1024).toFixed(1)}KB)</small>`;
    showToast('✅ Main image uploaded!');
  } catch (error) {
    showToast('❌ Upload failed: ' + error.message, true);
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
    this.value = '';
  }
});

// Gallery Images Upload
document.getElementById('uploadGalleryBtn')?.addEventListener('click', () => document.getElementById('galleryFiles').click());

function updateGalleryDisplay() {
  const preview = document.getElementById('galleryPreview');
  preview.innerHTML = currentGalleryUrls.map((url, idx) => `
    <div class="gallery-preview-item">
      <img src="${url}" alt="Gallery ${idx+1}" style="width: 80px; height: 80px; object-fit: cover;">
      <div class="remove-img" onclick="removeGalleryImage(${idx})"><i class="fas fa-times"></i></div>
    </div>
  `).join('');
  document.getElementById('galleryCountDisplay').innerHTML = `${currentGalleryUrls.length} / ${MAX_GALLERY_IMAGES} images uploaded`;
  document.getElementById('galleryUrls').value = currentGalleryUrls.join(',');
}

function removeGalleryImage(index) {
  currentGalleryUrls.splice(index, 1);
  updateGalleryDisplay();
  showToast(`Gallery image removed. (${currentGalleryUrls.length}/${MAX_GALLERY_IMAGES})`);
}

document.getElementById('galleryFiles')?.addEventListener('change', async function(e) {
  let files = Array.from(e.target.files);
  
  if (currentGalleryUrls.length + files.length > MAX_GALLERY_IMAGES) {
    showToast(`You can only upload up to ${MAX_GALLERY_IMAGES} gallery images. You have ${currentGalleryUrls.length} already.`, true);
    this.value = '';
    return;
  }
  
  const btn = document.getElementById('uploadGalleryBtn');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="loading-spinner"></span> Uploading...';
  btn.disabled = true;
  
  let uploaded = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const progressId = addProgressBar(file.name, files.length, i + 1);
    try {
      const result = await uploadImage(file, 'property', progressId);
      currentGalleryUrls.push(result.url);
      uploaded++;
      updateGalleryDisplay();
    } catch (error) {
      showToast(`Failed: ${file.name}`, true);
    }
  }
  
  updateGalleryDisplay();
  showToast(`✅ ${uploaded} of ${files.length} gallery images uploaded! (${currentGalleryUrls.length}/${MAX_GALLERY_IMAGES})`);
  btn.innerHTML = originalText;
  btn.disabled = false;
  this.value = '';
});

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
      <div class="stat-card"><h3>Available (Visible)</h3><div class="number">${stats.availableProperties || 0}</div></div>
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
    showAllProperties();
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

function showAllProperties() { displayProperties(allProperties); }

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
            <span class="property-detail"><i class="fas fa-map-marker-alt"></i> ${escapeHtml(p.location)}</span>
            <span class="property-detail"><i class="fas fa-tag"></i> ${priceDisplay}</span>
            <span class="property-detail"><i class="fas fa-bed"></i> ${p.bedrooms} BR</span>
            <span class="property-detail"><i class="fas fa-bath"></i> ${p.bathrooms} TB</span>
            <span class="property-detail"><i class="fas fa-ruler-combined"></i> ${p.sqm} SQM</span>
            ${p.listingType ? `<span class="property-detail"><i class="fas fa-file-signature"></i> ${p.listingType}</span>` : ''}
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
  showAllProperties();
}

function switchTab(tabName) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  event.target.classList.add('active');
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`${tabName}Tab`).classList.add('active');
}

// Add Property Submit - FIXED with better error handling
document.getElementById('propertyForm')?.addEventListener('submit', async function(e) {
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
    
    let responseText = await res.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch(e) {
      responseData = { error: responseText.substring(0, 200) };
    }
    
    if (res.ok) {
      updateProgressBar(progressId, 100, 'Complete!');
      showToast('✅ Property added successfully! 🎉');
      this.reset();
      currentMainImageUrl = '';
      currentGalleryUrls = [];
      document.getElementById('mainImagePreview').style.display = 'none';
      document.getElementById('galleryPreview').innerHTML = '';
      document.getElementById('galleryCountDisplay').innerHTML = '0 / 25 images uploaded';
      loadAllProperties();
      loadStats();
      switchTab('properties');
      document.querySelectorAll('.tab')[0].classList.add('active');
      document.querySelectorAll('.tab')[1].classList.remove('active');
    } else {
      updateProgressBar(progressId, 100, 'Failed!');
      console.error('Server error:', responseData);
      let errorMsg = responseData.error || responseData.message || 'Unknown error';
      if (errorMsg.includes('413') || errorMsg.includes('payload')) {
        errorMsg = 'Image payload too large. Try fewer or smaller images.';
      }
      showToast('❌ Error: ' + errorMsg, true);
    }
  } catch(e) { 
    updateProgressBar(progressId, 100, 'Failed!');
    console.error('Network error:', e);
    showToast('❌ Network error: ' + e.message, true);
  } finally { 
    submitBtn.innerHTML = '<i class="fas fa-save"></i> Add Property'; 
    submitBtn.disabled = false;
  }
});

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
          <h4><i class="fas fa-user"></i> ${escapeHtml(i.name)}</h4>
          <p><i class="fas fa-envelope"></i> ${escapeHtml(i.email)} | <i class="fas fa-phone"></i> ${escapeHtml(i.phone || 'No phone')}</p>
          <p><i class="fas fa-home"></i> ${escapeHtml(i.propertyTitle || 'General Inquiry')}</p>
          <p><i class="fas fa-comment"></i> ${escapeHtml((i.message || '').substring(0, 150))}</p>
          <p><i class="fas fa-calendar"></i> ${new Date(i.createdAt).toLocaleString()}</p>
        </div>
        <button class="danger" onclick="deleteInquiry('${i._id}')"><i class="fas fa-trash"></i> Delete</button>
      </div>
    `).join('');
  } catch(e) { console.error(e); }
}

async function deleteInquiry(id) {
  if (!confirm('Delete this inquiry?')) return;
  await fetch(`/api/admin/inquiries/${id}`, { method: 'DELETE' });
  showToast('Inquiry deleted');
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
  const container = document.getElementById('subscribersList');
  const searchTerm = document.getElementById('subscriberSearch')?.value.toLowerCase() || '';
  let filtered = subscribers;
  if (searchTerm) {
    filtered = subscribers.filter(s => s.email.toLowerCase().includes(searchTerm) || (s.name && s.name.toLowerCase().includes(searchTerm)));
  }
  if (!filtered.length) {
    container.innerHTML = '<tr><td colspan="5" class="empty-state">No subscribers found</td></tr>';
    return;
  }
  container.innerHTML = filtered.map(s => `
    <tr>
      <td style="padding: 12px;">${escapeHtml(s.email)}</td>
      <td style="padding: 12px;">${escapeHtml(s.name || '-')}</td>
      <td style="padding: 12px;"><span class="badge badge-info">${escapeHtml(s.source || 'footer')}</span></td>
      <td style="padding: 12px;">${new Date(s.subscribedAt).toLocaleDateString()}</td>
      <td style="padding: 12px;"><button class="danger" style="padding: 4px 12px; font-size: 11px;" onclick="deleteSubscriber('${s._id}')">Delete</button></td>
    </tr>
  `).join('');
}

function filterSubscribers() { renderSubscribers(); }

async function deleteSubscriber(id) {
  if (!confirm('Delete this subscriber?')) return;
  await fetch(`/api/admin/subscribers/${id}`, { method: 'DELETE' });
  showToast('Subscriber deleted');
  loadSubscribers();
  loadStats();
}

function exportSubscribersToCSV() {
  let csv = "Email,Name,Source,Subscribed Date\n";
  subscribers.forEach(s => {
    csv += `"${s.email}","${s.name || ''}","${s.source || 'footer'}","${new Date(s.subscribedAt).toLocaleDateString()}"\n`;
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
  if (!alerts.length) {
    container.innerHTML = '<tr><td colspan="5" class="empty-state">No price alert requests</td></tr>';
    return;
  }
  container.innerHTML = alerts.map(a => `
    <tr>
      <td style="padding: 12px;">${escapeHtml(a.email)}</td>
      <td style="padding: 12px;">${escapeHtml(a.propertyTitle)}</td>
      <td style="padding: 12px;">₱${(a.propertyPrice || 0).toLocaleString()}</td>
      <td style="padding: 12px;">${a.isNotified ? '<span class="badge badge-success">Yes</span>' : '<span class="badge badge-warning">Pending</span>'}</td>
      <td style="padding: 12px;">${new Date(a.createdAt).toLocaleDateString()}</td>
    </tr>
  `).join('');
}

// Edit Property
let editMainImageUrl = '';
let editNewGalleryUrls = [];
let editExistingGalleryUrls = [];

function displayCurrentGalleryImages() {
  const container = document.getElementById('editCurrentGallery');
  if (!editExistingGalleryUrls.length) {
    container.innerHTML = '<div style="width: 100%;"><strong>No gallery images</strong></div>';
  } else {
    container.innerHTML = `<div style="width: 100%; margin-bottom: 8px;"><strong>Current Gallery Images (${editExistingGalleryUrls.length}):</strong></div>` + 
      editExistingGalleryUrls.map((url, idx) => `
        <div style="position: relative; display: inline-block; margin: 5px;">
          <img src="${url}" alt="Gallery ${idx+1}" style="width: 80px; height: 80px; object-fit: cover; border-radius: 8px;">
          <div onclick="deleteCurrentGalleryImage(${idx})" style="position: absolute; top: -8px; right: -8px; background: var(--danger); color: white; border-radius: 50%; width: 22px; height: 22px; display: flex; align-items: center; justify-content: center; font-size: 10px; cursor: pointer;">
            <i class="fas fa-times"></i>
          </div>
        </div>
      `).join('');
  }
  const totalCount = editExistingGalleryUrls.length + editNewGalleryUrls.length;
  document.getElementById('editGalleryCountDisplay').innerHTML = `${totalCount} / 25 total`;
}

function deleteCurrentGalleryImage(index) {
  if (confirm('Remove this gallery image?')) {
    editExistingGalleryUrls.splice(index, 1);
    displayCurrentGalleryImages();
    showToast('Gallery image removed. Click Save to apply changes.');
  }
}

document.getElementById('editUploadMainImageBtn')?.addEventListener('click', () => document.getElementById('editMainImageFile').click());
document.getElementById('editMainImageFile')?.addEventListener('change', async function(e) {
  const file = e.target.files[0];
  if (!file) return;
  const btn = document.getElementById('editUploadMainImageBtn');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="loading-spinner"></span> Uploading...';
  btn.disabled = true;
  const progressId = addProgressBar(file.name);
  try {
    const result = await uploadImage(file, 'property', progressId);
    editMainImageUrl = result.url;
    document.getElementById('editMainImageUrl').value = result.url;
    const preview = document.getElementById('editMainImagePreview');
    preview.style.display = 'block';
    preview.innerHTML = `<img src="${result.url}" alt="Preview" style="width: 100px; height: 100px; object-fit: cover;"><br><small>✅ New image uploaded (${(result.size/1024).toFixed(1)}KB)</small>`;
    const currentDiv = document.getElementById('editCurrentMainImage');
    currentDiv.innerHTML = `
      <div style="background: var(--gray-light); padding: 10px; border-radius: 8px;">
        <strong>New Main Image (will replace on save):</strong><br>
        <img src="${result.url}" style="width: 100px; height: 100px; object-fit: cover; border-radius: 8px; margin-top: 5px;">
      </div>
    `;
    showToast('✅ New main image uploaded! Click Save to apply.');
  } catch (error) {
    showToast('❌ Upload failed: ' + error.message, true);
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
    this.value = '';
  }
});

document.getElementById('editUploadGalleryBtn')?.addEventListener('click', () => document.getElementById('editGalleryFiles').click());
document.getElementById('editGalleryFiles')?.addEventListener('change', async function(e) {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;
  
  const totalExisting = editExistingGalleryUrls.length + editNewGalleryUrls.length;
  if (totalExisting + files.length > MAX_GALLERY_IMAGES) {
    showToast(`You can only have up to ${MAX_GALLERY_IMAGES} gallery images total.`, true);
    this.value = '';
    return;
  }
  
  const btn = document.getElementById('editUploadGalleryBtn');
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span class="loading-spinner"></span> Uploading...';
  btn.disabled = true;
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const progressId = addProgressBar(file.name, files.length, i + 1);
    try {
      const result = await uploadImage(file, 'property', progressId);
      editNewGalleryUrls.push(result.url);
      const preview = document.getElementById('editGalleryPreview');
      if (editNewGalleryUrls.length > 0) {
        preview.innerHTML = editNewGalleryUrls.map((url, idx) => `
          <div class="gallery-preview-item">
            <img src="${url}" alt="New Gallery ${idx+1}" style="width: 80px; height: 80px; object-fit: cover;">
            <div class="remove-img" onclick="removeNewGalleryImage(${idx})"><i class="fas fa-times"></i></div>
          </div>
        `).join('');
      }
      const totalCount = editExistingGalleryUrls.length + editNewGalleryUrls.length;
      document.getElementById('editGalleryCountDisplay').innerHTML = `${totalCount} / 25 total`;
    } catch (error) {
      showToast(`Failed: ${file.name}`, true);
    }
  }
  showToast(`✅ ${files.length} new gallery images uploaded! Click Save to apply.`);
  btn.innerHTML = originalText;
  btn.disabled = false;
  this.value = '';
});

function removeNewGalleryImage(index) {
  editNewGalleryUrls.splice(index, 1);
  const preview = document.getElementById('editGalleryPreview');
  if (editNewGalleryUrls.length > 0) {
    preview.innerHTML = editNewGalleryUrls.map((url, idx) => `
      <div class="gallery-preview-item">
        <img src="${url}" alt="New Gallery ${idx+1}" style="width: 80px; height: 80px; object-fit: cover;">
        <div class="remove-img" onclick="removeNewGalleryImage(${idx})"><i class="fas fa-times"></i></div>
      </div>
    `).join('');
  } else {
    preview.innerHTML = '';
  }
  const totalCount = editExistingGalleryUrls.length + editNewGalleryUrls.length;
  document.getElementById('editGalleryCountDisplay').innerHTML = `${totalCount} / 25 total`;
}

async function editProperty(id) {
  const prop = allProperties.find(p => p._id === id);
  if (prop) {
    document.getElementById('editId').value = prop._id;
    document.getElementById('editTitle').value = prop.title || '';
    document.getElementById('editLocation').value = prop.location || '';
    document.getElementById('editPrice').value = prop.price || 0;
    document.getElementById('editMonthlyRental').value = prop.monthlyRental || 0;
    document.getElementById('editBedrooms').value = prop.bedrooms || 0;
    document.getElementById('editBathrooms').value = prop.bathrooms || 0;
    document.getElementById('editSqm').value = prop.sqm || 0;
    document.getElementById('editLandArea').value = prop.landArea || 0;
    document.getElementById('editDescription').value = prop.description || '';
    document.getElementById('editFeatured').value = prop.featured ? 'true' : 'false';
    document.getElementById('editStatus').value = prop.status || 'available';
    document.getElementById('editMapLocation').value = prop.mapLocation || '';
    document.getElementById('editListingType').value = prop.listingType || 'FOR SALE';
    document.getElementById('editPropertyType').value = prop.propertyType || 'Condominium';
    document.getElementById('editParking').value = prop.parking || 0;
    
    editMainImageUrl = '';
    editNewGalleryUrls = [];
    editExistingGalleryUrls = [...(prop.gallery || [])];
    
    const currentMainDiv = document.getElementById('editCurrentMainImage');
    if (prop.mainImage) {
      currentMainDiv.innerHTML = `
        <div style="background: var(--gray-light); padding: 10px; border-radius: 8px;">
          <strong>Current Main Image:</strong><br>
          <img src="${prop.mainImage}" style="width: 100px; height: 100px; object-fit: cover; border-radius: 8px; margin-top: 5px;">
        </div>
      `;
    } else {
      currentMainDiv.innerHTML = '<div style="background: var(--gray-light); padding: 10px; border-radius: 8px;"><strong>No main image set</strong></div>';
    }
    
    displayCurrentGalleryImages();
    document.getElementById('editMainImageUrl').value = prop.mainImage || '';
    document.getElementById('editGalleryUrls').value = (prop.gallery || []).join(',');
    document.getElementById('editMainImagePreview').style.display = 'none';
    document.getElementById('editGalleryPreview').innerHTML = '';
    document.getElementById('editModal').style.display = 'block';
  }
}

function closeEditModal() { document.getElementById('editModal').style.display = 'none'; }

document.getElementById('editForm')?.addEventListener('submit', async function(e) {
  e.preventDefault();
  const id = document.getElementById('editId').value;
  const allGalleryImages = [...editExistingGalleryUrls, ...editNewGalleryUrls];
  let mainImage = editMainImageUrl;
  if (!mainImage) {
    mainImage = document.getElementById('editMainImageUrl').value;
  }
  const property = {
    title: document.getElementById('editTitle').value, 
    location: document.getElementById('editLocation').value,
    price: parseFloat(document.getElementById('editPrice').value) || 0, 
    monthlyRental: parseFloat(document.getElementById('editMonthlyRental').value) || 0,
    bedrooms: parseInt(document.getElementById('editBedrooms').value) || 0, 
    bathrooms: parseInt(document.getElementById('editBathrooms').value) || 0,
    sqm: parseFloat(document.getElementById('editSqm').value) || 0, 
    landArea: parseFloat(document.getElementById('editLandArea').value) || 0,
    description: document.getElementById('editDescription').value, 
    featured: document.getElementById('editFeatured').value === 'true',
    status: document.getElementById('editStatus').value, 
    mainImage: mainImage, 
    gallery: allGalleryImages,
    mapLocation: document.getElementById('editMapLocation').value, 
    listingType: document.getElementById('editListingType').value,
    propertyType: document.getElementById('editPropertyType').value, 
    parking: parseInt(document.getElementById('editParking').value) || 0
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
      showToast('✅ Property saved successfully! Images updated.');
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

// Hero Images
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
      status: ['available','leased','reserved','sold','do not publish'].includes(String(row['Status']||'').toLowerCase()) ? String(row['Status']).toLowerCase() : 'available',
      mapLocation: row['MapLocation'] || '',
      mainImage: 'https://images.unsplash.com/photo-1600607687920-4e2a09cf159d', gallery: []
    })).filter(p => p.title);
    const previewDiv = document.getElementById('importPreview');
    previewDiv.innerHTML = `<p><strong>✅ ${excelData.length} properties found</strong></p>`;
    previewDiv.innerHTML += excelData.slice(0, 5).map(p => `<div style="padding: 8px; border-bottom: 1px solid #e5e7eb;">📌 ${p.title} - ${p.listingType}</div>`).join('');
    if (excelData.length > 5) previewDiv.innerHTML += `<div style="padding: 8px; color: var(--gray);">... and ${excelData.length - 5} more</div>`;
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
      if (res.ok) {
        success++;
        updateProgressBar(progressId, 100, 'Complete!');
      } else {
        updateProgressBar(progressId, 100, 'Failed!');
      }
    } catch(e) {
      updateProgressBar(progressId, 100, 'Failed!');
    }
  }
  showToast(`Imported ${success} of ${excelData.length} properties`);
  btn.disabled = false;
  btn.innerHTML = 'Import All';
  loadAllProperties();
  loadStats();
  excelData = [];
}
